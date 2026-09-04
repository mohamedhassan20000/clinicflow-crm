import "server-only";

import { logAgentTool } from "@/lib/ai/audit";
import {
  establishedDepartmentId,
  parseBookingStageState,
} from "@/lib/ai/booking-stage";
import {
  availableDoctorsInDepartment,
  loadDoctorDirectory,
  toDoctorOption,
} from "@/lib/ai/doctor-directory";
import {
  buildDeterministicRosterReply,
  buildGroundingCorrection,
  checkDoctorGrounding,
  type GroundingLedger,
} from "@/lib/ai/patient-grounding";
import { resolveNamedEntity } from "@/lib/ai/entity-resolution";
import {
  buildCommercialCorrection,
  buildDeterministicCommercialReply,
  checkCommercialGrounding,
} from "@/lib/ai/patient-commercial-grounding";
import { authorizePatientConversation } from "@/lib/ai/patient-authorization";
import { continuePatientBookingFromRoster } from "@/lib/ai/patient-roster-continuation";
import { isRosterBearingTurn } from "@/lib/ai/roster-intent";
import { resolvePatientAiContext } from "@/lib/supabase/admin";
import { parseCollectedData } from "@/lib/ai/collected-state";

/**
 * P11 — the server half of the presentation contract.
 *
 * `patient-grounding.ts` is pure: given a string and two lists it says whether
 * the string names anybody it should not. This module supplies the lists from
 * the database and owns the repair loop, so the decision and its evidence never
 * come from the same place as the text being judged.
 *
 * Everything here is best-effort in exactly one direction: a failure to load
 * the directory means the check does not run and the model's reply stands,
 * which is the pre-P11 behaviour. A failure can never *invent* a violation.
 */

export type GroundingEnforcement = {
  text: string;
  /** How the final text was arrived at. Enumerated labels only, for the audit. */
  outcome: "grounded" | "repaired" | "deterministic" | "unchecked";
  /** Whether doctor membership was the subject of this turn. */
  rosterBearing: boolean;
};

type RegenerateFn = (correction: string) => Promise<string>;

export async function enforcePatientReplyGrounding(input: {
  clinicId: string;
  conversationId: string;
  locale: "ar" | "en";
  text: string;
  ledger: GroundingLedger;
  regenerate: RegenerateFn;
  /**
   * P11B — the newest inbound patient message. It is one of the three signals
   * that make a turn roster-bearing, and the only one available *before* the
   * model writes anything: "مين الدكاترة المتاحين؟" settles the question of
   * whether this reply is making a membership claim regardless of how the reply
   * is phrased.
   */
  latestPatientText?: string | null;
}): Promise<GroundingEnforcement> {
  const text = (input.text ?? "").trim();
  const rosterBearing = isRosterBearingTurn({
    patientText: input.latestPatientText ?? null,
    replyText: text,
    sawDoctorTool: input.ledger.sawDoctors(),
  });
  if (!text) return { text, outcome: "unchecked", rosterBearing };

  // F-1 — services, prices and insurers, before doctors and before the
  // directory read, because this check needs nothing from the database: the
  // only thing that can back a price or an insurer is a receipt already in this
  // turn's ledger. A miss here used to have no gate whatsoever.
  const commercial = await enforceCommercialGrounding({
    clinicId: input.clinicId,
    locale: input.locale,
    text,
    ledger: input.ledger,
    regenerate: input.regenerate,
  });
  if (commercial) return { ...commercial, rosterBearing };

  let directory;
  try {
    directory = await loadDoctorDirectory(input.clinicId);
  } catch {
    return { text, outcome: "unchecked", rosterBearing };
  }
  const clinicDoctors = directory.doctors.map(toDoctorOption);
  const allowedNames = input.ledger.names("doctor");
  const allowedOtherNames = [
    ...input.ledger.names("department"),
    ...input.ledger.names("service"),
    ...directory.departments.map((item) => item.name),
  ];

  const first = checkDoctorGrounding({
    text,
    allowedNames,
    clinicDoctors,
    allowedOtherNames,
    rosterBearing,
  });
  if (first.grounded) return { text, outcome: "grounded", rosterBearing };

  // P11F — the ledger is a record of *this turn's* tool calls, and that is one
  // turn too narrow.
  //
  // A doctor already written into `ai_collected_data`, or recorded in
  // `offeredDoctorIds`, was put in front of this patient by the server on an
  // earlier turn and is server-verified state — not something the model
  // invented. Judging a reply only against this turn's tool results made every
  // forward-progress sentence about the doctor the patient had *already chosen*
  // a violation:
  //
  // ```
  //   stage intake_collecting, doctor_id committed on turn 40
  //   turn 42  patient: "الساعه ٩ الصبح"
  //            model:   "تمام، هحجزلك مع <the doctor already chosen> …"
  //            ledger:  empty (no tool ran)   → violation → roster fallback
  //            reply sent: "الدكاترة المتاحين في <department>: …"
  // ```
  //
  // That is the P11F backward jump, and this is where it starts. Read only
  // after the first check fails, so the happy path pays nothing for it.
  const stateBacked = await stateBackedDoctorNames({
    clinicId: input.clinicId,
    conversationId: input.conversationId,
    directory,
  });
  if (stateBacked.length > 0) {
    const widened = [...allowedNames, ...stateBacked];
    const second = checkDoctorGrounding({
      text,
      allowedNames: widened,
      clinicDoctors,
      allowedOtherNames,
      rosterBearing,
    });
    if (second.grounded) {
      await logAgentTool({
        clinicId: input.clinicId,
        actorId: null,
        tool: "patient_reply_grounding",
        params: { outcome: "grounded", attempt: 1, reason: "state_backed" },
      });
      return { text, outcome: "grounded", rosterBearing };
    }
  }

  await logAgentTool({
    clinicId: input.clinicId,
    actorId: null,
    tool: "patient_reply_grounding",
    params: {
      outcome: "violation",
      attempt: 1,
      violations: first.violations.length,
      // Labels, never names: the mention itself is patient-adjacent free text
      // and a phantom name in an audit row is still a name in an audit row.
      sources: [...new Set(first.violations.map((item) => item.source))].join(","),
      offered_doctor_count: allowedNames.length,
      roster_bearing: rosterBearing,
      server_backed: allowedNames.length > 0,
    },
  });

  // P11B — a roster-bearing turn with no authoritative roster behind it cannot
  // be repaired by asking the model again. The repair pass is deliberately
  // tool-free (a truthfulness check must not be able to write to the database),
  // so it has no way to obtain the list it is missing; asking it to "name only
  // the permitted doctors" when the permitted set is empty is an invitation to
  // invent a second time. The server composes the answer from the directory it
  // has already loaded, and the patient gets a true sentence on this turn
  // rather than a second guess.
  if (rosterBearing && allowedNames.length === 0) {
    const authoritative = await buildAuthoritativeReply({
      clinicId: input.clinicId,
      conversationId: input.conversationId,
      locale: input.locale,
      directory,
      patientText: input.latestPatientText ?? null,
    });
    await logAgentTool({
      clinicId: input.clinicId,
      actorId: null,
      tool: "patient_reply_grounding",
      params: { outcome: "deterministic", attempt: 1, reason: "unbacked_roster" },
    });
    return { text: authoritative, outcome: "deterministic", rosterBearing };
  }

  const correction = buildGroundingCorrection({
    locale: input.locale,
    allowedNames,
    violations: first.violations,
  });

  let second = "";
  try {
    second = (await input.regenerate(correction)).trim();
  } catch {
    second = "";
  }
  if (second) {
    const retry = checkDoctorGrounding({
      text: second,
      allowedNames,
      clinicDoctors,
      allowedOtherNames,
      rosterBearing,
    });
    if (retry.grounded) {
      await logAgentTool({
        clinicId: input.clinicId,
        actorId: null,
        tool: "patient_reply_grounding",
        params: { outcome: "repaired", attempt: 2 },
      });
      return { text: second, outcome: "repaired", rosterBearing };
    }
  }

  // Twice ungrounded. The patient gets the roster itself, composed from the
  // authoritative list rather than from anything the model wrote.
  const deterministic = await buildAuthoritativeReply({
    clinicId: input.clinicId,
    conversationId: input.conversationId,
    locale: input.locale,
    directory,
    patientText: input.latestPatientText ?? null,
  });
  await logAgentTool({
    clinicId: input.clinicId,
    actorId: null,
    tool: "patient_reply_grounding",
    params: { outcome: "deterministic", attempt: 2 },
  });
  return { text: deterministic, outcome: "deterministic", rosterBearing };
}

/**
 * The doctors this conversation has *already* been told about by the server.
 *
 * Two sources, both server-owned and neither model-writable: the doctor
 * committed into `ai_collected_data`, and the ids in `offeredDoctorIds`. Names
 * are taken from the live directory rather than from the stored string, so a
 * doctor who has since been deactivated does not become permanently nameable
 * and a stale stored spelling cannot widen the allowed set on its own.
 *
 * Best-effort in one direction only: a read failure returns nothing, which
 * leaves the pre-P11F behaviour exactly as it was.
 */
async function stateBackedDoctorNames(input: {
  clinicId: string;
  conversationId: string;
  directory: Awaited<ReturnType<typeof loadDoctorDirectory>>;
}): Promise<string[]> {
  try {
    const { data } = await resolvePatientAiContext({
      clinicId: input.clinicId,
      conversationId: input.conversationId,
    });
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return [];
    const collected = parseCollectedData(
      (row as { collected_data?: unknown }).collected_data,
    );
    const stage = parseBookingStageState(
      (row as { booking_stage?: unknown }).booking_stage,
    );
    const ids = new Set<string>(stage.offeredDoctorIds);
    const doctorId = collected.doctor_id;
    if (typeof doctorId === "string" && doctorId.trim().length > 0) ids.add(doctorId);
    const names: string[] = [];
    for (const id of ids) {
      const doctor = input.directory.doctors.find((item) => item.id === id);
      if (doctor) names.push(doctor.name);
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * The true sentence for where this conversation actually is — and, since P11D,
 * the state that sentence implies.
 *
 * Before P11D this function was a pure render: it re-derived the department
 * from the *current inbound message* on every call and persisted nothing, so a
 * roster it had just offered was forgotten by the next turn and a bare doctor
 * name ("حنين") fell back to re-listing departments. See
 * `patient-roster-continuation.ts` for the production trace.
 *
 * It now delegates to the continuation, which commits what it offers. The
 * delegation is best-effort in one direction only, exactly as the rest of this
 * module is: if the conversation cannot be authorized the old stateless render
 * still answers, so a failure here can degrade the reply but can never invent a
 * doctor.
 */
async function buildAuthoritativeReply(input: {
  clinicId: string;
  conversationId: string;
  locale: "ar" | "en";
  directory: Awaited<ReturnType<typeof loadDoctorDirectory>>;
  patientText?: string | null;
}): Promise<string> {
  try {
    const identity = await authorizePatientConversation({
      clinicId: input.clinicId,
      conversationId: input.conversationId,
      locale: input.locale,
    });
    const continuation = await continuePatientBookingFromRoster({
      identity,
      directory: input.directory,
      locale: input.locale,
      patientText: input.patientText ?? null,
    });
    return continuation.text;
  } catch {
    // Unauthorized, unentitled, or a transient read failure. Fall back to the
    // pre-P11D stateless answer rather than to silence.
    return buildStatelessRosterReply(input);
  }
}

/** The pre-P11D render, kept as the degraded path. Persists nothing. */
async function buildStatelessRosterReply(input: {
  clinicId: string;
  conversationId: string;
  locale: "ar" | "en";
  directory: Awaited<ReturnType<typeof loadDoctorDirectory>>;
  patientText?: string | null;
}): Promise<string> {
  let departmentId: string | null = null;
  try {
    const { data } = await resolvePatientAiContext({
      clinicId: input.clinicId,
      conversationId: input.conversationId,
    });
    const row = Array.isArray(data) ? data[0] : null;
    departmentId = establishedDepartmentId(
      parseCollectedData((row as { collected_data?: unknown } | null)?.collected_data),
    );
  } catch {
    departmentId = null;
  }
  let department =
    input.directory.departments.find((item) => item.id === departmentId) ?? null;
  if (!department && input.patientText) {
    const resolution = resolveNamedEntity(input.patientText, input.directory.departments);
    if (resolution.status === "resolved") {
      department =
        input.directory.departments.find((item) => item.id === resolution.entity.id) ??
        null;
    }
  }
  return buildDeterministicRosterReply({
    locale: input.locale,
    departmentName: department?.name ?? null,
    doctors: department
      ? availableDoctorsInDepartment(input.directory, department.id).map(
          (item) => item.name,
        )
      : [],
    departments: input.directory.departments.map((item) => item.name),
  });
}


/**
 * F-1 — the commercial half of the grounding contract.
 *
 * The same two-step repair the doctor path uses, and for the same reason: a
 * model that quoted a number it made up will usually stop when told the number
 * is not the clinic's, and a model that does it twice has to be answered by the
 * server. The difference is the fallback — there is no authoritative price list
 * to compose from without a tool receipt, so the deterministic reply says
 * exactly that and asks the question that gets one on the next turn.
 *
 * Returns `null` when there was nothing to correct, which is the ordinary case
 * and costs one regex sweep of the reply.
 */
async function enforceCommercialGrounding(input: {
  clinicId: string;
  locale: "ar" | "en";
  text: string;
  ledger: GroundingLedger;
  regenerate: RegenerateFn;
}): Promise<{ text: string; outcome: GroundingEnforcement["outcome"] } | null> {
  const check = checkCommercialGrounding({
    text: input.text,
    allowedPrices: input.ledger.prices(),
    sawServices: input.ledger.sawServices(),
    sawInsurers: input.ledger.sawInsurers(),
  });
  if (check.grounded) return null;

  await logAgentTool({
    clinicId: input.clinicId,
    actorId: null,
    tool: "patient_commercial_grounding",
    params: {
      outcome: "violation",
      attempt: 1,
      // Labels and counts. The quoted number itself is model output about a
      // patient's question and has no business in an audit row.
      sources: [...new Set(check.violations.map((item) => item.source))].join(","),
      violations: check.violations.length,
      priced_receipt: input.ledger.sawServices(),
      insurer_receipt: input.ledger.sawInsurers(),
    },
  });

  const kind = check.violations.some((item) => item.source === "unbacked_insurer")
    ? ("insurance" as const)
    : ("price" as const);

  // With no receipt at all there is nothing for a second attempt to be right
  // about, exactly as with an unbacked roster: asking the model to "quote only
  // the real prices" when no real price is in front of it invites a second
  // invention. Straight to the deterministic answer.
  const noReceipt = !input.ledger.sawServices() && !input.ledger.sawInsurers();
  if (!noReceipt) {
    let second = "";
    try {
      second = (
        await input.regenerate(
          buildCommercialCorrection({
            locale: input.locale,
            violations: check.violations,
          }),
        )
      ).trim();
    } catch {
      second = "";
    }
    if (
      second &&
      checkCommercialGrounding({
        text: second,
        allowedPrices: input.ledger.prices(),
        sawServices: input.ledger.sawServices(),
        sawInsurers: input.ledger.sawInsurers(),
      }).grounded
    ) {
      await logAgentTool({
        clinicId: input.clinicId,
        actorId: null,
        tool: "patient_commercial_grounding",
        params: { outcome: "repaired", attempt: 2 },
      });
      return { text: second, outcome: "repaired" };
    }
  }

  await logAgentTool({
    clinicId: input.clinicId,
    actorId: null,
    tool: "patient_commercial_grounding",
    params: { outcome: "deterministic", attempt: noReceipt ? 1 : 2, kind },
  });
  return {
    text: buildDeterministicCommercialReply({ locale: input.locale, kind }),
    outcome: "deterministic",
  };
}
