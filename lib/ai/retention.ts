import "server-only";

import { purgeAiRetentionData } from "@/lib/supabase/admin";

/**
 * Phase 6 — assistant data retention (§13 "Retention of clinical text in
 * `agent_messages`", audit finding M2; §12 receipt retention).
 *
 * Decision 6 of the plan: a **fixed default window**, not a clinic setting.
 * Each dataset gets exactly one named constant here, and the purge takes them
 * as arguments rather than hard-coding them in SQL, so making a window
 * per-clinic later is a lookup in this module and nowhere else.
 */

/**
 * Conversation transcripts. Chosen to comfortably exceed the longest plausible
 * "what did we decide last time?" window while bounding how long clinical
 * narrative that Phase 2 made readable can sit in a chat table.
 */
export const AI_MESSAGE_RETENTION_DAYS = 180;

/**
 * The §12 mutation ledger. Deliberately the longest window: a receipt is the
 * accountability record for a write and must survive well past the transcript
 * that produced it.
 */
export const AI_ACTION_RECEIPT_RETENTION_DAYS = 400;

/**
 * Spent or expired confirmation tokens. The control plane needs them only long
 * enough to distinguish "replayed" from "never existed"; a claimable token is
 * never purged regardless of age.
 */
export const AI_ACTION_CONFIRMATION_RETENTION_DAYS = 30;

/** Bounded per-run deletion so a first run on a large table cannot lock it up. */
export const AI_RETENTION_BATCH_LIMIT = 10_000;

export type AiRetentionPurgeResult = {
  deletedMessages: number;
  deletedReceipts: number;
  deletedConfirmations: number;
  /**
   * P6-04. Conversations whose `title` (a verbatim copy of the user's first
   * message) and `active_context` (the ids that re-identify it) were cleared
   * once their transcript expired. The row itself is never deleted — receipts
   * and confirmations cascade from it.
   */
  scrubbedConversations: number;
};

/** True when any dataset came back saturated, i.e. more work remains. */
export function purgeBatchSaturated(result: AiRetentionPurgeResult): boolean {
  return (
    result.deletedMessages >= AI_RETENTION_BATCH_LIMIT ||
    result.deletedReceipts >= AI_RETENTION_BATCH_LIMIT ||
    result.deletedConfirmations >= AI_RETENTION_BATCH_LIMIT ||
    result.scrubbedConversations >= AI_RETENTION_BATCH_LIMIT
  );
}

/**
 * P6-11 — how many batches one scheduled tick may drain. A single 10 000-row
 * batch per nightly tick drains a large backlog at 10 000 rows/day, so data can
 * sit past its declared window indefinitely with no signal. The route loops
 * until a batch comes back short; this ceiling (plus the wall-clock budget
 * below) keeps the function inside its execution limit.
 */
export const AI_RETENTION_MAX_PASSES = 20;

/** Wall-clock budget for one tick's drain loop, well inside the 300s limit. */
export const AI_RETENTION_DRAIN_BUDGET_MS = 120_000;

/**
 * Runs one purge batch. Safe to call repeatedly: it is idempotent by
 * construction (a row past its window is deleted once and then no longer
 * matches) and reports what it removed so the caller can schedule another pass.
 */
export async function purgeExpiredAiData(
  now?: Date,
): Promise<AiRetentionPurgeResult> {
  const { data, error } = await purgeAiRetentionData({
    messageRetentionDays: AI_MESSAGE_RETENTION_DAYS,
    receiptRetentionDays: AI_ACTION_RECEIPT_RETENTION_DAYS,
    confirmationRetentionDays: AI_ACTION_CONFIRMATION_RETENTION_DAYS,
    batchLimit: AI_RETENTION_BATCH_LIMIT,
    now: now?.toISOString(),
  });
  if (error) throw new Error("AI retention purge failed.");
  const row = data?.[0];
  return {
    deletedMessages: row?.deleted_messages ?? 0,
    deletedReceipts: row?.deleted_receipts ?? 0,
    deletedConfirmations: row?.deleted_confirmations ?? 0,
    scrubbedConversations: row?.scrubbed_conversations ?? 0,
  };
}

export type AiRetentionDrainResult = AiRetentionPurgeResult & {
  passes: number;
  /**
   * True when the loop stopped on its pass/time ceiling rather than on a short
   * batch — i.e. rows past their declared window are still on disk. The
   * retention window is a stated policy commitment, so exceeding it is reported
   * rather than left silent.
   */
  backlogRemaining: boolean;
};

/**
 * P6-11 — drains as much of the backlog as one tick safely can.
 *
 * Loops `purgeExpiredAiData` while any dataset returns a saturated batch,
 * stopping on the first short batch, on `AI_RETENTION_MAX_PASSES`, or on the
 * wall-clock budget. Each pass is an independent idempotent transaction, so an
 * interruption at any point leaves the remainder for the next tick.
 */
export async function drainExpiredAiData(options: {
  now?: Date;
  maxPasses?: number;
  budgetMs?: number;
  clock?: () => number;
} = {}): Promise<AiRetentionDrainResult> {
  const maxPasses = options.maxPasses ?? AI_RETENTION_MAX_PASSES;
  const budgetMs = options.budgetMs ?? AI_RETENTION_DRAIN_BUDGET_MS;
  const clock = options.clock ?? (() => Date.now());
  const startedAt = clock();
  const total: AiRetentionDrainResult = {
    deletedMessages: 0,
    deletedReceipts: 0,
    deletedConfirmations: 0,
    scrubbedConversations: 0,
    passes: 0,
    backlogRemaining: false,
  };

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const result = await purgeExpiredAiData(options.now);
    total.deletedMessages += result.deletedMessages;
    total.deletedReceipts += result.deletedReceipts;
    total.deletedConfirmations += result.deletedConfirmations;
    total.scrubbedConversations += result.scrubbedConversations;
    total.passes += 1;
    if (!purgeBatchSaturated(result)) return total;
    if (clock() - startedAt >= budgetMs) break;
  }
  total.backlogRemaining = true;
  return total;
}
