import "server-only";

import * as Sentry from "@sentry/nextjs";
import { loadOperatorMessagingCostSource } from "@/lib/supabase/admin";
import { REPORT_AGGREGATE_SOURCE_LIMIT } from "@/lib/operator-reports/types";
import { aggregateMessagingCost, clinicCostBaselines } from "@/lib/ops/messaging-cost";
import {
  evaluateClinicCostAnomalies,
  evaluateDeliveryFailureAlerts,
  type OpsAlert,
} from "@/lib/ops/alerts";

/**
 * P6B alert scan. Runs on the existing daily messaging cron (no new cron — the
 * Vercel Hobby 2-job ceiling is already used by fx-rates + reminders). Reads the
 * content-free messaging cost source, evaluates the delivery-failure-rate and
 * per-clinic cost-anomaly thresholds, and reports any tripped alert to Sentry so
 * the operator sees problems before customers do. Reads only — never mutates
 * billing/usage state (P1 owns that model).
 */

function monthOnly(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function monthsAgo(now: Date, months: number): string {
  return monthOnly(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1)));
}

export async function runMessagingAlertScan(now = new Date()): Promise<{
  alerts: OpsAlert[];
  scannedClinics: number;
  truncated: boolean;
}> {
  const currentMonth = monthOnly(now);
  // Three trailing months give the cost-anomaly evaluator a baseline while the
  // current month drives the delivery-failure check.
  const source = await loadOperatorMessagingCostSource({
    periodFromMonth: monthsAgo(now, 3),
    periodToMonth: currentMonth,
    limit: REPORT_AGGREGATE_SOURCE_LIMIT,
  });
  if (source.error || !source.data) {
    throw new Error("Messaging alert scan could not load its source.");
  }

  const rows = aggregateMessagingCost({
    clinics: source.data.clinics,
    counters: source.data.counters,
    outbound: source.data.outbound,
  });

  const currentRows = rows.filter((row) => row.period_start === currentMonth);
  const deliveryAlerts = evaluateDeliveryFailureAlerts(
    currentRows.map((row) => ({
      clinicId: row.clinic_id,
      clinicName: row.clinic_name,
      delivered: row.delivered,
      failed: row.failed,
    })),
  );
  const costAlerts = evaluateClinicCostAnomalies(clinicCostBaselines(rows));
  const alerts = [...deliveryAlerts, ...costAlerts];

  for (const alert of alerts) {
    Sentry.captureMessage(`ops-alert:${alert.kind}`, {
      level: alert.severity === "critical" ? "error" : "warning",
      tags: {
        scope: "ops-alerting",
        kind: alert.kind,
        severity: alert.severity,
        clinic_id: alert.clinicId,
      },
      extra: {
        metric: alert.metric,
        observed: alert.observed,
        threshold: alert.threshold,
        message: alert.message,
      },
    });
  }

  return {
    alerts,
    scannedClinics: new Set(rows.map((row) => row.clinic_id)).size,
    truncated: source.data.truncated,
  };
}
