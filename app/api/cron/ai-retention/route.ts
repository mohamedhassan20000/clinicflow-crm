import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { drainExpiredAiData } from "@/lib/ai/retention";

/**
 * Phase 6 scheduled retention purge. Same shape and same shared-secret guard as
 * the existing cron routes; the window policy lives entirely in
 * `lib/ai/retention.ts`.
 *
 * P6-11: one tick drains repeatedly rather than deleting a single batch, and it
 * reports the counts instead of discarding them. If the loop stops on its own
 * ceiling with rows still past their window, that is a breach of a stated policy
 * commitment, so it is raised to Sentry and reported in the response rather than
 * left to be inferred from a drain rate.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await drainExpiredAiData();
    if (result.backlogRemaining) {
      Sentry.captureMessage(
        "AI retention purge stopped with a backlog still past its window.",
        {
          level: "warning",
          tags: { area: "ai-retention" },
          extra: {
            passes: result.passes,
            deletedMessages: result.deletedMessages,
            deletedReceipts: result.deletedReceipts,
            deletedConfirmations: result.deletedConfirmations,
            scrubbedConversations: result.scrubbedConversations,
          },
        },
      );
    }
    return NextResponse.json({ ok: true, ...result });
  } catch {
    // Retention is append-safe: a failed run deletes nothing and the next run
    // picks up the same rows. Never leak database or credential detail.
    return NextResponse.json(
      { ok: false, error: "AI retention purge unavailable" },
      { status: 503 },
    );
  }
}
