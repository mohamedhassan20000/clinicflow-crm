import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { sweepIdlePatientEpisodes } from "@/lib/ai/conversation-auto-close";

/**
 * P11S — the five-minute episode sweep, as an externally drivable tick.
 *
 * The primary scheduler is the pg_cron job installed alongside
 * `close_idle_patient_ai_episodes`, because a sweep this frequent should not
 * depend on a deploy platform's cron granularity. This route exists so the same
 * function can be driven where the extension is not available, and so the sweep
 * can be run once by hand during a manual QA pass.
 *
 * Same shared-secret guard as every other cron route here, and the same
 * discipline about what comes back: a count, never a conversation.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const closed = await sweepIdlePatientEpisodes();
    return NextResponse.json({ ok: true, closed });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: "patient-episode-idle-close" } });
    // The sweep is idempotent and holds no state, so a failed tick costs
    // nothing but a minute: the next one ends the same episodes.
    return NextResponse.json(
      { ok: false, error: "Episode idle sweep unavailable" },
      { status: 503 },
    );
  }
}
