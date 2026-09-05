/**
 * Finding 5, at the place it actually lived — the L4 durable loaders.
 *
 * `knownDepartments` filtered the clinic's department list with a predicate
 * that never mentioned the department:
 *
 *     departments.filter(d => doctors.some(doc => doc.label.length > 0 && d.value.length > 0))
 *
 * true for every row the moment the patient had any treating doctor. So "the
 * departments this patient is known in" meant "all of them": the booking step's
 * known-first ordering was a no-op, and `previously_seen` was asserted about
 * places the patient had never been.
 *
 * Nothing covered `assemble.ts`, which is why it survived review of the flow
 * that consumes it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const stubs = vi.hoisted(() => ({
  readDepartments: vi.fn(),
  readKnownDepartments: vi.fn(),
  readTreatingDoctors: vi.fn(),
  readPatientPackages: vi.fn(),
  readPatientDocuments: vi.fn(),
  readMyAppointments: vi.fn(),
}));
vi.mock("@/lib/ai/v2/tools", () => stubs);

const identity = vi.hoisted(() => ({ authorizePatientConversation: vi.fn() }));
vi.mock("@/lib/ai/patient-authorization", () => identity);
vi.mock("@/lib/supabase/admin", () => ({
  getClinicAiReplyContext: vi.fn(async () => ({ data: { time_format: "24h" }, error: null })),
}));

import { buildTurnContext } from "@/lib/ai/v2/assemble";
import { EMPTY_FLOW_STATE } from "@/lib/ai/v2/flow-state";

const NOW = new Date("2026-09-04T12:00:00.000Z");

function build(overrides: Record<string, unknown> = {}) {
  identity.authorizePatientConversation.mockResolvedValue({
    patientId: "patient-1",
    linked: true,
    identityVerifiedAt: "2026-09-01T00:00:00.000Z",
    patientDisplayName: "أنس طلال",
    clinicName: "Clinic",
    clinicTimezone: "Africa/Cairo",
    clinicLocale: "ar",
    clinicCountry: "EG",
    ...overrides,
  });
  return buildTurnContext({
    clinicId: "clinic-1",
    conversationId: "conv-1",
    message: "أهلا",
    locale: "ar",
    style: { language: "ar", arabicStyle: "egyptian", tone: "friendly", styleInstruction: null },
    episode: [],
    flows: EMPTY_FLOW_STATE,
    now: NOW,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubs.readDepartments.mockResolvedValue([
    { value: "dept-derma", label: "الجلدية", source: "clinic_directory" },
    { value: "dept-cardio", label: "القلب", source: "clinic_directory" },
  ]);
  stubs.readKnownDepartments.mockResolvedValue([
    { value: "dept-cardio", label: "القلب", source: "patient_history" },
  ]);
  stubs.readTreatingDoctors.mockResolvedValue([
    { value: "doc-nabil", label: "Ahmed Nabil", source: "patient_history" },
  ]);
  stubs.readPatientPackages.mockResolvedValue([
    { value: "pkg-1", label: "باقة", source: "patient_packages" },
  ]);
  stubs.readPatientDocuments.mockResolvedValue([
    { value: "doc-1", label: "تقرير", source: "patient_documents" },
  ]);
  stubs.readMyAppointments.mockResolvedValue([]);
});

describe("finding 5: knownDepartments is the patient's own, not the clinic's", () => {
  it("returns only the departments the patient is actually known in", async () => {
    const context = await build();
    const known = await context.durable.knownDepartments();
    expect(known.map((entry) => entry.value)).toEqual(["dept-cardio"]);
  });

  it("returns nothing when the patient is known nowhere", async () => {
    stubs.readKnownDepartments.mockResolvedValue([]);
    const context = await build();
    // The bug returned every department here, because the patient had a doctor.
    expect(await context.durable.knownDepartments()).toEqual([]);
  });

  it("returns nothing for an anonymous sender without asking the database", async () => {
    const context = await build({ patientId: null, linked: false, identityVerifiedAt: null });
    expect(await context.durable.knownDepartments()).toEqual([]);
    expect(stubs.readKnownDepartments).not.toHaveBeenCalled();
  });
});

describe("the durable loaders keep their identity gates", () => {
  it("refuses packages and documents below `verified`", async () => {
    const context = await build({ identityVerifiedAt: null });
    expect(context.identity).toBe("linked");
    expect(await context.durable.activePackages()).toEqual([]);
    expect(await context.durable.issuedDocuments()).toEqual([]);
    expect(stubs.readPatientPackages).not.toHaveBeenCalled();
    expect(stubs.readPatientDocuments).not.toHaveBeenCalled();
  });

  it("allows them at `verified`", async () => {
    const context = await build();
    expect(context.identity).toBe("verified");
    expect(await context.durable.activePackages()).toHaveLength(1);
    expect(await context.durable.issuedDocuments()).toHaveLength(1);
  });

  it("withholds the canonical name below `verified`", async () => {
    const linked = await build({ identityVerifiedAt: null });
    expect(await linked.durable.canonicalName()).toBeNull();
    const verified = await build();
    expect(await verified.durable.canonicalName()).toBe("أنس طلال");
  });
});

describe("the loaders are lazy and memoized", () => {
  it("reads nothing while the context is being built", async () => {
    await build();
    expect(stubs.readTreatingDoctors).not.toHaveBeenCalled();
    expect(stubs.readKnownDepartments).not.toHaveBeenCalled();
    expect(stubs.readPatientPackages).not.toHaveBeenCalled();
  });

  it("asks once however many times a flow asks", async () => {
    const context = await build();
    await Promise.all([
      context.durable.treatingDoctors(),
      context.durable.treatingDoctors(),
      context.durable.treatingDoctors(),
    ]);
    expect(stubs.readTreatingDoctors).toHaveBeenCalledTimes(1);
  });
});

describe("the context a loader is handed is the finished one", () => {
  it("carries the real durable loader, not the assembly placeholder", async () => {
    const context = await build();
    await context.durable.treatingDoctors();
    const passed = stubs.readTreatingDoctors.mock.calls[0]![0] as {
      durable: { canonicalName: () => Promise<string | null> };
    };
    // The loaders close over the context object; it must be the one that ends
    // up with the real loaders attached, or a tool reaching back through it
    // would find the empty placeholder.
    expect(await passed.durable.canonicalName()).toBe("أنس طلال");
  });
});

describe("the firewall's own shape", () => {
  it("exposes no patient id to an anonymous turn", async () => {
    const context = await build({ patientId: null, linked: false, identityVerifiedAt: null });
    expect(context.identity).toBe("anonymous");
    expect(context.patientId).toBeNull();
  });

  it("keeps L5 inert", async () => {
    const context = await build();
    expect(await context.history.search({ topic: "anything" })).toEqual([]);
  });
});
