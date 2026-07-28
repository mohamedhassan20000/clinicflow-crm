/**
 * P6B — Messaging cost dashboard aggregation (WA/email).
 *
 * Pure, deterministic reduction of the two content-free sources the plan names:
 *   - `usage_counters` (metrics `wa_messages`, `emails`) — the billed send count,
 *   - `outbound_messages` (`cost_micro`, `status`, `channel`) — the cost ledger
 *     and delivery outcome.
 * Kept free of I/O so the "messaging dashboards reconcile with raw
 * usage_counters" acceptance is a plain unit test. No PHI, no message bodies.
 *
 * Plan reference: docs/AI_AGENT_PLAN.md §P6B.
 */

export type MessagingCounterRow = {
  clinic_id: string;
  period_start: string; // YYYY-MM-DD (month bucket start)
  metric: "wa_messages" | "emails" | string;
  used: number;
};

export type MessagingOutboundRow = {
  clinic_id: string;
  channel: "whatsapp" | "email" | string;
  status: string; // outbound_message_status
  cost_micro: number | null;
  created_at: string; // ISO timestamp
};

export type MessagingClinic = { id: string; name: string };

export type MessagingCostRow = {
  clinic_id: string;
  clinic_name: string;
  period_start: string; // YYYY-MM (period key shown in the dashboard)
  wa_messages: number; // billed WA sends (usage_counters)
  emails: number; // billed emails (usage_counters)
  delivered: number; // terminal delivered/read/sent (outbound_messages)
  failed: number; // terminal failed (outbound_messages)
  delivery_failure_pct: number; // failed / (delivered + failed) * 100
  wa_cost_usd: number; // sum(cost_micro) where channel = whatsapp
  total_cost_usd: number; // sum(cost_micro) all channels
  // micros retained for exact downstream math (alerts); not a display column.
  cost_micro: number;
};

const DELIVERED_STATUSES = new Set(["delivered", "read", "sent"]);

function monthKey(value: string): string {
  return value.slice(0, 7);
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function microsToUsd(micros: number): number {
  return round(micros / 1_000_000, 6);
}

/**
 * Reduce the raw sources into one row per (clinic, month). Every clinic/month
 * that appears in either source is represented; missing counterparts are zero.
 */
export function aggregateMessagingCost(input: {
  clinics: readonly MessagingClinic[];
  counters: readonly MessagingCounterRow[];
  outbound: readonly MessagingOutboundRow[];
}): MessagingCostRow[] {
  const names = new Map(input.clinics.map((clinic) => [clinic.id, clinic.name]));
  const byKey = new Map<
    string,
    {
      clinic_id: string;
      period: string;
      wa_messages: number;
      emails: number;
      delivered: number;
      failed: number;
      wa_cost_micro: number;
      cost_micro: number;
    }
  >();

  const ensure = (clinicId: string, period: string) => {
    const key = `${clinicId}::${period}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        clinic_id: clinicId,
        period,
        wa_messages: 0,
        emails: 0,
        delivered: 0,
        failed: 0,
        wa_cost_micro: 0,
        cost_micro: 0,
      };
      byKey.set(key, row);
    }
    return row;
  };

  for (const counter of input.counters) {
    if (counter.metric !== "wa_messages" && counter.metric !== "emails") continue;
    const row = ensure(counter.clinic_id, monthKey(counter.period_start));
    if (counter.metric === "wa_messages") row.wa_messages += counter.used;
    else row.emails += counter.used;
  }

  for (const message of input.outbound) {
    const row = ensure(message.clinic_id, monthKey(message.created_at));
    const cost = message.cost_micro ?? 0;
    row.cost_micro += cost;
    if (message.channel === "whatsapp") row.wa_cost_micro += cost;
    if (message.status === "failed") row.failed += 1;
    else if (DELIVERED_STATUSES.has(message.status)) row.delivered += 1;
    // 'queued' is pending — excluded from the terminal delivery-rate base.
  }

  return [...byKey.values()].map((row) => {
    const terminal = row.delivered + row.failed;
    return {
      clinic_id: row.clinic_id,
      clinic_name: names.get(row.clinic_id) ?? row.clinic_id,
      period_start: row.period,
      wa_messages: row.wa_messages,
      emails: row.emails,
      delivered: row.delivered,
      failed: row.failed,
      delivery_failure_pct: terminal === 0 ? 0 : round((row.failed / terminal) * 100, 1),
      wa_cost_usd: microsToUsd(row.wa_cost_micro),
      total_cost_usd: microsToUsd(row.cost_micro),
      cost_micro: row.cost_micro,
    };
  });
}

/**
 * Collapse monthly rows into the per-clinic "current vs. trailing baseline"
 * shape the cost-anomaly evaluator consumes. `current` is the latest period in
 * the window; `baseline` is the mean spend of every earlier period for that
 * clinic (0 when the clinic has no prior history).
 */
export function clinicCostBaselines(
  rows: readonly MessagingCostRow[],
): {
  clinicId: string;
  clinicName: string;
  currentMicros: number;
  baselineMicros: number;
}[] {
  const byClinic = new Map<string, MessagingCostRow[]>();
  for (const row of rows) {
    const list = byClinic.get(row.clinic_id) ?? [];
    list.push(row);
    byClinic.set(row.clinic_id, list);
  }
  const result: {
    clinicId: string;
    clinicName: string;
    currentMicros: number;
    baselineMicros: number;
  }[] = [];
  for (const [clinicId, list] of byClinic) {
    const sorted = [...list].sort((a, b) => a.period_start.localeCompare(b.period_start));
    const current = sorted[sorted.length - 1]!;
    const priors = sorted.slice(0, -1);
    const baselineMicros =
      priors.length === 0
        ? 0
        : Math.round(priors.reduce((sum, row) => sum + row.cost_micro, 0) / priors.length);
    result.push({
      clinicId,
      clinicName: current.clinic_name,
      currentMicros: current.cost_micro,
      baselineMicros,
    });
  }
  return result;
}
