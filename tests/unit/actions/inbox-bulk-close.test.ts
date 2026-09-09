import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Close all open conversations" — the server half.
 *
 * The properties under test are the ones that make a bulk lifecycle action
 * safe to give an admin a button for:
 *
 *   * `open` means `conversations.status = 'open'` and nothing else. No new
 *     status is invented and the visible badge registry is not consulted.
 *   * a row that is already closed is never selected, so it is never rewritten.
 *   * every close goes through the *same* path a single Close goes through,
 *     including the assistant-state reset — a bulk `update ... where status =
 *     'open'` would close the rows and reset none of them.
 *   * a partial failure is reported as a partial failure.
 *   * the count the modal shows comes from the same query the action closes.
 */

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  requireMutationRole: vi.fn(),
  requireRole: vi.fn(),
  revalidatePath: vi.fn(),
  logMessagingEvent: vi.fn(),
  reset: vi.fn(),
  resolveBoundary: vi.fn(),
  state: {
    conversations: [] as Row[],
    /** Ids whose update is made to fail, to exercise the partial path. */
    failing: new Set<string>(),
    /** Every filter a select ran with, so scoping can be asserted. */
    selectFilters: [] as Array<Array<[string, unknown]>>,
    /** Every conversation id an update was actually attempted for. */
    attempts: [] as string[],
    /** After this many selects, reads start failing. `null` disables it. */
    readFailsAfter: null as number | null,
    updates: [] as Array<{ id: unknown; payload: Row }>,
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/i18n/action-errors", () => ({ actionError: (key: string) => Promise.resolve(key) }));
vi.mock("@/lib/rbac", () => ({
  requireMutationRole: mocks.requireMutationRole,
  requireRole: mocks.requireRole,
}));
vi.mock("@/lib/ai/conversation-reset", () => ({
  resetConversationAssistantState: mocks.reset,
}));
vi.mock("@/lib/messaging/account-boundary", () => ({
  boundaryFailsClosed: (boundary: { required: boolean; account: string | null }) =>
    boundary.required && boundary.account === null,
  resolveWhatsAppAccountBoundary: mocks.resolveBoundary,
}));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: vi.fn() }));
vi.mock("@/lib/entitlements", () => ({ getEntitlements: vi.fn(), hasFeature: vi.fn() }));
vi.mock("@/lib/ai/booking-stage-store", () => ({ clearBookingStageEscalation: vi.fn() }));
vi.mock("@/lib/messaging/channel-management", () => ({
  connectDialog360Channel: vi.fn(),
  getActiveWhatsAppProvider: vi.fn(),
  getCurrentLinkedWhatsAppAccount: vi.fn(),
  getWhatsAppChannelStatus: vi.fn(),
}));
vi.mock("@/lib/messaging/crypto", () => ({ decryptChannelCredentials: vi.fn() }));
vi.mock("@/lib/messaging/whatsapp-dialog360", () => ({
  deleteDialog360Template: vi.fn(),
  submitDialog360Template: vi.fn(),
}));
vi.mock("@/lib/messaging/whatsapp-meta", () => ({ submitMetaTemplate: vi.fn() }));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: vi.fn(), buildBodyPreview: vi.fn() }));
vi.mock("@/lib/messaging/outbound-media-diagnostics", () => ({
  logOutboundMediaDiagnostic: vi.fn(),
}));
vi.mock("@/lib/messaging/inbox-contacts", () => ({
  EMPTY_CONTACT_DIRECTORY: {},
  loadInboxContactDirectory: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  logMessagingEvent: mocks.logMessagingEvent,
  setInboxConversationPatient: vi.fn(),
  setConversationAiOverride: vi.fn(),
  setConversationAiPause: vi.fn(),
  openWhatsAppConversation: vi.fn(),
  openLinkedDeviceConversation: vi.fn(),
  claimOutboundMedia: vi.fn(),
  finalizeOutboundMedia: vi.fn(),
  holdOutboundMedia: vi.fn(),
  releaseOutboundMedia: vi.fn(),
  removeOutboundMedia: vi.fn(),
  uploadOutboundMedia: vi.fn(),
  isSendableStoragePath: () => true,
  WHATSAPP_OUTBOUND_BUCKET: "whatsapp-outbound",
  createClinicScopedAdminClient: () => ({
    /**
     * A small stand-in for PostgREST that is honest about the two things this
     * action depends on: `head: true` returns an exact *count* of the whole
     * eligible set, and `range()` returns a window of it. Rows are read live
     * from `mocks.state.conversations`, so a row this action closes genuinely
     * leaves the `status = 'open'` set — which is the mechanism the paging
     * loop relies on to make progress.
     */
    from: (table: string) => {
      let op: "select" | "update" = "select";
      let payload: Row = {};
      let head = false;
      let range: [number, number] | null = null;
      const filters: Array<[string, unknown]> = [];
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = (_columns?: unknown, options?: { head?: boolean }) => {
        head = options?.head === true;
        return chain;
      };
      chain.order = self;
      chain.limit = self;
      chain.range = (from: number, to: number) => {
        range = [from, to];
        return chain;
      };
      chain.is = (column: unknown, value: unknown) => {
        filters.push([String(column), value]);
        return chain;
      };
      chain.eq = (column: unknown, value: unknown) => {
        filters.push([String(column), value]);
        return chain;
      };
      chain.update = (next: Row) => {
        op = "update";
        payload = next;
        return chain;
      };
      const settle = (single: boolean) => {
        if (table !== "conversations") return { data: single ? null : [], error: null };
        if (op === "select") {
          mocks.state.selectFilters.push([...filters]);
          if (mocks.state.readFailsAfter !== null
              && mocks.state.selectFilters.length > mocks.state.readFailsAfter) {
            return { data: null, count: null, error: { message: "read failed" } };
          }
          const matched = mocks.state.conversations.filter((row) =>
            filters.every(([column, value]) => row[column] === value),
          );
          if (head) return { data: null, count: matched.length, error: null };
          const window = range ? matched.slice(range[0], range[1] + 1) : matched;
          return { data: window.map((row) => ({ id: row.id })), error: null };
        }
        const id = filters.find(([column]) => column === "id")?.[1];
        if (mocks.state.failing.has(String(id))) {
          mocks.state.attempts.push(String(id));
          return { data: null, error: { message: "update failed" } };
        }
        const row = mocks.state.conversations.find((candidate) => candidate.id === id);
        if (!row) return { data: null, error: null };
        mocks.state.attempts.push(String(id));
        Object.assign(row, payload);
        mocks.state.updates.push({ id, payload });
        return { data: { id }, error: null };
      };
      chain.maybeSingle = () => Promise.resolve(settle(true));
      chain.then = (onF: (value: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(settle(false)).then(onF, onR);
      return chain;
    },
  }),
}));

import { closeOpenConversations, countOpenConversations } from "@/actions/messaging";

const ADMIN = { id: "admin-1", clinicId: "clinic-1", role: "admin" };

function conversations() {
  return [
    { id: "c-open-1", status: "open", channel: "whatsapp", whatsapp_account_id: "acct" },
    { id: "c-open-2", status: "open", channel: "whatsapp", whatsapp_account_id: "acct" },
    { id: "c-closed", status: "closed", channel: "whatsapp", whatsapp_account_id: "acct" },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.conversations = conversations();
  mocks.state.failing = new Set();
  mocks.state.selectFilters = [];
  mocks.state.attempts = [];
  mocks.state.readFailsAfter = null;
  mocks.state.updates = [];
  mocks.requireMutationRole.mockResolvedValue(ADMIN);
  mocks.requireRole.mockResolvedValue(ADMIN);
  mocks.resolveBoundary.mockResolvedValue({ account: "acct", required: true });
  mocks.reset.mockResolvedValue({ ok: true, supersededSuggestions: 0 });
  mocks.logMessagingEvent.mockResolvedValue({ error: null });
});

describe("counting what would be affected", () => {
  it("counts only rows whose status is open", async () => {
    await expect(countOpenConversations()).resolves.toEqual({ total: 2 });
  });

  it("counts inside the clinic's proved WhatsApp account boundary", async () => {
    await countOpenConversations();
    const filters = mocks.state.selectFilters[0]!;
    expect(filters).toContainEqual(["status", "open"]);
    expect(filters).toContainEqual(["channel", "whatsapp"]);
    expect(filters).toContainEqual(["whatsapp_account_id", "acct"]);
  });

  it("refuses rather than counting the legacy scope while a pairing is unproved", async () => {
    mocks.resolveBoundary.mockResolvedValue({ account: null, required: true });
    const result = await countOpenConversations();
    expect(result.error).toBe("messaging.couldNotReadOpenConversations");
    expect(result.total).toBeUndefined();
  });

  it("is admin-only", async () => {
    await countOpenConversations();
    expect(mocks.requireRole).toHaveBeenCalledWith(["admin"]);
  });
});

describe("closing every open conversation", () => {
  it("closes exactly the open ones and leaves the closed one untouched", async () => {
    const result = await closeOpenConversations();
    expect(result).toEqual({ total: 2, closed: 2, failed: 0 });
    expect(mocks.state.updates.map((update) => update.id).sort()).toEqual([
      "c-open-1",
      "c-open-2",
    ]);
    // Not rewritten, so its status timestamp did not move either.
    expect(mocks.state.conversations.find((row) => row.id === "c-closed")).toMatchObject({
      status: "closed",
    });
  });

  it("writes the same columns a single Close writes", async () => {
    await closeOpenConversations();
    for (const update of mocks.state.updates) {
      expect(update.payload.status).toBe("closed");
      expect(typeof update.payload.status_updated_at).toBe("string");
    }
  });

  it("runs the assistant-state reset for every conversation it closes", async () => {
    await closeOpenConversations();
    expect(mocks.reset).toHaveBeenCalledTimes(2);
    expect(mocks.reset).toHaveBeenCalledWith({
      clinicId: "clinic-1",
      conversationId: "c-open-1",
      reason: "manual_close",
    });
  });

  it("reports a partial failure honestly rather than as a success", async () => {
    mocks.state.failing = new Set(["c-open-2"]);
    const result = await closeOpenConversations();
    expect(result).toEqual({ total: 2, closed: 1, failed: 1 });
    expect(mocks.reset).toHaveBeenCalledTimes(1);
  });

  it("does nothing, and says so, when nothing is open", async () => {
    mocks.state.conversations = [
      { id: "c-closed", status: "closed", channel: "whatsapp", whatsapp_account_id: "acct" },
    ];
    await expect(closeOpenConversations()).resolves.toEqual({
      total: 0,
      closed: 0,
      failed: 0,
    });
    expect(mocks.state.updates).toHaveLength(0);
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it("is admin-only and revalidates the Inbox", async () => {
    await closeOpenConversations();
    expect(mocks.requireMutationRole).toHaveBeenCalledWith(["admin"]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/inbox");
  });

  /**
   * The ceiling regression.
   *
   * An earlier draft read one page of 300 open rows, closed those and returned
   * `{ total: 300, closed: 300 }` — so a clinic with 450 open threads was told
   * everything was closed while 150 stayed open. "Close all open
   * conversations" has to mean all of them.
   */
  it("closes every open conversation, well past any single page", async () => {
    mocks.state.conversations = Array.from({ length: 450 }, (_, index) => ({
      id: `c-${String(index).padStart(3, "0")}`,
      status: "open",
      channel: "whatsapp",
      whatsapp_account_id: "acct",
    }));

    const result = await closeOpenConversations();

    expect(result).toEqual({ total: 450, closed: 450, failed: 0 });
    expect(mocks.state.updates).toHaveLength(450);
    expect(mocks.reset).toHaveBeenCalledTimes(450);
    // Not "the first 300": the last row of the set was reached too.
    expect(mocks.state.conversations.every((row) => row.status === "closed")).toBe(true);
    expect(new Set(mocks.state.updates.map((update) => update.id)).size).toBe(450);
  });

  it("does not touch already-closed rows in a large mixed set", async () => {
    mocks.state.conversations = Array.from({ length: 500 }, (_, index) => ({
      id: `c-${String(index).padStart(3, "0")}`,
      // Every fifth row is already finished and must be left exactly as it is.
      status: index % 5 === 0 ? "closed" : "open",
      channel: "whatsapp",
      whatsapp_account_id: "acct",
    }));

    const result = await closeOpenConversations();

    expect(result).toEqual({ total: 400, closed: 400, failed: 0 });
    expect(mocks.state.updates).toHaveLength(400);
    for (const update of mocks.state.updates) {
      expect(String(update.id).endsWith("0")).toBe(false);
      expect(String(update.id).endsWith("5")).toBe(false);
    }
  });

  /**
   * A row that cannot be closed stays `open`, so it stays in the eligible set
   * and would be selected again forever. The loop has to make progress past it
   * without retrying it, and without ever losing the rows behind it.
   */
  it("attempts a failing row once and still closes everything after it", async () => {
    mocks.state.conversations = Array.from({ length: 350 }, (_, index) => ({
      id: `c-${String(index).padStart(3, "0")}`,
      status: "open",
      channel: "whatsapp",
      whatsapp_account_id: "acct",
    }));
    // One in the first page and one deep in the set, so the skip window has to
    // step over failures in more than one place.
    mocks.state.failing = new Set(["c-007", "c-311"]);

    const result = await closeOpenConversations();

    expect(result).toEqual({ total: 350, closed: 348, failed: 2 });
    // Attempted exactly once each: no spin, no repeated writes.
    expect(mocks.state.attempts.filter((id) => id === "c-007")).toHaveLength(1);
    expect(mocks.state.attempts.filter((id) => id === "c-311")).toHaveLength(1);
    // And the failures did not shield the rows behind them.
    const stillOpen = mocks.state.conversations.filter((row) => row.status === "open");
    expect(stillOpen.map((row) => row.id)).toEqual(["c-007", "c-311"]);
  });

  it("terminates, and reports nothing closed, when every row fails", async () => {
    mocks.state.conversations = Array.from({ length: 120 }, (_, index) => ({
      id: `c-${String(index).padStart(3, "0")}`,
      status: "open",
      channel: "whatsapp",
      whatsapp_account_id: "acct",
    }));
    mocks.state.failing = new Set(mocks.state.conversations.map((row) => String(row.id)));

    const result = await closeOpenConversations();

    expect(result).toEqual({ total: 120, closed: 0, failed: 120 });
    expect(mocks.state.attempts).toHaveLength(120);
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  /**
   * A read that fails part-way through stops the run. What closed, closed —
   * and the counts say so rather than claiming the set was finished.
   */
  it("stops on a mid-run read failure without claiming the rest were closed", async () => {
    mocks.state.conversations = Array.from({ length: 300 }, (_, index) => ({
      id: `c-${String(index).padStart(3, "0")}`,
      status: "open",
      channel: "whatsapp",
      whatsapp_account_id: "acct",
    }));
    // The head count and the first page succeed; the second page does not.
    mocks.state.readFailsAfter = 2;

    const result = await closeOpenConversations();

    expect(result.total).toBe(300);
    expect(result.closed).toBe(100);
    expect(result.failed).toBe(0);
    expect(result.closed).toBeLessThan(result.total!);
  });

  it("audits counts and the actor, never a conversation", async () => {
    await closeOpenConversations();
    expect(mocks.logMessagingEvent).toHaveBeenCalledWith({
      clinicId: "clinic-1",
      event: "conversations_bulk_closed",
      recordId: null,
      summary: { actorId: "admin-1", total: 2, closed: 2, failed: 0 },
    });
  });
});
