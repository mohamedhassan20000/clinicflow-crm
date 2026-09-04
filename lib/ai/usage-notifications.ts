import "server-only";

import * as Sentry from "@sentry/nextjs";
import {
  AI_USAGE_THRESHOLD_PERCENTS,
  crossedAiUsageThresholds,
  type AiUsageThresholdPercent,
} from "@/lib/ai/allowance";
import { getClinicAiCommercialUsage } from "@/lib/ai/commercial";
import { emitClinicNotification } from "@/lib/notifications/emit";
import { claimAiUsageThresholdNotice } from "@/lib/supabase/admin";

/**
 * Included-AI-usage threshold notices.
 *
 * Two dedupe layers, because they answer different questions:
 *
 *  1. `ai_usage_threshold_notifications` (durable, in the database) answers "has
 *     this clinic already been told about this threshold in this billing
 *     period?". It has to be durable: `notifications` only dedupes while a row
 *     is UNREAD, so an admin who read the 75% notice would be re-notified on the
 *     very next turn — which is precisely the spam this is meant to prevent.
 *     The claim is an INSERT ... ON CONFLICT DO NOTHING, so two concurrent turns
 *     crossing the same threshold produce exactly one notice.
 *  2. The emitter's own unread-dedupe, which remains as a second belt.
 *
 * The period is part of the key, so a new billing month legitimately notifies
 * again — the allowance reset is exactly when the clinic wants to hear about it.
 *
 * Never throws. A notification is awareness; failing a clinic's AI turn because
 * an advisory notice could not be written would be strictly worse than the
 * missing notice.
 */

export type AiUsageNotificationReason = "reconciled" | "denied_exhausted";

const LINK = "/settings/ai";

function thresholdKey(threshold: AiUsageThresholdPercent): "warning" | "critical" | "exhausted" {
  if (threshold === AI_USAGE_THRESHOLD_PERCENTS.exhausted) return "exhausted";
  if (threshold === AI_USAGE_THRESHOLD_PERCENTS.critical) return "critical";
  return "warning";
}

export async function notifyAiUsageThresholds(input: {
  clinicId: string;
  now?: Date;
  reason: AiUsageNotificationReason;
}): Promise<{ notified: readonly AiUsageThresholdPercent[] }> {
  const notified: AiUsageThresholdPercent[] = [];
  try {
    const now = input.now ?? new Date();
    const usage = await getClinicAiCommercialUsage(input.clinicId, now);
    // An allowance that was never configured is not an allowance that ran out.
    // Telling a clinic its included usage is exhausted when the platform owner
    // simply has not set one yet would be actively misleading.
    if (!usage.managedAllowanceConfigured) return { notified };

    // A denial for exhaustion is authoritative about being at 100% even if the
    // aggregate has not caught up (worst-case reservations are released on
    // reconcile, so the stored percentage can lag a hard denial by one turn).
    const percent =
      input.reason === "denied_exhausted"
        ? AI_USAGE_THRESHOLD_PERCENTS.exhausted
        : usage.usedPercent;

    for (const threshold of crossedAiUsageThresholds(percent)) {
      const claimed = await claimAiUsageThresholdNotice({
        clinicId: input.clinicId,
        periodStart: usage.periodStart,
        threshold,
        usedPercent: percent,
      });
      if (claimed.error) throw claimed.error;
      // The RPC returns true exactly once per clinic/period/threshold.
      if (claimed.data !== true) continue;
      await emitClinicNotification({
        clinicId: input.clinicId,
        type: "ai_usage_threshold",
        link: LINK,
        // Render inputs only — a percentage, a band name and a reset date.
        // No actor, no conversation, no cost figure.
        data: {
          threshold: thresholdKey(threshold),
          percent: String(percent),
          resetDate: usage.resetDate,
          byokConfigured: usage.byokConfigured ? "true" : "false",
        },
        roles: ["admin"],
        dedupeUnread: true,
        dedupeData: { threshold: thresholdKey(threshold), period: usage.periodStart },
      });
      notified.push(threshold);
    }
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: "ai-usage-threshold-notification" },
      extra: { clinicId: input.clinicId, reason: input.reason },
    });
  }
  return { notified };
}
