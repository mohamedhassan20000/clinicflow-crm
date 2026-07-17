import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { runAppointmentReminders } from "@/lib/messaging/reminders";

export const maxDuration = 300;

/** §7.1: Vercel Cron → route handler, CRON_SECRET-guarded (fx-rates precedent). */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await runAppointmentReminders()) });
  } catch (error) {
    Sentry.captureException(error, { tags: { scope: "messaging-cron" } });
    return NextResponse.json(
      { ok: false, error: "Reminder run failed; claimed-and-unsent offsets retry next run" },
      { status: 503 },
    );
  }
}
