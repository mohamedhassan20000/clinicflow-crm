import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { runAppointmentReminders } from "@/lib/messaging/reminders";
import { runInvoiceFollowups } from "@/lib/messaging/followups";
import { runAiPendingBookingExpiry } from "@/lib/booking/expiry";
import { runMessagingAlertScan } from "@/lib/ops/alert-scan";
import { runChannelStateReconciliation } from "@/lib/messaging/meta-reconcile";
import { runWhatsAppHealthChecks } from "@/lib/messaging/health";

export const maxDuration = 300;

/**
 * §7.1: the single daily morning messaging cron, CRON_SECRET-guarded (fx-rates
 * precedent). One cron (plus fx-rates) keeps the project within the Vercel
 * Hobby free-tier limit of 2 daily cron jobs. It carries appointment reminders,
 * unpaid-invoice dunning, and P5A expiry of unconfirmed AI-created pending
 * bookings. Appointment lifecycle notifications and invoice delivery remain
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
    const [
      reminders,
      followups,
      bookingExpiry,
      alertScan,
      channelReconcile,
      whatsappHealth,
    ] =
      await Promise.allSettled([
        runAppointmentReminders(),
        runInvoiceFollowups(),
        runAiPendingBookingExpiry(),
        // P6B: delivery-failure rate + per-clinic cost anomaly scan. Read-only;
        // reports tripped thresholds to Sentry. Runs here to respect the 2-cron
        // Vercel Hobby ceiling.
        runMessagingAlertScan(),
        // P6C: low-frequency Meta-direct connection-state reconciliation poll
        // (plan line 1311). Read-and-derive; stamps last_synced_at, audits real
        // transitions only. Rides this cron for the same 2-cron ceiling reason.
        runChannelStateReconciliation(),
        // P6D: provider-side webhook drift check for both WhatsApp providers.
        // Read-only; persists only transition health and never auto-repairs.
        runWhatsAppHealthChecks(),
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
    if (bookingExpiry.status === "rejected") {
      Sentry.captureException(bookingExpiry.reason, {
        tags: { scope: "messaging-cron", job: "ai-booking-expiry" },
      });
    }
    if (alertScan.status === "rejected") {
      Sentry.captureException(alertScan.reason, {
        tags: { scope: "messaging-cron", job: "alert-scan" },
      });
    }
    if (channelReconcile.status === "rejected") {
      Sentry.captureException(channelReconcile.reason, {
        tags: { scope: "messaging-cron", job: "channel-reconcile" },
      });
    }
    if (whatsappHealth.status === "rejected") {
      Sentry.captureException(whatsappHealth.reason, {
        tags: { scope: "messaging-cron", job: "whatsapp-health" },
      });
    }
    if (
      reminders.status === "rejected" &&
      followups.status === "rejected" &&
      bookingExpiry.status === "rejected"
    ) {
      return NextResponse.json(
        { ok: false, error: "Daily messaging cron failed; work retries next run" },
        { status: 503 },
      );
    }

    return NextResponse.json({
      ok: true,
      reminders: reminders.status === "fulfilled" ? reminders.value : null,
      followups: followups.status === "fulfilled" ? followups.value : null,
      bookingExpiry:
        bookingExpiry.status === "fulfilled" ? bookingExpiry.value : null,
      alertScan: alertScan.status === "fulfilled" ? alertScan.value : null,
      channelReconcile:
        channelReconcile.status === "fulfilled" ? channelReconcile.value : null,
      whatsappHealth:
        whatsappHealth.status === "fulfilled" ? whatsappHealth.value : null,
    });
  } catch (error) {
    Sentry.captureException(error, { tags: { scope: "messaging-cron" } });
    return NextResponse.json(
      { ok: false, error: "Daily messaging cron failed; work retries next run" },
      { status: 503 },
    );
  }
}
