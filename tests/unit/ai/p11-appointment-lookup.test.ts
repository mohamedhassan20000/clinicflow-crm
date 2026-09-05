import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11 — "عايز أعرف ميعادي".
 *
 * The tool contract, at the seam where the model meets the RPC. What it proves:
 * two fields are asked for and no more, the two values are the *only* thing the
 * lookup is performed on, and every failure comes back as one indistinguishable
 * answer. The database half — folding, rate limiting, the absence of any read
 * of `conversations.patient_id` — is proved against real Postgres in
 * `tests/unit/integration/p11-appointment-lookup-identity.test.ts`.
 */

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  lookup: vi.fn(),
  audit: vi.fn(),
  persist: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: mocks.audit }));
vi.mock("@/lib/ai/patient-authorization", async (original) => {
  const actual = await original<typeof import("@/lib/ai/patient-authorization")>();
  return { ...actual, authorizePatientConversation: mocks.authorize };
});
vi.mock("@/lib/supabase/admin", () => ({
  lookupPatientAppointmentsByIdentity: mocks.lookup,
  setConversationAiState: mocks.persist,
}));

import { lookupAppointmentTool } from "@/lib/ai/tools/lookup-appointment";
import { PATIENT_TOOL_NAMES } from "@/lib/ai/patient-tools";
import {
  STAGE_INDEPENDENT_TOOLS,
  allowedToolsForStage,
  BOOKING_STAGES,
  EMPTY_BOOKING_STAGE_STATE,
} from "@/lib/ai/booking-stage";
import { buildPatientSystemPrompt } from "@/lib/ai/prompts/patient";

const ctx = { clinicId: CLINIC, conversationId: CONVERSATION, locale: "ar" as const };
const opts = {} as never;

function lookup(input: Record<string, unknown>) {
  return lookupAppointmentTool(ctx).execute!(input as never, opts) as unknown as Promise<
    Record<string, unknown>
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.audit.mockResolvedValue(undefined);
  mocks.persist.mockResolvedValue({ data: null, error: null });
  mocks.authorize.mockResolvedValue({
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: null,
    linked: false,
    identityVerifiedAt: null,
    collectedData: {},
    // P11B: the lookup reads its own held half-identity out of the stage
    // record, so the resolved context must carry one exactly as it does live.
    bookingStage: EMPTY_BOOKING_STAGE_STATE,
  });
});

describe("P11 §10 · the lookup asks for a name and an id, and nothing else", () => {
  it("takes exactly two inputs", () => {
    const schema = lookupAppointmentTool(ctx).inputSchema as unknown as {
      shape: Record<string, unknown>;
    };
    expect(Object.keys(schema.shape).sort()).toEqual(["full_name", "national_id"]);
  });

  it("is mounted, and is available in every booking stage", () => {
    expect(PATIENT_TOOL_NAMES).toContain("lookup_appointment");
    expect(STAGE_INDEPENDENT_TOOLS).toContain("lookup_appointment");
    for (const stage of BOOKING_STAGES) {
      if (stage === "escalated") continue;
      expect(
        allowedToolsForStage(stage, [...PATIENT_TOOL_NAMES]),
        stage,
      ).toContain("lookup_appointment");
    }
  });

  it("tells the model, in both languages, not to open a file for this", () => {
    for (const locale of ["ar", "en"] as const) {
      const prompt = buildPatientSystemPrompt(locale);
      expect(prompt).toContain("lookup_appointment");
    }
    expect(buildPatientSystemPrompt("en")).toContain("NOT a registration");
    expect(buildPatientSystemPrompt("ar")).toContain("ابعتلي اسمك بالكامل ورقم الهوية");
  });
});

describe("P11 §11 · matching is the server's decision, and it is exact", () => {
  it("passes the patient's own words through the deterministic parsers", async () => {
    mocks.lookup.mockResolvedValue({
      data: [
        {
          status: "found",
          attempts_remaining: 5,
          patient_name: "Sara Kamal",
          appointment_id: "a1",
          scheduled_at: "2026-09-01T10:00:00.000Z",
          duration_minutes: 30,
          appointment_status: "pending",
          doctor_name: "Rana Wasfy",
          department_name: "Gamma Unit",
          service_name: "Consultation",
        },
      ],
      error: null,
    });
    const result = await lookup({ full_name: "  sara   kamal ", national_id: "٢٩٩٠١٠١١٢٣٤٥٦" });
    expect(mocks.lookup).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: CLINIC,
        conversationId: CONVERSATION,
        nationalId: "29901011234567".slice(0, 13),
      }),
    );
    expect(result.found).toBe(true);
    expect(result.appointment_count).toBe(1);
  });

  it("never sends a patient id, and never receives one back", async () => {
    mocks.lookup.mockResolvedValue({
      data: [{ status: "no_upcoming", attempts_remaining: 5, patient_name: "Sara Kamal" }],
      error: null,
    });
    const result = await lookup({ full_name: "Sara Kamal", national_id: "29901011234567" });
    const call = mocks.lookup.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(call).sort()).toEqual([
      "clinicId",
      "conversationId",
      "fullName",
      "nationalId",
    ]);
    expect(JSON.stringify(result)).not.toContain("patient_id");
  });

  it("costs no attempt when we cannot read what the patient wrote", async () => {
    const result = await lookup({ full_name: "؟؟", national_id: "..." });
    // P11B folded "unreadable" into "needs_identity": from the patient's side
    // the two are the same event — the server still needs that detail — and
    // collapsing them removes one more way to tell what the server did or did
    // not recognise. The property that matters is unchanged and asserted
    // below: the rate-limited RPC is never reached, so no attempt is spent.
    expect(result.reason).toBe("needs_identity");
    expect(result.missing).toEqual(["full_name", "national_id"]);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
});

describe("P11 §11-12 · one answer for every failure, and no clinical spill", () => {
  it("says the same thing for a wrong name, a wrong id, and both wrong", async () => {
    const replies: string[] = [];
    for (const attempt of [1, 2, 3]) {
      mocks.lookup.mockResolvedValue({
        data: [{ status: "no_match", attempts_remaining: 5 - attempt }],
        error: null,
      });
      const result = await lookup({
        full_name: `Name ${attempt}`,
        national_id: `2990101123456${attempt}`,
      });
      expect(result.found).toBe(false);
      expect(result.reason).toBe("no_match");
      replies.push(String(result.guidance));
    }
    expect(new Set(replies).size).toBe(1);
    expect(replies[0]).toContain("Never say whether the name or the id was the problem");
  });

  it("refuses to retry once the conversation is locked", async () => {
    mocks.lookup.mockResolvedValue({
      data: [{ status: "locked", attempts_remaining: 0 }],
      error: null,
    });
    const result = await lookup({ full_name: "Sara Kamal", national_id: "29901011234567" });
    expect(result.reason).toBe("identity_verification_locked");
    expect(String(result.guidance)).toContain("Do not retry");
  });

  it("distinguishes 'no booking' from 'no such patient' only inside the result", async () => {
    mocks.lookup.mockResolvedValue({
      data: [{ status: "no_upcoming", attempts_remaining: 5, patient_name: "Sara Kamal" }],
      error: null,
    });
    const result = await lookup({ full_name: "Sara Kamal", national_id: "29901011234567" });
    expect(result.found).toBe(true);
    expect(result.appointment_count).toBe(0);
    expect(String(result.guidance)).toContain("no upcoming appointment");
  });

  it("returns several upcoming appointments in order, with no clinical fields", async () => {
    mocks.lookup.mockResolvedValue({
      data: [
        {
          status: "found", attempts_remaining: 5, patient_name: "Sara Kamal",
          appointment_id: "a1", scheduled_at: "2026-09-01T10:00:00.000Z",
          duration_minutes: 30, appointment_status: "pending",
          doctor_name: "Rana Wasfy", department_name: "Gamma Unit", service_name: null,
        },
        {
          status: "found", attempts_remaining: 5, patient_name: "Sara Kamal",
          appointment_id: "a2", scheduled_at: "2026-09-08T12:00:00.000Z",
          duration_minutes: 30, appointment_status: "confirmed",
          doctor_name: "Tarek Sobhy", department_name: "Gamma Unit", service_name: "Follow-up",
        },
      ],
      error: null,
    });
    const result = await lookup({ full_name: "Sara Kamal", national_id: "29901011234567" });
    const rows = result.appointments as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "date",
      "department_name",
      "doctor_name",
      "duration_minutes",
      "scheduled_at",
      "service_name",
      "status",
      "time",
    ]);
    expect(result.clinical_disclosure_allowed).toBe(false);
  });

  it("§13 does not verify identity and does not unlock clinical disclosure", async () => {
    mocks.lookup.mockResolvedValue({
      data: [{ status: "no_upcoming", attempts_remaining: 5, patient_name: "Sara Kamal" }],
      error: null,
    });
    await lookup({ full_name: "Sara Kamal", national_id: "29901011234567" });
    // The tool authorizes the conversation without requiring — or granting —
    // verification. `requireVerified` stays the only door to disclosure.
    const options = mocks.authorize.mock.calls[0]![1] as Record<string, unknown>;
    expect(options.requireVerified).toBeUndefined();
    expect(options.requireLinked).toBeUndefined();
    expect(options.refuseIfPaused).toBe(true);
  });

  it("audits every outcome as booking scope", async () => {
    mocks.lookup.mockResolvedValue({
      data: [{ status: "no_match", attempts_remaining: 4 }],
      error: null,
    });
    await lookup({ full_name: "Sara Kamal", national_id: "29901011234567" });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "lookup_appointment",
        params: expect.objectContaining({ scope: "booking_only" }),
      }),
    );
  });
});


// ---------------------------------------------------------------------------
// P11B — the two halves may arrive on different turns
// ---------------------------------------------------------------------------

/** The stage record as it would be read back on the following turn. */
function heldIdentity(appointmentLookup: Record<string, unknown> | null) {
  return {
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: null,
    linked: false,
    identityVerifiedAt: null,
    collectedData: {},
    bookingStage: { ...EMPTY_BOOKING_STAGE_STATE, appointmentLookup },
  };
}

/** What the tool asked the server to persist on its last call. */
function persistedStage(): Record<string, unknown> | null {
  const calls = mocks.persist.mock.calls as Array<[{ stage?: Record<string, unknown> }]>;
  return calls.length === 0 ? null : (calls[calls.length - 1]![0].stage ?? null);
}

describe("P11B §6 · name on one turn, national id on the next", () => {
  it("asks only for the missing half, and spends no lookup attempt", async () => {
    const result = await lookup({ full_name: "سارة محمود عبد الله" });
    expect(result.reason).toBe("needs_identity");
    expect(result.missing).toEqual(["national_id"]);
    expect(result.have).toEqual(["full_name"]);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("never asks for anything the lookup does not use", async () => {
    const result = await lookup({ national_id: "29801011234567" });
    const guidance = String(result.guidance).toLowerCase();
    // Every sentence that mentions one of these must be forbidding it. The
    // lookup identifies an existing file from two values; a guidance line that
    // *requested* a date of birth, an email or a phone number would be the old
    // slide into registration coming back through the instruction instead of
    // through the schema.
    for (const forbidden of ["date of birth", "email", "phone", "blood", "registr"]) {
      for (const sentence of guidance.split(/(?<=\.)\s+/)) {
        if (!sentence.includes(forbidden)) continue;
        expect(sentence, `${forbidden}: ${sentence}`).toMatch(/\bnever\b/);
      }
    }
    expect(guidance).toMatch(/never start a new patient registration/i);
    // And it asks for exactly what the server is missing — nothing else.
    expect(guidance).toContain("`missing`");
  });

  it("holds the half it has on the server, not in the model's memory", async () => {
    await lookup({ full_name: "سارة محمود عبد الله" });
    const stage = persistedStage();
    expect(stage).not.toBeNull();
    expect((stage!.appointmentLookup as Record<string, unknown>).fullName).toBe(
      "سارة محمود عبد الله",
    );
    expect((stage!.appointmentLookup as Record<string, unknown>).nationalId).toBeNull();
  });

  it("keeps the held half out of registration and booking state", async () => {
    await lookup({ full_name: "سارة محمود عبد الله" });
    const [[payload]] = mocks.persist.mock.calls as Array<[Record<string, unknown>]>;
    // `set_conversation_ai_state` merges `collected` and replaces `stage`. The
    // lookup writes only the second, so nothing it holds can ever be read by
    // `register_patient` or `prepare_booking`, both of which read the first.
    expect(payload.collected).toBeUndefined();
    expect(payload.stage).toBeDefined();
    expect(JSON.stringify(payload.stage)).not.toContain("full_name");
    expect(JSON.stringify(payload.stage)).not.toContain("national_id");
  });

  it("completes on the second turn without re-asking for the first value", async () => {
    mocks.authorize.mockResolvedValue(
      heldIdentity({ fullName: "سارة محمود عبد الله", nationalId: null }),
    );
    mocks.lookup.mockResolvedValue({ data: [{ status: "no_upcoming" }], error: null });

    const result = await lookup({ national_id: "29801011234567" });
    expect(result.reason).toBeUndefined();
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    const [[args]] = mocks.lookup.mock.calls as Array<[Record<string, unknown>]>;
    expect(args.fullName).toBe("سارة محمود عبد الله");
    expect(args.nationalId).toBe("29801011234567");
  });

  it("works in the other order too", async () => {
    mocks.authorize.mockResolvedValue(
      heldIdentity({ fullName: null, nationalId: "29801011234567" }),
    );
    mocks.lookup.mockResolvedValue({ data: [{ status: "no_upcoming" }], error: null });

    await lookup({ full_name: "سارة محمود عبد الله" });
    const [[args]] = mocks.lookup.mock.calls as Array<[Record<string, unknown>]>;
    expect(args.fullName).toBe("سارة محمود عبد الله");
    expect(args.nationalId).toBe("29801011234567");
  });

  it("prefers a corrected value over the one it was holding", async () => {
    mocks.authorize.mockResolvedValue(
      heldIdentity({ fullName: "سارة محمود", nationalId: "11111111111111" }),
    );
    mocks.lookup.mockResolvedValue({ data: [{ status: "no_upcoming" }], error: null });

    await lookup({ national_id: "29801011234567" });
    const [[args]] = mocks.lookup.mock.calls as Array<[Record<string, unknown>]>;
    expect(args.nationalId).toBe("29801011234567");
  });

  it("erases the held identity as soon as the lookup resolves, either way", async () => {
    for (const status of ["no_match", "no_upcoming", "locked"]) {
      vi.clearAllMocks();
      mocks.persist.mockResolvedValue({ data: null, error: null });
      mocks.audit.mockResolvedValue(undefined);
      mocks.authorize.mockResolvedValue(
        heldIdentity({ fullName: "سارة محمود عبد الله", nationalId: null }),
      );
      mocks.lookup.mockResolvedValue({ data: [{ status }], error: null });

      await lookup({ national_id: "29801011234567" });
      expect(persistedStage()?.appointmentLookup, status).toBeNull();
    }
  });

  it("still never reads the conversation's own patient for the match", async () => {
    mocks.authorize.mockResolvedValue({
      ...heldIdentity({ fullName: "سارة محمود عبد الله", nationalId: null }),
      // A linked, fully verified thread belonging to somebody else entirely.
      patientId: "99999999-9999-4999-8999-999999999999",
      linked: true,
      identityVerifiedAt: "2026-08-01T00:00:00.000Z",
    });
    mocks.lookup.mockResolvedValue({ data: [{ status: "no_match" }], error: null });

    await lookup({ national_id: "29801011234567" });
    const [[args]] = mocks.lookup.mock.calls as Array<[Record<string, unknown>]>;
    expect(Object.keys(args).sort()).toEqual([
      "clinicId",
      "conversationId",
      "fullName",
      "nationalId",
    ]);
    expect(JSON.stringify(args)).not.toContain("99999999");
  });
});
