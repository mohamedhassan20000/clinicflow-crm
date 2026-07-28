# P6B — Load, Cost Dashboards & Alerting — Implementation Report

**Branch:** `feat/p6b-ops-load-cost` (implemented in-place on the current working tree)
**Plan reference:** `docs/AI_AGENT_PLAN.md` §P6B (lines 1296–1303), §P6 (§1278–1285), §6.7/§7.6.
**Scope:** P6B only. No P6C/P6D work. **No migration** (plan line 1301: "*Migrations:* none"). No review/commit/push/merge.

---

## 1. What was implemented

P6B gives the operator the ability to *see problems before customers do, at
production load* through three deliverables, none of which introduces new
billing/usage mechanics (P1 owns that model — P6B only **reads and thresholds**):

### 1.1 Messaging cost & delivery dashboard (WA/email)

A new **`messaging-cost`** report-registry entry (P1.5B pattern — one definition
file, shared report shell, no redesign) fills the P1D messaging placeholders. It
reconciles the two content-free sources the plan names:

- **Billed send counts** from `usage_counters` (`wa_messages`, `emails`).
- **Cost & delivery outcome** from `outbound_messages.cost_micro` / `status` /
  `channel` — never `body_preview`, recipient, or provider ids (no PHI, §9.3).

Columns: clinic, period, WA sent, emails sent, delivered, failed, **delivery
failure %**, WA cost USD, total cost USD. Aggregation is a pure, deterministic
reduction (`lib/ops/messaging-cost.ts::aggregateMessagingCost`) so the "messaging
dashboards reconcile with raw `usage_counters`" acceptance is a plain unit test.

The **LLM/AI cost dashboard** the plan lists alongside this (`ai-usage`,
`ai-provider-health`) already exists from P4.5C — it reads the immutable AI usage
ledger (`ai_budget_periods` + `ai_usage_events` summed over reservations, which
includes BYOK and fallback attempts). P6B does not duplicate it; the messaging
dashboard is the net-new registry entry.

Because there is **no migration**, the source loader
(`loadOperatorMessagingCostSource`) reads the tables directly through the
already-authorized operator service-role boundary (the
`loadOperatorAiProviderHealthSource` precedent), bounded per source.

### 1.2 Delivery-failure & per-clinic cost-anomaly alerting

`lib/ops/alerts.ts` — pure, deterministic evaluators with documented thresholds:

- **Delivery-failure rate**: fires per clinic when terminal (delivered+failed)
  sends ≥ `minSample` (20) **and** failure fraction ≥ 10% (warning) / ≥ 25%
  (critical). The minimum-sample gate stops a 1/1 failure reading as a "spike".
- **Per-clinic cost anomaly**: fires when current-period spend ≥ 3× the trailing
  per-period baseline (relative spike, needs history) **or** ≥ $100 absolute
  (critical, fires even with no baseline). A `minCurrentMicros` ($1) floor
  suppresses trivial-dollar multiples.

`lib/ops/alert-scan.ts::runMessagingAlertScan` wires the data source around the
evaluators and reports each tripped alert to **Sentry** (`captureMessage`, level
mapped from severity, PHI-free `extra`). It runs on the **existing daily
messaging cron** (`app/api/cron/reminders`) as a fourth `Promise.allSettled`
job — deliberately **no new cron**, respecting the Vercel Hobby 2-daily-cron
ceiling already used by `fx-rates` + `reminders`. A scan failure is captured to
Sentry and never fails the reminder/dunning jobs (and vice versa).

### 1.3 Load tests on the webhook + agent routes

`scripts/load-test.mjs` (`pnpm load:test`) — a zero-dependency concurrent HTTP
driver (Node ≥ 18 global `fetch`) with three scenarios and **documented
per-scenario targets**:

| Scenario | Route | Target p95 | Target err | Target rps |
|---|---|---|---|---|
| `webhook-verify` | `GET /api/webhooks/whatsapp` (handshake) | ≤ 400 ms | ≤ 1% | ≥ 50 |
| `webhook` | `POST /api/webhooks/whatsapp` (unsigned → reject fast path) | ≤ 800 ms | ≤ 2% | ≥ 25 |
| `agent` | `POST /api/agent/chat` | ≤ 2500 ms | ≤ 5% | ≥ 5 |

It reports throughput and p50/p95/p99 latency, compares to targets, and exits
non-zero on a miss (usable as a manual/CI gate). Auth-bearing scenarios read
their signature/cookie/body from env (`LOAD_WEBHOOK_SIGNATURE`,
`LOAD_AGENT_COOKIE`, …) and are **skipped, never faked**, when that env is
absent — the `agent` scenario skips without `LOAD_AGENT_COOKIE`.

---

## 2. Files changed

**New**
- `lib/ops/alerts.ts` — delivery-failure + cost-anomaly evaluators, thresholds, types.
- `lib/ops/messaging-cost.ts` — `aggregateMessagingCost`, `clinicCostBaselines` (pure).
- `lib/ops/alert-scan.ts` — server scan wiring source → evaluators → Sentry.
- `scripts/load-test.mjs` — webhook/agent load-test harness.
- `tests/unit/lib/p6b-messaging-cost.test.ts` — aggregation & reconciliation.
- `tests/unit/lib/p6b-ops-alerts.test.ts` — threshold behavior (spike fires, gates hold).
- `tests/unit/lib/p6b-alert-scan.test.ts` — scan wiring, Sentry dispatch, window.
- `docs/reports/P6B_IMPLEMENTATION.md` — this report.

**Modified**
- `lib/supabase/admin.ts` — `loadOperatorMessagingCostSource` (content-free, bounded, no migration).
- `lib/operator-reports/registry.ts` — `messaging-cost` definition + `messagingCostQuery`.
- `app/api/cron/reminders/route.ts` — fourth cron job: `runMessagingAlertScan` (allSettled + Sentry).
- `package.json` — `test:ops`, `load:test` scripts.
- `tests/unit/lib/p15b-report-registry.test.ts`, `tests/unit/lib/ws7-operator-report-params.test.ts`, `tests/unit/integration/ws7-operator-reports.test.ts` — extended registry enumerations for the new report.

---

## 3. Validation results

| Check | Command | Result |
|---|---|---|
| Typecheck | `tsc --noEmit` | ✅ clean (exit 0) |
| Lint | `eslint` on all changed files | ✅ clean (0 errors, 0 warnings) |
| P6B ops unit suite | `pnpm test:ops` (3 files) | ✅ **20/20** |
| Registry contract tests | p15b + ws7 params | ✅ pass (new entry accepted) |
| Report guard integration | `ws7-operator-reports.test.ts` (local Supabase) | ✅ **8/8** (incl. two-clinic re-guard on the new query) |
| CI unit suite | `vitest run actions components db lib pages security sanity` | ✅ **1119/1121**; the 2 failures are a pre-existing DOM test-pollution flake in `patient-documents-page.test.tsx` (a file P6B does not touch — passes 6/6 in isolation), unrelated to P6B |
| Load harness | `node --check` + structural run | ✅ parses; runs, measures against targets, skips `agent` without session env (never faked) |

**Acceptance mapping (plan line 1302):**
- *"messaging dashboards reconcile with raw `usage_counters`"* → `p6b-messaging-cost.test.ts` asserts WA/email columns equal the raw counter sums and cost equals the raw `cost_micro` sum.
- *"alerting fires on a simulated delivery-failure spike"* → `p6b-ops-alerts.test.ts` (30% over 100 sends → critical) and `p6b-alert-scan.test.ts` (spike → Sentry `captureMessage` at `error` level).
- *"AI dashboards reconcile with P4.5 usage events/reservations including BYOK and fallback"* → satisfied by the existing P4.5C `operator_ai_usage_report` (sums `ai_usage_events.final_cost_micros` across all attempts); unchanged by P6B.
- *"load-test results documented against targets"* → harness + per-scenario targets above; representative throughput/latency numbers are produced by running `pnpm load:test --base=<url>` against a running instance/preview (dev-mode JIT numbers are not representative and are intentionally not presented as production figures).

### How to run

```bash
pnpm test:ops                                  # P6B unit suites
pnpm load:test --base=http://localhost:3100 --duration=30 --concurrency=25
LOCAL_SUPABASE_SECRET_KEY=$(supabase status -o env | ...) \
  pnpm vitest run tests/unit/integration/ws7-operator-reports.test.ts
```

---

## 4. Scope boundaries honored

- **No migration** (plan line 1301) — the messaging dashboard reads existing tables via the operator service-role boundary.
- **No new cron** — the alert scan rides the existing daily messaging cron (Vercel Hobby 2-cron ceiling).
- **No new billing/usage mechanics** (out of scope) — P6B only reads and thresholds.
- **No P6C/P6D** — no channel-state columns, no health page, no Meta adapter.
- No review, commit, push, or merge performed.

---

## 5. Implementation report path

`docs/reports/P6B_IMPLEMENTATION.md`
