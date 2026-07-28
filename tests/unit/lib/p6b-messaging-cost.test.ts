import { describe, expect, it } from "vitest";
import {
  aggregateMessagingCost,
  clinicCostBaselines,
  type MessagingCounterRow,
  type MessagingOutboundRow,
} from "@/lib/ops/messaging-cost";

const clinics = [
  { id: "clinic-a", name: "Clinic A" },
  { id: "clinic-b", name: "Clinic B" },
];

describe("P6B messaging cost aggregation", () => {
  it("reconciles WA/email counts with raw usage_counters", () => {
    const counters: MessagingCounterRow[] = [
      { clinic_id: "clinic-a", period_start: "2026-07-01", metric: "wa_messages", used: 40 },
      { clinic_id: "clinic-a", period_start: "2026-07-01", metric: "emails", used: 10 },
      { clinic_id: "clinic-a", period_start: "2026-06-01", metric: "wa_messages", used: 5 },
      // A non-messaging metric must never leak into the dashboard.
      { clinic_id: "clinic-a", period_start: "2026-07-01", metric: "ai_messages", used: 999 },
    ];
    const rows = aggregateMessagingCost({ clinics, counters, outbound: [] });

    const july = rows.find((r) => r.clinic_id === "clinic-a" && r.period_start === "2026-07");
    expect(july).toMatchObject({ wa_messages: 40, emails: 10 });
    // Direct passthrough of the billed counters — the reconciliation invariant.
    const rawWaJuly = counters
      .filter((c) => c.clinic_id === "clinic-a" && c.period_start === "2026-07-01" && c.metric === "wa_messages")
      .reduce((sum, c) => sum + c.used, 0);
    expect(july!.wa_messages).toBe(rawWaJuly);

    const june = rows.find((r) => r.period_start === "2026-06");
    expect(june).toMatchObject({ wa_messages: 5, emails: 0 });
    // ai_messages never becomes a column value.
    expect(rows.some((r) => r.wa_messages === 999 || r.emails === 999)).toBe(false);
  });

  it("sums cost from outbound_messages.cost_micro and derives delivery failure %", () => {
    const outbound: MessagingOutboundRow[] = [
      { clinic_id: "clinic-a", channel: "whatsapp", status: "delivered", cost_micro: 5000, created_at: "2026-07-02T10:00:00Z" },
      { clinic_id: "clinic-a", channel: "whatsapp", status: "read", cost_micro: 5000, created_at: "2026-07-03T10:00:00Z" },
      { clinic_id: "clinic-a", channel: "whatsapp", status: "failed", cost_micro: 0, created_at: "2026-07-04T10:00:00Z" },
      { clinic_id: "clinic-a", channel: "email", status: "sent", cost_micro: null, created_at: "2026-07-05T10:00:00Z" },
      // queued is pending → excluded from the terminal delivery-rate base.
      { clinic_id: "clinic-a", channel: "whatsapp", status: "queued", cost_micro: null, created_at: "2026-07-06T10:00:00Z" },
    ];
    const rows = aggregateMessagingCost({ clinics, counters: [], outbound });
    const july = rows.find((r) => r.clinic_id === "clinic-a")!;

    // delivered = delivered + read + sent = 3; failed = 1; terminal = 4.
    expect(july.delivered).toBe(3);
    expect(july.failed).toBe(1);
    expect(july.delivery_failure_pct).toBe(25);
    // WA cost = 5000 + 5000 + 0 = 10000 micros = $0.01; email null → 0.
    expect(july.wa_cost_usd).toBeCloseTo(0.01, 6);
    expect(july.total_cost_usd).toBeCloseTo(0.01, 6);
    // cost_micro reconciles with the raw sum.
    const rawCost = outbound.reduce((sum, m) => sum + (m.cost_micro ?? 0), 0);
    expect(july.cost_micro).toBe(rawCost);
  });

  it("buckets outbound by calendar month and merges with counters", () => {
    const rows = aggregateMessagingCost({
      clinics,
      counters: [
        { clinic_id: "clinic-b", period_start: "2026-07-01", metric: "wa_messages", used: 3 },
      ],
      outbound: [
        { clinic_id: "clinic-b", channel: "whatsapp", status: "delivered", cost_micro: 1000, created_at: "2026-07-15T00:00:00Z" },
        { clinic_id: "clinic-b", channel: "whatsapp", status: "delivered", cost_micro: 1000, created_at: "2026-08-01T00:00:00Z" },
      ],
    });
    expect(rows.filter((r) => r.clinic_id === "clinic-b").map((r) => r.period_start).sort()).toEqual([
      "2026-07",
      "2026-08",
    ]);
    const july = rows.find((r) => r.clinic_id === "clinic-b" && r.period_start === "2026-07")!;
    expect(july).toMatchObject({ wa_messages: 3, delivered: 1 });
  });

  it("uses the clinic id as a fallback name when unknown", () => {
    const rows = aggregateMessagingCost({
      clinics: [],
      counters: [{ clinic_id: "ghost", period_start: "2026-07-01", metric: "emails", used: 1 }],
      outbound: [],
    });
    expect(rows[0]!.clinic_name).toBe("ghost");
  });
});

describe("P6B clinic cost baselines", () => {
  it("computes current period vs. mean of prior periods per clinic", () => {
    const rows = aggregateMessagingCost({
      clinics,
      counters: [],
      outbound: [
        { clinic_id: "clinic-a", channel: "whatsapp", status: "delivered", cost_micro: 1_000_000, created_at: "2026-05-01T00:00:00Z" },
        { clinic_id: "clinic-a", channel: "whatsapp", status: "delivered", cost_micro: 3_000_000, created_at: "2026-06-01T00:00:00Z" },
        { clinic_id: "clinic-a", channel: "whatsapp", status: "delivered", cost_micro: 9_000_000, created_at: "2026-07-01T00:00:00Z" },
      ],
    });
    const baselines = clinicCostBaselines(rows);
    const a = baselines.find((b) => b.clinicId === "clinic-a")!;
    // current = July 9,000,000; baseline = mean(May 1M, June 3M) = 2,000,000.
    expect(a.currentMicros).toBe(9_000_000);
    expect(a.baselineMicros).toBe(2_000_000);
  });

  it("returns a zero baseline for a clinic with a single period", () => {
    const rows = aggregateMessagingCost({
      clinics,
      counters: [],
      outbound: [
        { clinic_id: "clinic-b", channel: "whatsapp", status: "delivered", cost_micro: 5_000_000, created_at: "2026-07-01T00:00:00Z" },
      ],
    });
    const b = clinicCostBaselines(rows).find((r) => r.clinicId === "clinic-b")!;
    expect(b.baselineMicros).toBe(0);
    expect(b.currentMicros).toBe(5_000_000);
  });
});
