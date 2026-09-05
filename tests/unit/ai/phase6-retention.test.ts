import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ purgeAiRetentionData: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  purgeAiRetentionData: mocks.purgeAiRetentionData,
}));

import {
  AI_ACTION_CONFIRMATION_RETENTION_DAYS,
  AI_ACTION_RECEIPT_RETENTION_DAYS,
  AI_MESSAGE_RETENTION_DAYS,
  AI_RETENTION_BATCH_LIMIT,
  drainExpiredAiData,
  purgeExpiredAiData,
} from "@/lib/ai/retention";

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20260814130000_ai_assistant_phase6_retention.sql"),
  "utf8",
);
/** P6-04 — the scrub step. Supersedes the function created by MIGRATION. */
const SCRUB_MIGRATION = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260814150000_ai_assistant_phase6_retention_scrub.sql",
  ),
  "utf8",
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.purgeAiRetentionData.mockResolvedValue({
    data: [
      {
        deleted_messages: 3,
        deleted_receipts: 1,
        deleted_confirmations: 7,
        scrubbed_conversations: 2,
      },
    ],
    error: null,
  });
});

describe("Phase 6 retention policy", () => {
  it("expresses each window as exactly one named constant", () => {
    expect(AI_MESSAGE_RETENTION_DAYS).toBe(180);
    expect(AI_ACTION_RECEIPT_RETENTION_DAYS).toBe(400);
    expect(AI_ACTION_CONFIRMATION_RETENTION_DAYS).toBe(30);
    expect(AI_RETENTION_BATCH_LIMIT).toBe(10_000);
  });

  it("keeps the accountability ledger strictly longer than the transcript", () => {
    // A receipt explains a write; it must outlive the conversation text that
    // produced it, and the SQL refuses the inverse configuration outright.
    expect(AI_ACTION_RECEIPT_RETENTION_DAYS).toBeGreaterThan(AI_MESSAGE_RETENTION_DAYS);
    expect(MIGRATION).toContain(
      "AI receipt retention must not be shorter than message retention",
    );
  });

  it("passes the constants to the purge instead of hard-coding them in SQL", async () => {
    const result = await purgeExpiredAiData(new Date("2026-08-14T12:00:00.000Z"));
    expect(mocks.purgeAiRetentionData).toHaveBeenCalledWith({
      messageRetentionDays: AI_MESSAGE_RETENTION_DAYS,
      receiptRetentionDays: AI_ACTION_RECEIPT_RETENTION_DAYS,
      confirmationRetentionDays: AI_ACTION_CONFIRMATION_RETENTION_DAYS,
      batchLimit: AI_RETENTION_BATCH_LIMIT,
      now: "2026-08-14T12:00:00.000Z",
    });
    expect(result).toEqual({
      deletedMessages: 3,
      deletedReceipts: 1,
      deletedConfirmations: 7,
      scrubbedConversations: 2,
    });
    // No literal day count survives in either migration body.
    expect(MIGRATION).not.toMatch(/interval '\d+ days'/);
    expect(SCRUB_MIGRATION).not.toMatch(/interval '\d+ days'/);
  });

  it("reports zero rather than throwing when the purge finds nothing", async () => {
    mocks.purgeAiRetentionData.mockResolvedValue({ data: [], error: null });
    expect(await purgeExpiredAiData()).toEqual({
      deletedMessages: 0,
      deletedReceipts: 0,
      deletedConfirmations: 0,
      scrubbedConversations: 0,
    });
  });

  it("fails loudly on a database error instead of reporting a silent success", async () => {
    mocks.purgeAiRetentionData.mockResolvedValue({
      data: null,
      error: { message: "boom" },
    });
    await expect(purgeExpiredAiData()).rejects.toThrow("AI retention purge failed.");
  });
});

describe("Phase 6 retention migration contract", () => {
  it("restricts the purge to service_role and revokes it from everyone else", () => {
    expect(MIGRATION).toContain("security definer");
    expect(MIGRATION).toContain("Not authorized to purge AI retention data");
    expect(MIGRATION).toContain("from public, anon, authenticated");
    expect(MIGRATION).toContain("to service_role");
  });

  it("fails closed on a nonsensical or unbounded window", () => {
    expect(MIGRATION).toContain("Invalid AI retention window");
    expect(MIGRATION).toContain("p_batch_limit < 1");
  });

  it("never deletes conversations or the clinic audit trail", () => {
    // agent_conversations is the FK parent of receipts and confirmations, so
    // purging it would silently destroy accountability records early.
    expect(MIGRATION).not.toContain("delete from public.agent_conversations");
    expect(MIGRATION).not.toContain("delete from public.audit_logs");
  });

  it("only purges confirmations that can no longer be claimed", () => {
    expect(MIGRATION).toContain("consumed_at is not null or expires_at <= p_now");
  });

  it("deletes the three assistant datasets it declares and nothing else", () => {
    const deletions = [...MIGRATION.matchAll(/delete from public\.(\w+)/g)].map(
      (match) => match[1],
    );
    expect(new Set(deletions)).toEqual(
      new Set(["agent_messages", "ai_action_receipts", "ai_action_confirmations"]),
    );
  });
});

describe("P6-04 conversation scrub", () => {
  it("scrubs the conversation's own free text without deleting the row", () => {
    // `title` is a verbatim copy of the user's first message and
    // `active_context` re-identifies it, so both are exactly what the message
    // window exists to expire. The row itself must survive: receipts and
    // confirmations cascade from it.
    expect(SCRUB_MIGRATION).toContain("update public.agent_conversations");
    expect(SCRUB_MIGRATION).toContain("set title = null");
    expect(SCRUB_MIGRATION).toContain("active_context = '{}'::jsonb");
    expect(SCRUB_MIGRATION).not.toContain("delete from public.agent_conversations");
    expect(SCRUB_MIGRATION).not.toContain("delete from public.audit_logs");
  });

  it("only scrubs a conversation past the window with no surviving messages", () => {
    expect(SCRUB_MIGRATION).toContain(
      "c.created_at < p_now - make_interval(days => p_message_retention_days)",
    );
    expect(SCRUB_MIGRATION).toContain("not exists (");
    expect(SCRUB_MIGRATION).toContain("from public.agent_messages m where m.conversation_id = c.id");
  });

  it("keeps every safety property of the original purge", () => {
    expect(SCRUB_MIGRATION).toContain("security definer");
    expect(SCRUB_MIGRATION).toContain("set search_path = ''");
    expect(SCRUB_MIGRATION).toContain("Not authorized to purge AI retention data");
    expect(SCRUB_MIGRATION).toContain("Invalid AI retention window");
    expect(SCRUB_MIGRATION).toContain(
      "AI receipt retention must not be shorter than message retention",
    );
    expect(SCRUB_MIGRATION).toContain("from public, anon, authenticated");
    expect(SCRUB_MIGRATION).toContain("to service_role");
    // Still batch-bounded, so a first run on a large table cannot lock it up.
    expect(SCRUB_MIGRATION).toContain("limit p_batch_limit");
  });

  it("is idempotent by predicate: an already-scrubbed row no longer matches", () => {
    expect(SCRUB_MIGRATION).toContain(
      "(c.title is not null or c.active_context is distinct from '{}'::jsonb)",
    );
  });

  it("reports the scrub count through the purge result", async () => {
    expect((await purgeExpiredAiData()).scrubbedConversations).toBe(2);
  });
});

describe("P6-11 drain loop", () => {
  function batch(counts: Partial<Record<string, number>>) {
    return {
      data: [
        {
          deleted_messages: counts.messages ?? 0,
          deleted_receipts: counts.receipts ?? 0,
          deleted_confirmations: counts.confirmations ?? 0,
          scrubbed_conversations: counts.conversations ?? 0,
        },
      ],
      error: null,
    };
  }

  it("re-invokes the purge while a batch is saturated and stops on the first short one", async () => {
    mocks.purgeAiRetentionData
      .mockResolvedValueOnce(batch({ messages: AI_RETENTION_BATCH_LIMIT }))
      .mockResolvedValueOnce(batch({ messages: AI_RETENTION_BATCH_LIMIT }))
      .mockResolvedValueOnce(batch({ messages: 12 }));
    const result = await drainExpiredAiData();
    expect(mocks.purgeAiRetentionData).toHaveBeenCalledTimes(3);
    expect(result.passes).toBe(3);
    expect(result.deletedMessages).toBe(AI_RETENTION_BATCH_LIMIT * 2 + 12);
    expect(result.backlogRemaining).toBe(false);
  });

  it("stops on a single short batch without a second round-trip", async () => {
    mocks.purgeAiRetentionData.mockResolvedValue(batch({ messages: 3 }));
    const result = await drainExpiredAiData();
    expect(mocks.purgeAiRetentionData).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ passes: 1, backlogRemaining: false });
  });

  it("signals a remaining backlog instead of silently under-draining", async () => {
    // The retention window is a stated policy commitment, so exceeding it must
    // be observable rather than inferred from a 10 000-rows/day drain rate.
    mocks.purgeAiRetentionData.mockResolvedValue(
      batch({ messages: AI_RETENTION_BATCH_LIMIT }),
    );
    const result = await drainExpiredAiData({ maxPasses: 3 });
    expect(mocks.purgeAiRetentionData).toHaveBeenCalledTimes(3);
    expect(result.backlogRemaining).toBe(true);
  });

  it("stops on the wall-clock budget so the function cannot time out", async () => {
    mocks.purgeAiRetentionData.mockResolvedValue(
      batch({ confirmations: AI_RETENTION_BATCH_LIMIT }),
    );
    let tick = 0;
    const result = await drainExpiredAiData({
      maxPasses: 50,
      budgetMs: 1_000,
      clock: () => (tick += 600),
    });
    expect(result.backlogRemaining).toBe(true);
    expect(result.passes).toBeLessThan(50);
  });

  it("propagates a purge failure rather than reporting a partial success", async () => {
    mocks.purgeAiRetentionData.mockResolvedValue({ data: null, error: { message: "x" } });
    await expect(drainExpiredAiData()).rejects.toThrow("AI retention purge failed.");
  });
});

describe("Phase 6 retention schedule", () => {
  it("is scheduled and guarded like the other cron routes", () => {
    const vercel = JSON.parse(
      readFileSync(join(process.cwd(), "vercel.json"), "utf8"),
    ) as { crons: { path: string; schedule: string }[] };
    expect(vercel.crons.map((cron) => cron.path)).toContain("/api/cron/ai-retention");

    const route = readFileSync(
      join(process.cwd(), "app/api/cron/ai-retention/route.ts"),
      "utf8",
    );
    expect(route).toContain("process.env.CRON_SECRET");
    expect(route).toContain('{ status: 401 }');
    // P6-11: drains rather than deleting one batch, and reports the counts.
    expect(route).toContain("drainExpiredAiData()");
    expect(route).toContain("result.backlogRemaining");
    expect(route).toContain("Sentry.captureMessage");
    expect(route).toContain("{ ok: true, ...result }");
  });
});
