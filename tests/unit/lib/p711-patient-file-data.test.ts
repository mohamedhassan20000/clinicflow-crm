import { describe, expect, it } from "vitest";
import {
  assembleAppointmentHistory,
  computeBillingTotals,
  computeDepositState,
  isClinicalDocumentType,
  loadAppointmentHistory,
  PATIENT_FILE_APPOINTMENT_PREVIEW_LIMIT,
  PATIENT_HISTORY_DOCUMENT_TYPES,
  resolveHistoryRange,
  type UnifiedFollowup,
  type UnifiedMedicalNote,
  type UnifiedRelatedDocument,
} from "@/lib/patients/file-data";

const NOW = new Date("2026-08-02T12:00:00.000Z");

describe("resolveHistoryRange", () => {
  it("defaults to unbounded (all) for empty/unknown presets", () => {
    expect(resolveHistoryRange({ now: NOW })).toEqual({
      preset: "all",
      from: null,
      to: null,
    });
    expect(resolveHistoryRange({ preset: "bogus", now: NOW }).preset).toBe("all");
  });

  it("computes rolling last-week / month / year ranges from now", () => {
    expect(resolveHistoryRange({ preset: "last_week", now: NOW })).toEqual({
      preset: "last_week",
      from: "2026-07-26",
      to: "2026-08-02",
    });
    expect(resolveHistoryRange({ preset: "last_month", now: NOW })).toEqual({
      preset: "last_month",
      from: "2026-07-02",
      to: "2026-08-02",
    });
    expect(resolveHistoryRange({ preset: "last_year", now: NOW })).toEqual({
      preset: "last_year",
      from: "2025-08-02",
      to: "2026-08-02",
    });
  });

  it("shares clinic-local rolling-year semantics at the leap-day boundary", () => {
    expect(
      resolveHistoryRange({
        preset: "last_year",
        now: new Date("2024-02-29T10:00:00.000Z"),
      }),
    ).toEqual({
      preset: "last_year",
      from: "2023-02-28",
      to: "2024-02-29",
    });
  });

  it("honours a valid custom range and rejects malformed dates", () => {
    expect(
      resolveHistoryRange({ preset: "custom", from: "2026-01-01", to: "2026-02-01" }),
    ).toEqual({ preset: "custom", from: "2026-01-01", to: "2026-02-01" });
    // Malformed inputs are dropped; a custom preset with no valid bound falls back to all.
    expect(resolveHistoryRange({ preset: "custom", from: "not-a-date" })).toEqual({
      preset: "all",
      from: null,
      to: null,
    });
  });
});

describe("computeBillingTotals", () => {
  it("sums only completed appointments across all payment channels", () => {
    const totals = computeBillingTotals([
      {
        status: "completed",
        total_amount: 100,
        paid_amount: 40,
        insurance_amount: 30,
        secondary_amount: 10,
        deposit_amount: 5,
        outstanding_amount: 15,
      },
      { status: "scheduled", total_amount: 999, outstanding_amount: 999 },
    ]);
    expect(totals).toEqual({ billed: 100, collected: 85, outstanding: 15 });
  });
});

describe("computeDepositState", () => {
  it("derives a non-negative account balance from deposits minus spend", () => {
    expect(
      computeDepositState([{ amount: 200 }, { amount: 50 }], [{ deposit_amount: 80 }]),
    ).toEqual({ totalDeposited: 250, totalSpent: 80, accountBalance: 170 });
    // Overspend never produces a negative balance.
    expect(
      computeDepositState([{ amount: 50 }], [{ deposit_amount: 80 }]).accountBalance,
    ).toBe(0);
  });
});

describe("clinical document classification", () => {
  it("recognises the three clinical types and rejects financial ones", () => {
    expect(isClinicalDocumentType("PRESCRIPTION")).toBe(true);
    expect(isClinicalDocumentType("LAB_REQUEST")).toBe(true);
    expect(isClinicalDocumentType("SICK_LEAVE_CERTIFICATE")).toBe(true);
    expect(isClinicalDocumentType("INVOICE")).toBe(false);
    expect(isClinicalDocumentType("REVENUE_REPORT")).toBe(false);
  });

  it("exposes the P7-12 print targets without wiring generation", () => {
    expect(PATIENT_HISTORY_DOCUMENT_TYPES).toEqual({
      appointmentHistory: "APPOINTMENT_HISTORY_REPORT",
      packageHistory: "PACKAGE_HISTORY_REPORT",
      depositStatement: "DEPOSIT_STATEMENT",
      patientFinancialSummary: "PATIENT_FINANCIAL_SUMMARY",
    });
  });
});

describe("assembleAppointmentHistory", () => {
  it("attaches each appointment's follow-ups, notes and documents by id", () => {
    const followups = new Map<string, UnifiedFollowup[]>([
      ["a1", [{ id: "f1", outcome: "all_fine", notes: null, recorded_at: "x", recorded_by_name: "R" }]],
    ]);
    const notes = new Map<string, UnifiedMedicalNote[]>([
      [
        "a1",
        [
          {
            id: "n1",
            patient_id: "p1",
            doctor_id: "doctor-1",
            created_by: "doctor-1",
            note: "hi",
            created_at: "x",
            profiles: { full_name: "Dr" },
            attachments: [],
          },
        ],
      ],
    ]);
    const documents = new Map<string, UnifiedRelatedDocument[]>([
      ["a2", [{ id: "d1", docType: "PRESCRIPTION", documentNumber: "RX-1", status: "issued", issuedAt: "x", verificationToken: "t" }]],
    ]);

    const entries = assembleAppointmentHistory({
      appointments: [{ id: "a1" }, { id: "a2" }],
      followupsByAppointment: followups,
      notesByAppointment: notes,
      documentsByAppointment: documents,
    });

    expect(entries).toHaveLength(2);
    expect(entries[0].followups).toHaveLength(1);
    expect(entries[0].notes).toHaveLength(1);
    expect(entries[0].documents).toHaveLength(0);
    expect(entries[1].documents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// loadAppointmentHistory — role-scoped query shape + financial isolation
// ---------------------------------------------------------------------------

type MockResults = Record<string, { data: unknown[]; count?: number }>;

function makeClient(results: MockResults) {
  const calls = {
    tables: [] as string[],
    selects: {} as Record<string, string>,
    limits: [] as number[],
    filters: [] as { table: string; method: string; column: string; value: unknown }[],
  };
  const client = {
    from(table: string) {
      calls.tables.push(table);
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const m of ["eq", "is", "in", "not", "gte", "lte"]) {
        builder[m] = (column: string, value: unknown) => {
          calls.filters.push({ table, method: m, column, value });
          return builder;
        };
      }
      builder.order = chain;
      builder.limit = (value: number) => {
        calls.limits.push(value);
        return builder;
      };
      builder.select = (sel: string) => {
        calls.selects[table] = sel;
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(results[table] ?? { data: [], count: 0 }).then(resolve);
      return builder;
    },
  };
  return { client, calls };
}

const BASE_RESULTS: MockResults = {
  appointments: { data: [{ id: "a1", status: "completed", scheduled_at: "x" }], count: 1 },
  follow_ups: {
    data: [
      { id: "f1", appointment_id: "a1", outcome: "all_fine", notes: "ok", recorded_at: "x", recorded_by: { full_name: "Recep" } },
    ],
  },
  medical_notes: {
    data: [{ id: "n1", patient_id: "p1", appointment_id: "a1", doctor_id: "doctor-1", created_by: "doctor-1", note: "seen", created_at: "x", profiles: { full_name: "Dr House" } }],
  },
  medical_note_attachments: {
    data: [
      { id: "att-1", note_id: "n1", file_name: "scan.pdf", mime_type: "application/pdf", size_bytes: 2000, created_at: "x", uploaded_by: "doctor-1", uploaded_by_profile: { full_name: "Dr House" } },
    ],
  },
  documents: {
    data: [
      { id: "d1", appointment_id: "a1", doc_type: "PRESCRIPTION", document_number: "RX-1", status: "issued", issued_at: "x", verification_token: "t1" },
      { id: "d2", appointment_id: "a1", doc_type: "INVOICE", document_number: "INV-1", status: "issued", issued_at: "x", verification_token: "t2" },
    ],
  },
  outstanding_settlements: {
    data: [{ id: "s1", appointment_id: "a1", settled_at: "x", amount: 10, payment_method: "cash", note: null }],
  },
};

describe("loadAppointmentHistory", () => {
  it("caps the Patient File preview at exactly five while an unbounded load remains available", async () => {
    const preview = makeClient(BASE_RESULTS);
    await loadAppointmentHistory(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      preview.client as any,
      {
        clinicId: "c1",
        patientId: "p1",
        isScopedClinical: false,
        limit: PATIENT_FILE_APPOINTMENT_PREVIEW_LIMIT,
      },
    );
    expect(PATIENT_FILE_APPOINTMENT_PREVIEW_LIMIT).toBe(5);
    expect(preview.calls.limits).toEqual([5]);

    const fullHistory = makeClient(BASE_RESULTS);
    await loadAppointmentHistory(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fullHistory.client as any,
      { clinicId: "c1", patientId: "p1", isScopedClinical: false },
    );
    expect(fullHistory.calls.limits).toEqual([]);
  });

  it("non-scoped role: selects financial columns, loads settlements, shows all related documents", async () => {
    const { client, calls } = makeClient(BASE_RESULTS);
    const result = await loadAppointmentHistory(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      { clinicId: "c1", patientId: "p1", isScopedClinical: false },
    );

    expect(calls.selects.appointments).toContain("total_amount");
    expect(calls.tables).toContain("outstanding_settlements");
    expect(result.entries[0].documents).toHaveLength(2);
    expect(result.settlementsByAppointment.get("a1")).toHaveLength(1);
    expect(result.entries[0].followups).toHaveLength(1);
    expect(result.entries[0].notes).toHaveLength(1);
  });

  it("groups attachments through their note and appointment without cross-assignment", async () => {
    const results: MockResults = {
      ...BASE_RESULTS,
      appointments: {
        data: [
          { id: "a1", status: "completed", scheduled_at: "2026-05-02" },
          { id: "a2", status: "completed", scheduled_at: "2026-05-01" },
        ],
        count: 2,
      },
      medical_notes: {
        data: [
          { id: "n1", patient_id: "p1", appointment_id: "a1", doctor_id: "d1", created_by: "d1", note: "first", created_at: "x", profiles: { full_name: "One" } },
          { id: "n2", patient_id: "p1", appointment_id: "a2", doctor_id: "d2", created_by: "d2", note: "second", created_at: "y", profiles: { full_name: "Two" } },
        ],
      },
      medical_note_attachments: {
        data: [
          { id: "att-2", note_id: "n2", file_name: "second.pdf", mime_type: "application/pdf", size_bytes: 20, created_at: "y", uploaded_by: "d2", uploaded_by_profile: { full_name: "Two" } },
          { id: "att-1", note_id: "n1", file_name: "first.pdf", mime_type: "application/pdf", size_bytes: 10, created_at: "x", uploaded_by: "d1", uploaded_by_profile: { full_name: "One" } },
        ],
      },
    };
    const { client, calls } = makeClient(results);
    const result = await loadAppointmentHistory(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      {
        clinicId: "c1",
        patientId: "p1",
        isScopedClinical: false,
        includeNoteAttachments: true,
      },
    );

    expect(result.entries[0].notes[0].attachments[0].fileName).toBe("first.pdf");
    expect(result.entries[1].notes[0].attachments[0].fileName).toBe("second.pdf");
    expect(result.entries[0].notes[0].attachments).toHaveLength(1);
    expect(result.entries[1].notes[0].attachments).toHaveLength(1);
    expect(calls.filters).toEqual(
      expect.arrayContaining([
        { table: "medical_note_attachments", method: "eq", column: "clinic_id", value: "c1" },
        { table: "medical_note_attachments", method: "eq", column: "patient_id", value: "p1" },
        { table: "medical_note_attachments", method: "in", column: "note_id", value: ["n1", "n2"] },
      ]),
    );
  });

  it("scoped clinical role: no financial columns, no settlements, only clinical documents", async () => {
    const { client, calls } = makeClient(BASE_RESULTS);
    const result = await loadAppointmentHistory(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      { clinicId: "c1", patientId: "p1", isScopedClinical: true },
    );

    expect(calls.selects.appointments).not.toContain("total_amount");
    expect(calls.tables).not.toContain("outstanding_settlements");
    // INVOICE filtered out; only the PRESCRIPTION remains.
    expect(result.entries[0].documents).toHaveLength(1);
    expect(result.entries[0].documents[0].docType).toBe("PRESCRIPTION");
    expect(result.settlementsByAppointment.size).toBe(0);
    expect(calls.tables).not.toContain("medical_note_attachments");
  });
});
