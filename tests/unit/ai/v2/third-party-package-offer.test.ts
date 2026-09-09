/**
 * A package belongs to the patient who holds it, and a third-party booking is
 * for somebody else.
 *
 * `readPatientPackages` takes a `TurnContext` and no beneficiary, so the only
 * packages it can ever return are the **sender's**. The `package_offer` step
 * offered them unconditionally, which meant a father booking for his son was
 * asked whether to spend his own sessions on the son's appointment.
 *
 * It was also an unanswerable question. `commitBooking` fails closed on
 * `forThirdParty && packageId` — the third-party write goes through
 * `create_provisional_ai_appointment_request`, which has no package argument
 * and books a beneficiary with no `patients` row to decrement against — so a
 * patient who accepted the offer reached a guaranteed `failed` and a handoff.
 *
 * The fix is the step declining to ask. What is proved here:
 *
 *   1. `beneficiary === "other"` never produces a `package_use` offer, even
 *      when the sender is `verified` and really does own an applicable
 *      package;
 *   2. the beneficiary check runs *before* the disclosure read, so the
 *      sender's package list is not even fetched for a booking that cannot use
 *      it;
 *   3. self-booking is completely unchanged — same offer, same decline path,
 *      same "owns nothing" path, same `linked`-but-not-`verified` path;
 *   4. `commitBooking`'s fail-closed guard is still in place, so the bad
 *      combination stays impossible as well as unreachable.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));

const stubs = vi.hoisted(() => ({
  readDepartments: vi.fn(),
  readDoctors: vi.fn(),
  resolveDoctorSpoken: vi.fn(),
  resolveDepartmentSpoken: vi.fn(),
  resolveDepartmentNamed: vi.fn(),
  readAvailableDays: vi.fn(),
  readAvailableSlots: vi.fn(),
  readPatientPackages: vi.fn(),
  readPublicPackages: vi.fn(),
  readServices: vi.fn(),
  readPatientDocuments: vi.fn(),
  readDocumentLink: vi.fn(),
  readMyAppointments: vi.fn(),
  readTreatingDoctors: vi.fn(),
  readClinicInfo: vi.fn(),
  readClinicFaq: vi.fn(),
  readClinicInsurance: vi.fn(),
  readRescheduleTarget: vi.fn(),
  readKnownDepartments: vi.fn(),
  resolveIdentity: vi.fn(),
  stageIntake: vi.fn(),
  commitBooking: vi.fn(),
  commitCancellation: vi.fn(),
  commitReschedule: vi.fn(),
}));

vi.mock("@/lib/ai/v2/tools", () => stubs);

import { FLOW_REGISTRY } from "@/lib/ai/v2/flows";
import { newFrame, type FlowFrame } from "@/lib/ai/v2/flow-state";
import type { TurnContext } from "@/lib/ai/v2/context";

const NOW = new Date("2026-09-05T09:00:00.000Z");
const AT = NOW.toISOString();

const PACKAGE = {
  value: "pkg-physio-10",
  label: "باكيدج العلاج الطبيعي — 10 جلسات",
  source: "patient_packages" as const,
};

const step = FLOW_REGISTRY.book_appointment.steps.find(
  (candidate) => candidate.id === "package_offer",
)!;

function context(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    clinicId: "clinic-1",
    conversationId: "conv-1",
    turn: { text: "", receivedAt: AT, locale: "ar", attachments: [] },
    episode: { turns: [] },
    flows: { version: 1, stack: [] },
    durable: {
      treatingDoctors: async () => [],
      knownDepartments: async () => [],
      activePackages: async () => [],
      issuedDocuments: async () => [],
      appointments: async () => [],
      canonicalName: async () => null,
    },
    history: { search: async () => [] },
    identity: "verified",
    patientId: "patient-requester-a",
    participantAddress: "+201000000000",
    clinic: {
      name: "Clinic",
      timeZone: "Africa/Cairo",
      locale: "ar",
      country: "EG",
      timeFormat: "12h",
    },
    style: {
      language: "ar",
      arabicStyle: "egyptian",
      tone: "friendly",
      styleInstruction: null,
    },
    now: NOW,
    ...overrides,
  } as unknown as TurnContext;
}

const slot = (value: string) => ({ value, provenance: "spoken" as const, at: AT });

/** A booking frame specified up to the package question. */
function frame(
  beneficiary: "self" | "other",
  memo: Record<string, boolean> = {},
): FlowFrame {
  return {
    ...newFrame({ flow: "book_appointment", at: AT }),
    slots: {
      beneficiary: slot(beneficiary),
      department: slot("dept-physio"),
      doctor: slot("doc-youssef"),
      day: slot("2026-09-09"),
      time: slot("12:30"),
    },
    memo,
  } as unknown as FlowFrame;
}

describe("a third-party booking is never offered the requester's package", () => {
  it("skips the offer for beneficiary = other", async () => {
    stubs.readPatientPackages.mockResolvedValue([PACKAGE]);

    const outcome = await step.run({ frame: frame("other"), context: context() });

    expect(outcome.kind).toBe("inform");
    expect(outcome).toMatchObject({ say: "booking.package_not_offered" });
    // Not merely "no offer": the question is never asked in any form.
    expect(outcome.kind).not.toBe("offer");
  });

  it("does not even read the sender's packages for a third-party booking", async () => {
    stubs.readPatientPackages.mockClear();
    stubs.readPatientPackages.mockResolvedValue([PACKAGE]);

    await step.run({ frame: frame("other"), context: context() });

    // The disclosure read is skipped entirely, so a booking that cannot use a
    // package does not go looking for one.
    expect(stubs.readPatientPackages).not.toHaveBeenCalled();
  });

  it("skips it even when the sender owns several applicable packages", async () => {
    stubs.readPatientPackages.mockResolvedValue([
      PACKAGE,
      { ...PACKAGE, value: "pkg-second", label: "باكيدج تاني" },
    ]);

    const outcome = await step.run({ frame: frame("other"), context: context() });

    expect(outcome.kind).toBe("inform");
  });

  it("never emits a package_use offer for a third party at any identity level", async () => {
    stubs.readPatientPackages.mockResolvedValue([PACKAGE]);

    for (const identity of ["anonymous", "linked", "verified"] as const) {
      const outcome = await step.run({
        frame: frame("other"),
        context: context({ identity } as Partial<TurnContext>),
      });
      expect(outcome.kind, `identity ${identity}`).toBe("inform");
    }
  });
});

describe("self-booking package behaviour is unchanged", () => {
  it("still offers a verified patient their own applicable package", async () => {
    stubs.readPatientPackages.mockResolvedValue([PACKAGE]);

    const outcome = await step.run({ frame: frame("self"), context: context() });

    expect(outcome).toMatchObject({
      kind: "offer",
      slot: "package",
      offerKind: "package_use",
      say: "booking.package_offer",
    });
    expect(stubs.readPatientPackages).toHaveBeenCalled();
  });

  it("still says nothing to a linked but unverified patient", async () => {
    stubs.readPatientPackages.mockResolvedValue([PACKAGE]);

    const outcome = await step.run({
      frame: frame("self"),
      context: context({ identity: "linked" } as Partial<TurnContext>),
    });

    expect(outcome).toMatchObject({ kind: "inform", say: "booking.package_not_offered" });
  });

  it("still skips the offer when the patient owns nothing applicable", async () => {
    stubs.readPatientPackages.mockResolvedValue([]);

    const outcome = await step.run({ frame: frame("self"), context: context() });

    expect(outcome).toMatchObject({ kind: "inform", say: "booking.package_none" });
  });

  it("still records an accepted and a declined answer", async () => {
    stubs.readPatientPackages.mockResolvedValue([PACKAGE]);

    expect(
      await step.run({
        frame: frame("self", { package_accepted: true }),
        context: context(),
      }),
    ).toMatchObject({ kind: "inform", say: "booking.package_accepted" });

    expect(
      await step.run({
        frame: frame("self", { package_declined: true }),
        context: context(),
      }),
    ).toMatchObject({ kind: "inform", say: "booking.package_skipped" });
  });

  it("answers an already-accepted third party the same way it answers self", async () => {
    // The memo short-circuits run before the beneficiary check, so a frame
    // that somehow carries an acceptance is not re-asked. The guard below in
    // `commitBooking` is what makes that safe.
    expect(
      await step.run({
        frame: frame("other", { package_accepted: true }),
        context: context(),
      }),
    ).toMatchObject({ kind: "inform", say: "booking.package_accepted" });
  });
});

describe("the write stays fail-closed regardless", () => {
  const tools = readFileSync("lib/ai/v2/tools.ts", "utf8");

  it("commitBooking still refuses a third-party booking carrying a package", () => {
    expect(tools).toContain("if (input.forThirdParty && input.packageId) {");
    expect(tools).toContain('return { ok: false, reason: "failed" };');
  });

  it("the step reads the beneficiary from the frame, as the write does", () => {
    const flows = readFileSync("lib/ai/v2/flows.ts", "utf8");
    const start = flows.indexOf('id: "package_offer"');
    const body = flows.slice(start, flows.indexOf('id: "intake"', start));
    expect(body).toContain('frame.slots.beneficiary?.value === "other"');
    expect(body).toContain('say: "booking.package_not_offered"');
  });
});
