import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { runAppointmentReminders } from "@/lib/messaging/reminders";
import { runInvoiceFollowups } from "@/lib/messaging/followups";

export const maxDuration = 300;

/**
 * §7.1: the single daily morning messaging cron, CRON_SECRET-guarded (fx-rates
 * precedent). One cron (plus fx-rates) keeps the project within the Vercel
 * Hobby free-tier limit of 2 daily cron jobs. It carries both remaining
 * recurring jobs (2026-07-18 direction): the daily appointment reminders
 * (today+tomorrow, §7.2b) and the unpaid-invoice dunning follow-ups (D+3/D+7,
 * §7.3b). Appointment lifecycle notifications and invoice delivery are
 * event-driven and do not run here.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    // Independent jobs; run both even if one fails so a reminder problem never
    // silences dunning (or vice versa).
    const [reminders, followups] = await Promise.allSettled([
      runAppointmentReminders(),
      runInvoiceFollowups(),
    ]);

    if (reminders.status === "rejected") {
      Sentry.captureException(reminders.reason, {
        tags: { scope: "messaging-cron", job: "reminders" },
      });
    }
    if (followups.status === "rejected") {
      Sentry.captureException(followups.reason, {
        tags: { scope: "messaging-cron", job: "followups" },
      });
    }
    if (reminders.status === "rejected" && followups.status === "rejected") {
      return NextResponse.json(
        { ok: false, error: "Daily messaging cron failed; work retries next run" },
        { status: 503 },
      );
    }

    return NextResponse.json({
      ok: true,
      reminders: reminders.status === "fulfilled" ? reminders.value : null,
      followups: followups.status === "fulfilled" ? followups.value : null,
    });
  } catch (error) {
    Sentry.captureException(error, { tags: { scope: "messaging-cron" } });
    return NextResponse.json(
      { ok: false, error: "Daily messaging cron failed; work retries next run" },
      { status: 503 },
    );
  }
}
