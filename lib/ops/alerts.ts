/**
 * P6B — Operational alerting (delivery-failure rate + per-clinic cost anomalies).
 *
 * Pure, deterministic evaluators. They take already-aggregated, content-free
 * per-clinic metrics (never message bodies or PHI) and return typed alerts. The
 * server scan (`lib/ops/alert-scan.ts`) wires the data source and dispatch
 * (Sentry) around these functions; keeping the thresholds here makes the
 * "alerting fires on a simulated delivery-failure spike" acceptance a plain unit
 * test with no I/O.
 *
 * Plan reference: docs/AI_AGENT_PLAN.md §P6B — "alert thresholds on
 * delivery-failure rate and per-clinic cost anomalies". No new billing/usage
 * mechanics (P1 owns the model); this only reads and thresholds.
 */

export type OpsAlertSeverity = "warning" | "critical";
export type OpsAlertKind = "delivery_failure_rate" | "clinic_cost_anomaly";

export type OpsAlert = {
  kind: OpsAlertKind;
  severity: OpsAlertSeverity;
  clinicId: string;
  clinicName: string;
  /** Human-readable, PHI-free summary safe for logs and Sentry. */
  message: string;
  /** Machine-readable metric name for downstream grouping. */
  metric: string;
  /** Observed value that tripped the threshold. */
  observed: number;
  /** The threshold that was crossed. */
  threshold: number;
};

// ---------------------------------------------------------------------------
// Delivery-failure rate
// ---------------------------------------------------------------------------

export type DeliveryFailureThresholds = {
  /** Terminal (delivered + failed) attempts required before a rate is trusted. */
  minSample: number;
  /** Failure fraction (0–1) that raises a warning. */
  warning: number;
  /** Failure fraction (0–1) that raises a critical alert. */
  critical: number;
};

export const DELIVERY_FAILURE_THRESHOLDS: DeliveryFailureThresholds = {
  minSample: 20,
  warning: 0.1,
  critical: 0.25,
};

/**
 * One clinic's terminal delivery outcomes for the window under evaluation.
 * `delivered` counts rows in `delivered`/`read`/`sent`; `failed` counts `failed`.
 */
export type DeliveryFailureInput = {
  clinicId: string;
  clinicName: string;
  delivered: number;
  failed: number;
};

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function deliveryFailureRate(input: DeliveryFailureInput): number {
  const terminal = input.delivered + input.failed;
  return terminal === 0 ? 0 : input.failed / terminal;
}

export function evaluateDeliveryFailureAlerts(
  rows: readonly DeliveryFailureInput[],
  thresholds: DeliveryFailureThresholds = DELIVERY_FAILURE_THRESHOLDS,
): OpsAlert[] {
  const alerts: OpsAlert[] = [];
  for (const row of rows) {
    const terminal = row.delivered + row.failed;
    // Guard against noise: a 1/1 failure is not a "spike".
    if (terminal < thresholds.minSample) continue;
    const rate = deliveryFailureRate(row);
    if (rate < thresholds.warning) continue;
    const severity: OpsAlertSeverity =
      rate >= thresholds.critical ? "critical" : "warning";
    const threshold =
      severity === "critical" ? thresholds.critical : thresholds.warning;
    const pct = round(rate * 100, 1);
    alerts.push({
      kind: "delivery_failure_rate",
      severity,
      clinicId: row.clinicId,
      clinicName: row.clinicName,
      metric: "outbound_delivery_failure_rate",
      observed: round(rate),
      threshold,
      message:
        `Delivery-failure rate ${pct}% (${row.failed}/${terminal} terminal sends) ` +
        `crossed the ${round(threshold * 100, 1)}% ${severity} threshold.`,
    });
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// Per-clinic cost anomalies
// ---------------------------------------------------------------------------

export type CostAnomalyThresholds = {
  /**
   * Current-period spend must exceed `baseline * multiplier` to be an anomaly,
   * where baseline is the trailing per-period average. Guards against flagging
   * ordinary growth.
   */
  multiplier: number;
  /**
   * Ignore anomalies below this absolute current spend (micros). A clinic that
   * jumps from $0.01 to $0.05 is not worth paging on.
   */
  minCurrentMicros: number;
  /**
   * Absolute current spend (micros) that is always critical, regardless of the
   * baseline (a runaway even without prior history).
   */
  absoluteCriticalMicros: number;
};

export const COST_ANOMALY_THRESHOLDS: CostAnomalyThresholds = {
  multiplier: 3,
  minCurrentMicros: 1_000_000, // $1.00
  absoluteCriticalMicros: 100_000_000, // $100.00
};

/**
 * One clinic's current-period spend against its own trailing baseline. All
 * values are micros (1e-6 USD), matching `outbound_messages.cost_micro` and the
 * AI ledger. `baselineMicros` is the mean of prior periods (0 when no history).
 */
export type CostAnomalyInput = {
  clinicId: string;
  clinicName: string;
  currentMicros: number;
  baselineMicros: number;
};

function microsToUsd(micros: number): number {
  return round(micros / 1_000_000, 2);
}

export function evaluateClinicCostAnomalies(
  rows: readonly CostAnomalyInput[],
  thresholds: CostAnomalyThresholds = COST_ANOMALY_THRESHOLDS,
): OpsAlert[] {
  const alerts: OpsAlert[] = [];
  for (const row of rows) {
    if (row.currentMicros < thresholds.minCurrentMicros) continue;

    // An absolute runaway is always critical, even with no baseline.
    if (row.currentMicros >= thresholds.absoluteCriticalMicros) {
      alerts.push({
        kind: "clinic_cost_anomaly",
        severity: "critical",
        clinicId: row.clinicId,
        clinicName: row.clinicName,
        metric: "clinic_period_cost_usd",
        observed: microsToUsd(row.currentMicros),
        threshold: microsToUsd(thresholds.absoluteCriticalMicros),
        message:
          `Period spend $${microsToUsd(row.currentMicros)} crossed the absolute ` +
          `$${microsToUsd(thresholds.absoluteCriticalMicros)} critical ceiling.`,
      });
      continue;
    }

    // Relative spike: needs a meaningful baseline to compare against.
    if (row.baselineMicros <= 0) continue;
    const ratio = row.currentMicros / row.baselineMicros;
    if (ratio < thresholds.multiplier) continue;
    alerts.push({
      kind: "clinic_cost_anomaly",
      severity: "warning",
      clinicId: row.clinicId,
      clinicName: row.clinicName,
      metric: "clinic_period_cost_usd",
      observed: microsToUsd(row.currentMicros),
      threshold: microsToUsd(row.baselineMicros * thresholds.multiplier),
      message:
        `Period spend $${microsToUsd(row.currentMicros)} is ${round(ratio, 1)}× the ` +
        `trailing baseline $${microsToUsd(row.baselineMicros)} ` +
        `(≥ ${thresholds.multiplier}× anomaly threshold).`,
    });
  }
  return alerts;
}
