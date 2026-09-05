import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P12 — whose appointments the Inbox panel is allowed to show, and which of
 * them are "past".
 *
 * The only door into this history is `conversations.patient_id`. That matters
 * because the Inbox's other identifier for a thread is a phone number, and a
 * phone number is not an identity: numbers get reassigned, families share
 * handsets, a spouse messages from the patient's phone, and two records can
 * carry the same digits in different formats. Resolving history by phone would
 * make any of those show one person another person's visits.
 *
 * So the fakes below are not stubs that return a fixed list — they apply the
 * filters the action actually sends to a table holding *two* patients'
 * appointments, and the conversation lookup goes through the real
 * `authorizeAccountScopedConversation` against a fake `conversations` table
 * carrying real `whatsapp_account_id` values. If the action ever stopped
 * scoping by `patient_id`, started scoping by phone, or stopped proving the
 * clinic and the WhatsApp account, these tests would say so.
 */

type Filter = [string, string, unknown];

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  /**
   * The clinic's WhatsApp account boundary. It replaced the old
   * provider + live-session pair deliberately: the boundary is identity state,
   * so a disconnected linked device must resolve to the *same* account and not
   * to the legacy NULL scope. The assertions below are unchanged — only where
   * the account fact comes from is.
   */
  boundary: vi.fn(),
  queries: [] as { table: string; filters: [string, string, unknown][] }[],
  adminQueries: [] as { table: string; filters: [string, string, unknown][] }[],
  /**
   * Tables whose reads fail rather than return rows. A database failure and an
   * empty result are different answers and the action must not conflate them.
   */
  failingTables: new Set<string>(),
}));

vi.mock("@/lib/i18n/action-errors", () => ({
  actionError: (key: string) => Promise.resolve(key),
}));
vi.mock("@/lib/rbac", () => ({
  requireRole: mocks.requireRole,
  requireMutationRole: vi.fn(),
}));
vi.mock("@/lib/messaging/account-boundary", () => ({
  resolveWhatsAppAccountBoundary: mocks.boundary,
  boundaryFailsClosed: (value: { account: string | null; required: boolean }) =>
    value.required && value.account === null,
  LEGACY_ACCOUNT_BOUNDARY: { account: null, required: false },
}));

const CLINIC = "clinic-1";
const ACCOUNT = "+201234567890";
const OTHER_ACCOUNT = "+209999999999";
const PATIENT_A = "11111111-1111-4111-8111-111111111111";
const PATIENT_B = "22222222-2222-4222-8222-222222222222";
const PATIENT_C = "33333333-3333-4333-8333-333333333333";
const CONVERSATION_A = "aaaaaaaa-1111-4111-8111-111111111111";
const CONVERSATION_B = "bbbbbbbb-2222-4222-8222-222222222222";
const CONVERSATION_C = "cccccccc-4444-4444-8444-444444444444";
const UNLINKED = "cccccccc-3333-4333-8333-333333333333";
/** Same clinic, same shape, but bound to a WhatsApp account nobody is on. */
const CONVERSATION_OTHER_ACCOUNT = "dddddddd-5555-4555-8555-555555555555";

/**
 * Two patients whose phone numbers are as confusable as they get: the same
 * digits, written the two ways this product actually stores them. Nothing in
 * the action may use either.
 */
const SHARED_PHONE = "+201111111111";

/** Fixed clock, so "past" and "future" are facts and not today's weather. */
const NOW = new Date("2026-09-03T12:00:00.000Z");

const tables: Record<string, Record<string, unknown>[]> = {
  conversations: [
    {
      id: CONVERSATION_A,
      clinic_id: CLINIC,
      patient_id: PATIENT_A,
      channel: "whatsapp",
      whatsapp_account_id: ACCOUNT,
    },
    {
      id: CONVERSATION_B,
      clinic_id: CLINIC,
      patient_id: PATIENT_B,
      channel: "whatsapp",
      whatsapp_account_id: ACCOUNT,
    },
    {
      id: CONVERSATION_C,
      clinic_id: CLINIC,
      patient_id: PATIENT_C,
      channel: "whatsapp",
      whatsapp_account_id: ACCOUNT,
    },
    {
      id: UNLINKED,
      clinic_id: CLINIC,
      patient_id: null,
      channel: "whatsapp",
      whatsapp_account_id: ACCOUNT,
    },
    {
      id: CONVERSATION_OTHER_ACCOUNT,
      clinic_id: CLINIC,
      patient_id: PATIENT_A,
      channel: "whatsapp",
      whatsapp_account_id: OTHER_ACCOUNT,
    },
  ],
  patients: [
    {
      id: PATIENT_A,
      clinic_id: CLINIC,
      full_name: "Patient A",
      phone: SHARED_PHONE,
      file_number: "A-1",
      national_id: null,
      department_id: "department-1",
    },
    {
      id: PATIENT_B,
      clinic_id: CLINIC,
      full_name: "Patient B",
      phone: "00201111111111",
      file_number: "B-1",
      national_id: null,
      department_id: "department-1",
    },
    {
      id: PATIENT_C,
      clinic_id: CLINIC,
      full_name: "Patient C",
      phone: "+201222222222",
      file_number: "C-1",
      national_id: null,
      department_id: "department-1",
    },
  ],
  appointments: [
    appointmentRow("appointment-a1", PATIENT_A, "2026-08-10T09:00:00.000Z"),
    appointmentRow("appointment-a2", PATIENT_A, "2026-07-01T09:00:00.000Z"),
    appointmentRow("appointment-b1", PATIENT_B, "2026-08-11T09:00:00.000Z"),
    {
      ...appointmentRow("appointment-a-deleted", PATIENT_A, "2026-06-01T09:00:00.000Z"),
      deleted_at: "2026-06-02T09:00:00.000Z",
    },
    // Past-dated and still `pending`: an overdue pending appointment, which the
    // lifecycle deliberately leaves at `pending` until a human closes it.
    {
      ...appointmentRow("appointment-a-past-pending", PATIENT_A, "2026-08-20T09:00:00.000Z"),
      status: "pending",
    },
    // Booked, not yet happened. Not history under any status.
    {
      ...appointmentRow("appointment-a-future-pending", PATIENT_A, "2026-10-01T09:00:00.000Z"),
      status: "pending",
    },
    // Started half an hour ago and runs for an hour: the patient is in the
    // chair right now, so the slot is not over.
    {
      ...appointmentRow("appointment-a-in-progress", PATIENT_A, "2026-09-03T11:30:00.000Z"),
      status: "in_session",
    },
    // Patient C has been booked and has never been seen.
    {
      ...appointmentRow("appointment-c-future", PATIENT_C, "2026-09-20T09:00:00.000Z"),
      status: "pending",
    },
  ],
};

function appointmentRow(id: string, patientId: string, scheduledAt: string) {
  return {
    id,
    clinic_id: CLINIC,
    patient_id: patientId,
    scheduled_at: scheduledAt,
    duration_minutes: 60,
    status: "completed",
    doctor_id: "doctor-1",
    department_id: "department-1",
    paid_at: null,
    total_amount: 500,
    payment_note: null,
    deleted_at: null,
    profiles: { full_name: "Dr Salma Nabil" },
    departments: { name: "Dermatology", color: "#10b981" },
    follow_ups: [] as unknown[],
  };
}

/** What PostgREST hands back when the read itself fails. */
const READ_FAILURE = { code: "57014", message: "canceling statement due to statement timeout" };

function matches(row: Record<string, unknown>, filters: Filter[]): boolean {
  return filters.every(([kind, column, value]) => {
    if (kind === "eq") return row[column] === value;
    if (kind === "is") return row[column] === value;
    if (kind === "lt") return String(row[column]) < String(value);
    return true;
  });
}

function fakeClient(log: { table: string; filters: Filter[] }[]) {
  return {
    from(table: string) {
      const filters: Filter[] = [];
      let limit = Infinity;
      let sort: { column: string; ascending: boolean } | null = null;
      const record = () => log.push({ table, filters: [...filters] });
      const rows = () => {
        record();
        const selected = (tables[table] ?? []).filter((row) => matches(row, filters));
        if (sort) {
          const { column, ascending } = sort;
          selected.sort((a, b) => {
            const left = String(a[column]);
            const right = String(b[column]);
            return (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1);
          });
        }
        return selected.slice(0, limit);
      };
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters.push(["eq", column, value]);
          return chain;
        },
        is: (column: string, value: unknown) => {
          filters.push(["is", column, value]);
          return chain;
        },
        lt: (column: string, value: unknown) => {
          filters.push(["lt", column, value]);
          return chain;
        },
        order: (column: string, options?: { ascending?: boolean }) => {
          sort = { column, ascending: options?.ascending !== false };
          return chain;
        },
        limit: (value: number) => {
          limit = value;
          return chain;
        },
        maybeSingle: () =>
          mocks.failingTables.has(table)
            ? Promise.resolve({ data: null, error: READ_FAILURE })
            : Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          (mocks.failingTables.has(table)
            ? Promise.resolve({ data: null, error: READ_FAILURE })
            : Promise.resolve({ data: rows(), error: null })
          ).then(resolve),
      };
      return chain;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => fakeClient(mocks.queries),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => fakeClient(mocks.adminQueries),
}));

import { listConversationPatientAppointments } from "@/actions/inbox-patient-appointments";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.queries = [];
  mocks.adminQueries = [];
  mocks.failingTables = new Set<string>();
  mocks.boundary.mockResolvedValue({ account: ACCOUNT, required: true });
  mocks.requireRole.mockResolvedValue({
    id: "receptionist-1",
    clinicId: CLINIC,
    role: "receptionist",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("P12 · the conversation is found through its account scope, not through RLS", () => {
  it("finds a conversation on the clinic's current linked account", async () => {
    const result = await listConversationPatientAppointments({
      conversationId: CONVERSATION_A,
    });

    expect(result.error).toBeUndefined();
    expect(result.patient?.id).toBe(PATIENT_A);
    // The proof is a clinic- and account-scoped read, never an authenticated
    // `conversations` read: `whatsapp_account_isolation_conversations` probes
    // `clinic_channels`, which is deny-all for staff, so an RLS read of a
    // live linked-account thread comes back empty and the panel reported the
    // visible conversation as missing.
    const authorization = mocks.adminQueries.find((query) => query.table === "conversations");
    expect(authorization?.filters).toEqual(
      expect.arrayContaining([
        ["eq", "clinic_id", CLINIC],
        ["eq", "id", CONVERSATION_A],
        ["eq", "channel", "whatsapp"],
        ["eq", "whatsapp_account_id", ACCOUNT],
      ]),
    );
    expect(mocks.queries.some((query) => query.table === "conversations")).toBe(false);
  });

  it("rejects a conversation belonging to another clinic", async () => {
    mocks.requireRole.mockResolvedValue({
      id: "receptionist-2",
      clinicId: "clinic-2",
      role: "receptionist",
    });

    const result = await listConversationPatientAppointments({
      conversationId: CONVERSATION_A,
    });

    expect(result.error).toBe("messaging.conversationNotFound");
    expect(result.appointments).toBeUndefined();
    expect(mocks.queries.some((query) => query.table === "appointments")).toBe(false);
  });

  it("rejects a conversation bound to a WhatsApp account that is not the current one", async () => {
    const result = await listConversationPatientAppointments({
      conversationId: CONVERSATION_OTHER_ACCOUNT,
    });

    expect(result.error).toBe("messaging.conversationNotFound");
    expect(result.appointments).toBeUndefined();
  });

  it("fails closed when a linked channel has no proved account identity", async () => {
    mocks.boundary.mockResolvedValue({ account: null, required: true });

    const result = await listConversationPatientAppointments({
      conversationId: CONVERSATION_A,
    });

    expect(result.error).toBe("messaging.conversationNotFound");
    expect(mocks.adminQueries.some((query) => query.table === "conversations")).toBe(false);
  });

  it("reads the legacy NULL scope when no device is linked", async () => {
    mocks.boundary.mockResolvedValue({ account: null, required: false });

    await listConversationPatientAppointments({ conversationId: CONVERSATION_A });

    const authorization = mocks.adminQueries.find((query) => query.table === "conversations");
    expect(authorization?.filters).toEqual(
      expect.arrayContaining([["is", "whatsapp_account_id", null]]),
    );
  });
});

describe("P12 · past appointments are scoped to the conversation's linked patient", () => {
  it("returns that patient's appointments and only that patient's", async () => {
    const result = await listConversationPatientAppointments({
      conversationId: CONVERSATION_A,
    });

    expect(result.error).toBeUndefined();
    expect(result.patient?.id).toBe(PATIENT_A);
    expect(result.appointments?.map((row) => row.id)).toEqual([
      "appointment-a-past-pending",
      "appointment-a1",
      "appointment-a2",
    ]);
  });

  it("cannot leak a second patient in on a confusable phone number", async () => {
    const result = await listConversationPatientAppointments({
      conversationId: CONVERSATION_A,
    });

    // Patient B is in the same clinic and carries the same digits as A.
    expect(result.appointments?.some((row) => row.id === "appointment-b1")).toBe(false);
    // And the reason is structural: the appointments read is filtered by the
    // patient the conversation is linked to, and by nothing else that could
    // resolve to a person.
    const appointments = mocks.queries.find((query) => query.table === "appointments");
    expect(appointments?.filters).toEqual(
      expect.arrayContaining([
        ["eq", "clinic_id", CLINIC],
        ["eq", "patient_id", PATIENT_A],
        ["is", "deleted_at", null],
      ]),
    );
  });

  it("never reads or filters by a phone number anywhere in the flow", async () => {
    await listConversationPatientAppointments({ conversationId: CONVERSATION_A });

    for (const query of [...mocks.queries, ...mocks.adminQueries]) {
      for (const [, column, value] of query.filters) {
        expect(column).not.toMatch(/phone/i);
        expect(String(value)).not.toContain("201111111111");
      }
    }
  });

  it("switches history with the conversation, with no fallback between them", async () => {
    const a = await listConversationPatientAppointments({ conversationId: CONVERSATION_A });
    const b = await listConversationPatientAppointments({ conversationId: CONVERSATION_B });

    expect(a.patient?.id).toBe(PATIENT_A);
    expect(a.appointments?.some((row) => row.id === "appointment-b1")).toBe(false);
    expect(b.patient?.id).toBe(PATIENT_B);
    expect(b.appointments?.map((row) => row.id)).toEqual(["appointment-b1"]);
  });

  it("refuses an unlinked new contact rather than guessing a patient", async () => {
    const result = await listConversationPatientAppointments({ conversationId: UNLINKED });

    expect(result.error).toBe("messaging.conversationNotLinked");
    expect(result.appointments).toBeUndefined();
    // It stopped at the conversation. No patient and no appointment read ever
    // happened, so there was nothing to fall back to.
    expect(mocks.queries).toEqual([]);
  });

  it("leaves deleted appointments out of the history", async () => {
    const result = await listConversationPatientAppointments({
      conversationId: CONVERSATION_A,
    });
    expect(result.appointments?.some((row) => row.id === "appointment-a-deleted")).toBe(
      false,
    );
  });

  it("is closed to roles that cannot open the Inbox at all", async () => {
    await listConversationPatientAppointments({ conversationId: CONVERSATION_A });
    expect(mocks.requireRole).toHaveBeenCalledWith(["admin", "receptionist"]);
  });
});

/**
 * What "past" means, stated once and asserted here rather than left to whoever
 * reads the panel's title.
 */
describe("P12 · what qualifies as a past appointment", () => {
  it("includes a completed visit and offers its follow-up", async () => {
    const result = await listConversationPatientAppointments({
      conversationId: CONVERSATION_A,
    });

    const completed = result.appointments?.find((row) => row.id === "appointment-a1");
    expect(completed?.status).toBe("completed");
    expect(completed?.followup).toBeNull();
    expect(completed?.followupPending).toBe(true);
  });

  it("excludes an appointment that has not happened yet, pending or otherwise", async () => {
    const result = await listConversationPatientAppointments({
      conversationId: CONVERSATION_A,
    });

    expect(
      result.appointments?.some((row) => row.id === "appointment-a-future-pending"),
    ).toBe(false);
    // And it is excluded in the database, not only in the mapping: a patient
    // with years of future bookings must not spend the panel's 25-row budget
    // on them.
    const appointments = mocks.queries.find((query) => query.table === "appointments");
    expect(appointments?.filters).toEqual(
      expect.arrayContaining([["lt", "scheduled_at", NOW.toISOString()]]),
    );
  });

  it("excludes an appointment that is still running", async () => {
    const result = await listConversationPatientAppointments({
      conversationId: CONVERSATION_A,
    });

    // Started at 11:30 for 60 minutes; at 12:00 the slot is not over.
    expect(result.appointments?.some((row) => row.id === "appointment-a-in-progress")).toBe(
      false,
    );
  });

  /**
   * The authoritative lifecycle keeps a booking at `pending` after its slot has
   * gone by — `isOverduePending` is built on exactly that, and the dashboard
   * lists those rows as still owing the clinic a decision. So the status says
   * nothing about whether the date has passed, and the panel shows the row,
   * carrying its real `pending` badge.
   */
  it("includes a past-dated pending appointment, still labelled pending", async () => {
    const result = await listConversationPatientAppointments({
      conversationId: CONVERSATION_A,
    });

    const overdue = result.appointments?.find(
      (row) => row.id === "appointment-a-past-pending",
    );
    expect(overdue).toBeDefined();
    expect(overdue?.status).toBe("pending");
    // It is not a visit that happened, so it is not a visit anyone can be
    // called about: the follow-up offer stays with `completed`, exactly as
    // `get_followups_dashboard` scopes it.
    expect(overdue?.followupPending).toBe(false);
  });

  it("returns an empty history — not an error — when nothing has happened yet", async () => {
    const result = await listConversationPatientAppointments({
      conversationId: CONVERSATION_C,
    });

    expect(result.error).toBeUndefined();
    expect(result.patient?.id).toBe(PATIENT_C);
    expect(result.appointments).toEqual([]);
  });

  /**
   * Two different failures had one message, and it was the wrong one for both.
   *
   * "Conversation not found" is a statement about the thread, and staff read it
   * that way: they went looking for a conversation that was open on the screen
   * in front of them. It is only true when the ownership proof refuses. Once
   * that proof has passed, the conversation demonstrably exists and belongs to
   * this clinic and this WhatsApp account — so a failure in the *appointment or
   * patient* read is a database failure, and has to say so, or the real fault
   * stays invisible behind a data-shaped answer.
   */
  describe("failure reporting", () => {
    it("reports a conversation the account scope refuses as not found", async () => {
      const result = await listConversationPatientAppointments({
        conversationId: CONVERSATION_OTHER_ACCOUNT,
      });

      expect(result.error).toBe("messaging.conversationNotFound");
      // Nothing beyond the conversation was ever read.
      expect(mocks.queries).toEqual([]);
    });

    it("reports a failed appointments read as a loading error, not a missing thread", async () => {
      mocks.failingTables.add("appointments");

      const result = await listConversationPatientAppointments({
        conversationId: CONVERSATION_A,
      });

      expect(result.error).toBe("messaging.patientHistoryUnavailable");
      expect(result.error).not.toBe("messaging.conversationNotFound");
      expect(result.appointments).toBeUndefined();
    });

    it("reports a failed patient read as a loading error, not a missing thread", async () => {
      mocks.failingTables.add("patients");

      const result = await listConversationPatientAppointments({
        conversationId: CONVERSATION_A,
      });

      expect(result.error).toBe("messaging.patientHistoryUnavailable");
      expect(result.error).not.toBe("messaging.conversationNotFound");
      expect(result.patient).toBeUndefined();
    });

    it("still separates the two when both reads fail at once", async () => {
      mocks.failingTables.add("patients");
      mocks.failingTables.add("appointments");

      const result = await listConversationPatientAppointments({
        conversationId: CONVERSATION_A,
      });

      expect(result.error).toBe("messaging.patientHistoryUnavailable");
    });

    it("keeps the not-found message for the case that genuinely means it", async () => {
      // Another clinic's conversation id: the ownership proof, not the data
      // read, is what refuses — so the thread-shaped message is the true one.
      const result = await listConversationPatientAppointments({
        conversationId: "eeeeeeee-6666-4666-8666-666666666666",
      });

      expect(result.error).toBe("messaging.conversationNotFound");
    });
  });
});
