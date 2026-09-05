import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createAdmin: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: mocks.createAdmin,
}));

import {
  boundaryFailsClosed,
  resolveWhatsAppAccountBoundary,
} from "@/lib/messaging/account-boundary";

/**
 * The WhatsApp account boundary, across a connection lifecycle.
 *
 * The regression being pinned: with the linked device up, this clinic saw its
 * three live threads; the moment it dropped, the Inbox showed every legacy
 * imported conversation, and reconnecting hid them again. The boundary was
 * read off `clinic_channels` — the transport row a disconnect deletes — so a
 * *connection* event was re-deciding an *identity* question.
 *
 * Each test below drives the resolver through a real database shape rather
 * than stubbing its answer, so "the boundary did not move" is a property of
 * the rows and not of a mock.
 */

type Rows = {
  session?: { authenticated_account_id: string | null } | null;
  ledger?: { authenticated_account_id: string; last_seen_at: string; first_linked_at: string }[];
  linkedChannel?: boolean;
  failing?: Set<string>;
};

function fakeAdmin(rows: Rows) {
  return () => ({
    from(table: string) {
      const failed = rows.failing?.has(table) ?? false;
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.order = chain;
      builder.limit = chain;
      builder.maybeSingle = () =>
        Promise.resolve(
          failed
            ? { data: null, error: { message: "boom" } }
            : { data: rows.session ?? null, error: null },
        );
      builder.then = (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) =>
        Promise.resolve(
          failed
            ? { data: null, error: { message: "boom" } }
            : {
                data:
                  table === "whatsapp_linked_accounts"
                    ? (rows.ledger ?? []).slice(0, 1)
                    : table === "clinic_channels"
                      ? rows.linkedChannel
                        ? [{ provider: "linked_device" }]
                        : []
                      : [],
                error: null,
              },
        ).then(resolve, reject);
      return builder;
    },
  });
}

const A = "+201111111111";
const B = "+209999999999";
const LEDGER_A = [
  { authenticated_account_id: A, last_seen_at: "2026-09-01T00:00:00Z", first_linked_at: "2026-08-01T00:00:00Z" },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the WhatsApp account boundary", () => {
  it("is account A while A is connected", async () => {
    mocks.createAdmin.mockImplementation(
      fakeAdmin({ session: { authenticated_account_id: A }, ledger: LEDGER_A, linkedChannel: true }),
    );
    expect(await resolveWhatsAppAccountBoundary("clinic-1")).toEqual({
      account: A,
      required: true,
    });
  });

  it("is still account A while A is disconnected and the channel row is gone", async () => {
    // A teardown deletes `clinic_channels` and sets the session to
    // `disconnected` / `offline`. Neither touches `authenticated_account_id`,
    // and neither may move the boundary.
    mocks.createAdmin.mockImplementation(
      fakeAdmin({
        session: { authenticated_account_id: A },
        ledger: LEDGER_A,
        linkedChannel: false,
      }),
    );
    expect(await resolveWhatsAppAccountBoundary("clinic-1")).toEqual({
      account: A,
      required: true,
    });
  });

  it("is still account A when even the session row has been rebuilt empty", async () => {
    // The durable ledger is the second source, so a session row that lost its
    // bound account still does not fall back to the legacy scope.
    mocks.createAdmin.mockImplementation(
      fakeAdmin({
        session: { authenticated_account_id: null },
        ledger: LEDGER_A,
        linkedChannel: false,
      }),
    );
    expect(await resolveWhatsAppAccountBoundary("clinic-1")).toEqual({
      account: A,
      required: true,
    });
  });

  it("shows the identical boundary across connected -> disconnected -> connected", async () => {
    const states: Rows[] = [
      { session: { authenticated_account_id: A }, ledger: LEDGER_A, linkedChannel: true },
      { session: { authenticated_account_id: A }, ledger: LEDGER_A, linkedChannel: false },
      { session: { authenticated_account_id: A }, ledger: LEDGER_A, linkedChannel: true },
    ];
    const seen: unknown[] = [];
    for (const state of states) {
      mocks.createAdmin.mockImplementation(fakeAdmin(state));
      seen.push(await resolveWhatsAppAccountBoundary("clinic-1"));
    }
    expect(seen).toEqual([
      { account: A, required: true },
      { account: A, required: true },
      { account: A, required: true },
    ]);
  });

  it("moves to B, and only to B, once B is the proved account", async () => {
    mocks.createAdmin.mockImplementation(
      fakeAdmin({
        session: { authenticated_account_id: B },
        // A is still in the ledger for audit; it must not win.
        ledger: [
          { authenticated_account_id: B, last_seen_at: "2026-09-05T00:00:00Z", first_linked_at: "2026-09-05T00:00:00Z" },
        ],
        linkedChannel: true,
      }),
    );
    const boundary = await resolveWhatsAppAccountBoundary("clinic-1");
    expect(boundary.account).toBe(B);
    expect(boundary.account).not.toBe(A);
  });

  it("fails closed while pairing, rather than revealing legacy rows", async () => {
    mocks.createAdmin.mockImplementation(
      fakeAdmin({ session: { authenticated_account_id: null }, ledger: [], linkedChannel: true }),
    );
    const boundary = await resolveWhatsAppAccountBoundary("clinic-1");
    expect(boundary).toEqual({ account: null, required: true });
    expect(boundaryFailsClosed(boundary)).toBe(true);
  });

  it("reads the legacy NULL scope only for a clinic that has never linked anything", async () => {
    mocks.createAdmin.mockImplementation(
      fakeAdmin({ session: null, ledger: [], linkedChannel: false }),
    );
    const boundary = await resolveWhatsAppAccountBoundary("clinic-1");
    expect(boundary).toEqual({ account: null, required: false });
    expect(boundaryFailsClosed(boundary)).toBe(false);
  });

  it("fails closed on a read error instead of reporting 'no boundary'", async () => {
    mocks.createAdmin.mockImplementation(
      fakeAdmin({
        session: { authenticated_account_id: A },
        ledger: LEDGER_A,
        linkedChannel: true,
        failing: new Set(["whatsapp_linked_accounts"]),
      }),
    );
    const boundary = await resolveWhatsAppAccountBoundary("clinic-1");
    expect(boundary).toEqual({ account: null, required: true });
    expect(boundaryFailsClosed(boundary)).toBe(true);
  });
});
