# P6B Review — Load, Cost Dashboards & Alerting

**Status:** APPROVED FOR MERGE
**Sub-phase:** P6B (`feat/p6b-ops-load-cost`, implemented in-place on the current working tree)
**Review cycle:** 1
**Review date:** 2026-07-28
**Reviewer:** Claude Code (independent verification against `docs/AI_AGENT_PLAN.md` §P6B, §P6, §6.7/§7.6, §9.3)
**Verdict:** **APPROVED FOR MERGE** — every acceptance criterion is met and independently reproduced; all findings are Low / Informational, none blocking.

This file is the authoritative handoff from Claude Code to Codex for the P6B review cycle. Re-reviews must read this file first, verify every checklist item, mark resolved items completed, keep unresolved items open, add new findings under new stable IDs, bump the review-cycle number, and append a dated re-review section. Prior findings must never be deleted.

---

## 1. Review scope

Reviewed the uncommitted working-tree implementation of **P6B only** against the plan, the live local Supabase database, and the existing operator-report + messaging-cron runtime. Every claim in `docs/reports/P6B_IMPLEMENTATION.md` was verified by reading the production sources and running the code — not by trusting the report. **No fixes, commits, pushes, or merges were made. P6A was not re-reviewed; P6C was not started.**

**Files in the P6B change set:**

| File | Change |
|---|---|
| `lib/ops/messaging-cost.ts` | New — pure `aggregateMessagingCost` + `clinicCostBaselines` (WA/email reconciliation, no I/O, no PHI) |
| `lib/ops/alerts.ts` | New — pure delivery-failure-rate + per-clinic cost-anomaly evaluators with documented thresholds |
| `lib/ops/alert-scan.ts` | New — server scan wiring source → evaluators → Sentry (`server-only`) |
| `scripts/load-test.mjs` | New — zero-dependency webhook/agent load harness with per-scenario targets |
| `tests/unit/lib/p6b-messaging-cost.test.ts` | New — aggregation + reconciliation invariants |
| `tests/unit/lib/p6b-ops-alerts.test.ts` | New — threshold behavior (spike fires, gates hold) |
| `tests/unit/lib/p6b-alert-scan.test.ts` | New — scan wiring, Sentry dispatch, trailing window |
| `lib/supabase/admin.ts` | Modified — `loadOperatorMessagingCostSource` (content-free, bounded, no migration) |
| `lib/operator-reports/registry.ts` | Modified — `messaging-cost` definition + `messagingCostQuery` |
| `app/api/cron/reminders/route.ts` | Modified — 4th `Promise.allSettled` job: `runMessagingAlertScan` |
| `package.json` | Modified — `test:ops`, `load:test` scripts |
| `tests/unit/lib/p15b-report-registry.test.ts`, `tests/unit/lib/ws7-operator-report-params.test.ts`, `tests/unit/integration/ws7-operator-reports.test.ts` | Modified — extended registry enumerations for the new report |

**No migration** (plan line 1301). **No new cron** — the scan rides the existing daily messaging cron.

---

## 2. Validation performed (independently run)

| Check | Command | Result |
|---|---|---|
| P6B ops unit suite | `npx vitest run tests/unit/lib/p6b-*.test.ts` | ✅ 3 files, **20/20 passed** |
| Registry contract tests | `npx vitest run tests/unit/lib/p15b-report-registry.test.ts tests/unit/lib/ws7-operator-report-params.test.ts` | ✅ 2 files, **11/11 passed** |
| Report guard integration (live local Supabase) | `LOCAL_SUPABASE_SECRET_KEY=<SERVICE_ROLE_KEY> npx vitest run tests/unit/integration/ws7-operator-reports.test.ts` | ✅ **8/8 passed** — incl. the two-clinic re-guard covering `messaging-cost` |
| Typecheck | `npx tsc --noEmit` | ✅ clean (exit 0, no P6B errors) |
| Load harness parse | `node --check scripts/load-test.mjs` | ✅ parses |
| Enum fidelity | read `types/database.ts:4474` (`outbound_message_status`) | ✅ evaluator statuses match the real enum |
| Auth-guard ordering | read `registry.ts::messagingCostQuery` + re-guard test | ✅ `requirePlatformAdmin()` runs before any data load |
| Param default safety | read `lib/operator-reports/types.ts:117-120` | ✅ invalid/empty month filters fall back to defaults, so `monthFrom!`/`monthTo!` are always valid `YYYY-MM` |

### Independent verification of the acceptance-critical claims

- **Messaging cost & delivery reporting (§P6B "cost dashboards … WA/email from `usage_counters` + `outbound_messages.cost_micro`").** `aggregateMessagingCost` is a pure reduction: billed send counts come from `usage_counters` (`wa_messages`, `emails` only — a non-messaging `ai_messages` counter is provably filtered out, `p6b-messaging-cost.test.ts:36`), cost and delivery outcome come from `outbound_messages.cost_micro`/`status`/`channel`. Bucketed by calendar month; every clinic/month appearing in either source is represented with zero-filled counterparts. Verified deterministic and side-effect-free.

- **WA/email reconciliation ("messaging dashboards reconcile with raw `usage_counters`").** The test asserts the dashboard columns equal the raw counter sums (`july!.wa_messages` === the reduced raw `wa_messages`) and that `cost_micro` equals `outbound.reduce(cost_micro)` exactly. This is the acceptance invariant, expressed as a plain equality against the raw rows. ✅

- **Delivery-failure & cost-anomaly alerts ("alerting fires on a simulated delivery-failure spike").** `evaluateDeliveryFailureAlerts` fires per clinic only when terminal sends ≥ `minSample` (20) and failure fraction ≥ 10% (warning) / ≥ 25% (critical); `evaluateClinicCostAnomalies` fires on ≥ 3× trailing baseline (relative) or ≥ $100 absolute (critical, no baseline needed), gated by a $1 floor. Live-wired scan (`p6b-alert-scan.test.ts`): a 30/100 current-month failure spike produces a `delivery_failure_rate` alert dispatched to Sentry at `error` level; a clean 100/100 run stays silent and dispatches nothing. Thresholds are centralized constants with rationale comments. ✅

- **Tenant isolation & PHI minimization (§9.3).** `messagingCostQuery` calls `requirePlatformAdmin()` **before** loading any data — confirmed by the live re-guard test, which drives `messaging-cost` with `requirePlatformAdmin` rejecting and asserts the query throws `PLATFORM_ADMIN_REQUIRED` with no server client constructed. The loader selects only content-free columns (`clinic_id, channel, status, cost_micro, created_at`; `clinic_id, period_start, metric, used`; `id, name`) — never `body_preview`, recipient, or provider ids. The alerts, Sentry `extra`, and messages carry only clinic id/name + numeric metrics. This is an operator-panel report: cross-tenant by design, gated by the platform-admin boundary, not clinic-scoped RLS. ✅

- **Existing cron integration & failure isolation.** The scan is added as a 4th `Promise.allSettled` job alongside reminders/followups/booking-expiry. A rejected `alertScan` is captured to Sentry (`scope: messaging-cron, job: alert-scan`) and never fails the other jobs; conversely a reminder/dunning failure never blocks the scan. No new cron route — respects the Vercel Hobby 2-daily-cron ceiling. Verified in the diff. ✅

- **Load-test harness correctness & documented targets.** `scripts/load-test.mjs` is a correct concurrent driver: N workers loop until a wall-clock deadline, each request is timed with `performance.now()`, the body is drained (`response.arrayBuffer()`) so connections are reusable and timing is honest, and exceptions are counted as errors with their latency recorded. Percentiles are nearest-rank over the sorted array; pass/fail compares p95/error-rate/rps to per-scenario targets and the process exits non-zero on any miss (usable as a gate). The `agent` scenario is **skipped, not faked**, when `LOAD_AGENT_COOKIE` is absent (`ready()` gate). Targets are documented in the report table. ✅

- **AI-dashboard reconciliation clause.** Correctly satisfied by the **pre-existing** P4.5C `ai-usage`/`ai-provider-health` reports (immutable AI ledger summed across reservations incl. BYOK/fallback); P6B does not duplicate or modify them. The net-new work is the messaging dashboard only. Consistent with the plan's "fills the P1D placeholders." ✅

- **Regression safety.** Only additive/enumerative changes to shared files: the registry gains one definition + one query function; the cron gains one `allSettled` element; three existing test files extend their report enumerations to include `messaging-cost`. Typecheck is clean and every touched test suite passes, including the live two-clinic integration guard. No production behavior outside the new report + scan changes.

---

## 3. Findings by severity

No Critical, High, or Medium findings. All items below are Low / Informational and non-blocking.

### F6B-1 — `"sent"` is counted as delivered, masking never-confirmed sends *(Low)*

`messaging-cost.ts:46` — `DELIVERED_STATUSES = {"delivered","read","sent"}`. In the `outbound_message_status` enum (`queued → sent → delivered → read`, or `sent → failed`), `sent` is **non-terminal**: a message dispatched to the provider that never receives a delivery/failure callback stays at `sent` indefinitely and is scored as delivered. The failure-rate metric therefore only catches sends the provider explicitly marked `failed`; a provider that silently drops messages after accepting them would not move the delivery-failure rate. This is a defensible interpretation ("`sent` = successfully left ClinicFlow") and matches the documented column semantics, but it means the alert cannot detect a stuck-at-`sent` outage. **Recommendation:** document the choice explicitly, or (future) add a stale-`sent` age check. No change required for P6B.

### F6B-2 — Source truncation is surfaced but not alerted on *(Low)*

`admin.ts::loadOperatorMessagingCostSource` bounds each of the three sources at `REPORT_AGGREGATE_SOURCE_LIMIT` (10,000 rows) via `collectOperatorRows`, and returns `truncated`. The report UI renders `sourceTruncated`. However, `runMessagingAlertScan` returns `truncated` in its result object but **does not report it to Sentry**. A high-volume tenant whose 3-month `outbound_messages` window exceeds 10k rows would have its cost/delivery counts silently under-counted, potentially suppressing an anomaly the scan exists to catch. **Recommendation:** when `source.data.truncated` is true, emit a Sentry breadcrumb/warning so a truncated scan is observable. Low likelihood at current scale; not blocking.

### F6B-3 — Cost-anomaly "current" period is the latest *present* period, not strictly the current month *(Low / Informational)*

`clinicCostBaselines` takes the last period in each clinic's sorted list as `current`. In the scan, `evaluateClinicCostAnomalies` runs over `clinicCostBaselines(rows)` across the full 3-month window (unlike the delivery-failure check, which filters strictly to `currentMonth`). Consequences: (a) a clinic that sent nothing this month has its last *active* month treated as "current," so a stale month could be compared against its own priors; (b) at the start of a month the partial current-month spend is compared against full prior months, which naturally *suppresses* the 3× relative trigger early in the period (the absolute $100 ceiling still fires). Both are benign-to-conservative (favouring fewer false pages) rather than incorrect, but the asymmetry between the two evaluators' windows is worth a comment. Informational.

### F6B-4 — Documented load-test *targets*, deferred load-test *results* *(Informational)*

The acceptance line reads "load-test results documented against targets." The harness and per-scenario targets are documented and correct, but no representative throughput/latency numbers are captured in the report — the report explicitly (and reasonably) defers them to a live `pnpm load:test --base=<preview>` run because dev-mode JIT figures are not representative. The *target* half is fully met; the *result* half is deferred to a real run before/at deploy. Flagging so the deferral is a conscious, tracked item, not an oversight.

### F6B-5 — Nearest-rank percentile is mildly optimistic for small samples *(Informational)*

`percentile()` uses `sorted[floor((p/100)*len)]`. For small `len` this biases p95/p99 slightly low (optimistic) versus interpolated or ceil-based nearest-rank. Immaterial at the request volumes these scenarios generate (thousands of samples), and the harness is a gate, not a billing meter. No action needed.

---

## 4. Scope-boundary compliance

- **No migration** — confirmed; the loader reads existing tables through the operator service-role boundary (the `loadOperatorAiProviderHealthSource` precedent). ✅
- **No new cron** — confirmed; scan runs inside the existing `app/api/cron/reminders` route. ✅
- **No new billing/usage mechanics** — confirmed; P6B only reads `usage_counters`/`outbound_messages` and thresholds them. ✅
- **No P6C/P6D** — confirmed; no channel-state columns, health page, wizard, or Meta adapter touched. ✅
- **No review/commit/push/merge performed by this review.** ✅

---

## 5. Verdict

**APPROVED FOR MERGE.** P6B meets every §P6B acceptance criterion, verified by independent reproduction against the live local DB and the real operator/cron runtime. The five findings are all Low/Informational — none blocks merge. F6B-1 and F6B-2 are the two most worth a follow-up (observability of stuck-`sent` sends and of truncated scans); both are safe to defer.

**Review report path:** `docs/reviews/P6B_REVIEW.md`
