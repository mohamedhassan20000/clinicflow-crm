/**
 * The New Conversation directory read: account isolation and the linkage rule.
 *
 * Two properties are load-bearing and neither is visible from the UI:
 *
 *   1. **Isolation.** Contacts are read with an equality filter on the account
 *      the worker most recently bound. With no account bound the filter is kept
 *      and given a sentinel that matches nothing, because dropping it would show
 *      a re-paired clinic the *previous* phone's address book.
 *   2. **Linkage.** "Already in the clinic" is decided by the system's own
 *      authoritative signals — an existing `conversations.patient_id`, or exact
 *      E.164 equality on `patients.phone`, which is the same predicate
 *      `record_inbound_whatsapp_message` uses. No fuzzy matching is introduced.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Filter = { method: string; args: unknown[] };

const mocks = vi.hoisted(() => ({
  account: null as string | null,
  queries: [] as Array<{ table: string; filters: Filter[] }>,
  rows: {} as Record<string, { data: unknown[]; error: unknown; count?: number }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/messaging/account-boundary", () => ({
  // The directory follows the clinic's account *boundary*, which is identity
  // and survives a disconnect — not the live session it used to read.
  resolveWhatsAppAccountBoundary: async () => ({
    account: mocks.account,
    required: mocks.account !== null,
  }),
  boundaryFailsClosed: (value: { account: string | null; required: boolean }) =>
    value.required && value.account === null,
  LEGACY_ACCOUNT_BOUNDARY: { account: null, required: false },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      const record = { table, filters: [] as Filter[] };
      mocks.queries.push(record);
      const chain: Record<string, unknown> = {};
      for (const method of ["eq", "in", "is", "not", "order", "limit", "select"]) {
        chain[method] = (...args: unknown[]) => {
          record.filters.push({ method, args });
          return chain;
        };
      }
      chain.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(mocks.rows[table] ?? { data: [], error: null, count: 0 }).then(resolve);
      return chain;
    },
  }),
}));

import { loadInboxContactDirectory } from "@/lib/messaging/inbox-contacts";

const CLINIC = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "+201111111111";

function filterFor(table: string, column: string): unknown {
  const query = mocks.queries.find((item) => item.table === table);
  return query?.filters.find(
    (filter) => filter.method === "eq" && filter.args[0] === column,
  )?.args[1];
}

beforeEach(() => {
  mocks.account = ACCOUNT;
  mocks.queries.length = 0;
  mocks.rows = {
    whatsapp_contacts: {
      data: [
        { id: "c1", display_name: "Mona Ali", participant_address: "+201222222222" },
        { id: "c2", display_name: "Layla Haddad", participant_address: "+201333333333" },
        { id: "c3", display_name: null, participant_address: "+201444444444" },
      ],
      error: null,
      count: 3,
    },
    patients: {
      data: [
        {
          id: "patient-1",
          full_name: "Mona Ali",
          phone: "+201222222222",
          file_number: "CF-42",
        },
      ],
      error: null,
    },
    conversations: {
      data: [{ participant_address: "+201333333333", patient_id: "patient-2" }],
      error: null,
    },
  };
});

describe("the linked-account contact directory", () => {
  it("reads contacts scoped to the currently authenticated account", async () => {
    await loadInboxContactDirectory(CLINIC);
    expect(filterFor("whatsapp_contacts", "clinic_id")).toBe(CLINIC);
    expect(filterFor("whatsapp_contacts", "authenticated_account_id")).toBe(ACCOUNT);
    // The conversation linkage read is account-scoped for the same reason.
    expect(filterFor("conversations", "whatsapp_account_id")).toBe(ACCOUNT);
  });

  it("keeps the account filter — matching nothing — when no account is bound", async () => {
    mocks.account = null;
    mocks.rows.whatsapp_contacts = { data: [], error: null, count: 0 };
    const directory = await loadInboxContactDirectory(CLINIC);

    const filter = filterFor("whatsapp_contacts", "authenticated_account_id");
    expect(filter).toBe("__no_authenticated_account__");
    expect(filter).not.toBeUndefined();
    expect(directory.contacts).toEqual([]);
    expect(directory.accountConnected).toBe(false);
    // No account means no conversation-linkage read at all.
    expect(mocks.queries.some((query) => query.table === "conversations")).toBe(false);
  });

  it("marks a contact as clinic-linked on an exact patient phone match", async () => {
    const directory = await loadInboxContactDirectory(CLINIC);
    const mona = directory.contacts.find((contact) => contact.id === "c1")!;
    expect(mona.patientId).toBe("patient-1");
    expect(mona.patientName).toBe("Mona Ali");
    expect(mona.patientFileNumber).toBe("CF-42");
  });

  it("marks a contact as clinic-linked on an existing conversation link", async () => {
    const directory = await loadInboxContactDirectory(CLINIC);
    expect(directory.contacts.find((contact) => contact.id === "c2")?.patientId).toBe("patient-2");
  });

  it("leaves everything else unlinked rather than guessing at a patient", async () => {
    const directory = await loadInboxContactDirectory(CLINIC);
    const unknown = directory.contacts.find((contact) => contact.id === "c3")!;
    expect(unknown.patientId).toBeNull();
    expect(unknown.patientName).toBeNull();
    expect(directory.total).toBe(3);
    expect(directory.linked).toBe(2);
    expect(directory.unlinked).toBe(1);
  });

  it("reports a failed linkage read instead of relabelling patients as strangers", async () => {
    mocks.rows.patients = { data: [], error: { message: "boom" } };
    const directory = await loadInboxContactDirectory(CLINIC);
    expect(directory.error).toBe(true);
    expect(directory.contacts).toEqual([]);
  });
});
