# P6 — Comprehensive End-to-End Phase Review

**Review date:** 2026-07-29
**Reviewer:** Claude Code (independent verification against `docs/AI_AGENT_PLAN.md` §P6 / §P6A–§P6D, §5.1/§5.2, §6.5/§6.6/§6.7, §9.2/§9.3, §13)
**Scope:** Phase P6 as **one integrated phase** (P6A + P6B + P6C + P6D), on top of `main` (HEAD `89603eb`). The entire P6 change set is uncommitted in the working tree (33 tracked files modified, 50 untracked files, 5 migrations).
**Verdict:** **APPROVED FOR MERGE — conditional on one required fix (P6-C1).** The combined branch fails two **required CI gates** (`lint:i18n`, `i18n:missing`); both are false positives owned by a P6C file that every sub-phase review scoped out, so no one fixed them. Everything else in the integrated phase is production-ready. All remaining findings are Low / Informational.

This review does **not** repeat the isolated sub-phase reviews (`P6A_REVIEW.md`, `P6B_REVIEW.md`, `P6C_REVIEW.md`, `P6D_REVIEW.md`), all of which are APPROVED. It focuses on **integration and regressions across the whole phase** and on **production readiness of the combined diff**. No fixes, commits, pushes, or merges were performed.

---

## 1. Overall verdict

Phase P6 is a large, well-executed, honesty-disciplined phase. The four sub-phases integrate cleanly along the surfaces they share — the single messaging cron, the single WhatsApp webhook route, the provider-neutral `sendMessage` adapter boundary, the operator report registry, and the `messaging:*` audit event stream. The two binding honesty rules (no Meta review-time estimates; no provider data a connection model cannot supply) hold end-to-end, and the Meta/360dialog coexistence model is correct: separate provider rows, non-destructive cutover, provider-scoped template approval, and a deterministic double-active tiebreak.

**One issue blocks a green CI on the integrated branch** and must be resolved before merge:

> **The combined P6 working tree fails two required CI steps** — `pnpm lint:i18n` and `pnpm i18n:missing` (`.github/workflows/ci.yml:43–47`). Both fire only on the untracked P6C file `components/settings/whatsapp-onboarding-wizard.tsx`. Both are **false positives** (a TypeScript callback type misparsed as JSX text; dynamic template-literal catalog keys whose concrete keys all exist in EN and AR). Each of the four sub-phase reviews correctly diagnosed them and correctly scoped them out of *its* cycle ("P6C-owned, not this sub-phase"). The consequence of that correct-per-sub-phase reasoning is that **at the integrated-phase level no one owns the fix, and the merged branch cannot pass CI green.** This is exactly the class of gap a comprehensive review exists to catch. See **P6-C1**.

Because the underlying strings are genuinely fine, this is a **Medium** (release-process blocker, not a correctness/security defect). It is a ~2-line fix (an `i18n-allow` comment / allowlist entry, and either static keys or a scanner allowance for the dynamic lookups). Per instructions it is **not fixed here**.

With P6-C1 resolved, the phase is merge-ready.

---

## 2. Findings by severity

| ID | Severity | Blocking | Area | Summary |
|---|---|---|---|---|
| **P6-C1** | Medium | **Yes** | CI / i18n | Combined branch fails 2 required CI gates (`lint:i18n`, `i18n:missing`) on the P6C wizard; false positives no sub-phase owned |
| P6-L1 | Low | No | Ops / alerting | `sent` scored as delivered (F6B-1) — a stuck-at-`sent` provider outage moves neither the delivery-failure metric nor the P6D health signal |
| P6-L2 | Low | No | Ops / alerting | Truncated (>10k-row) messaging-cost scan not surfaced to Sentry (F6B-2) — a high-volume tenant's anomaly can be silently under-counted |
| P6-L3 | Low | No | AI hardening | `detectInjectionAttempt` broadened in P6A but has zero runtime importers (F6A-1) — advisory telemetry does not emit in production |
| P6-L4 | Low | No | CI coverage | `tests/unit/api` and `tests/unit/integration` are not in the CI "Unit tests" step; P6 adds substantial route coverage (`p6c-meta-webhook-route`, cron, webhook) that CI never runs (extends F6A-3) |
| P6-I1 | Info | No | Perf / load | Load-test *targets* documented; representative *results* deferred to a live preview run (F6B-4) — the §P6 "load-test results documented against targets" line is half-satisfied |
| P6-I2 | Info | No | Concurrency | Dead CAS-retry branch in `applyChannelStateSignals` (P6C-I1) — convergence still guaranteed by webhook redelivery + reconcile poll |
| P6-I3 | Info | No | AI test rigor | Vacuous `leakSpy` / by-construction behavioral assertion in the injection suite (F6A-2) — structural containment control is unaffected |

No Critical or High findings survive at the integrated-phase level. Every Critical/High raised in the P6C and P6D cycles was independently re-confirmed resolved (see §4).

---

## 3. Roadmap acceptance criteria — independently verified

Each §P6 acceptance line, verified against source + a live run (not against the reports):

| §P6 criterion | Status | Evidence |
|---|---|---|
| Prompt-injection suite green in CI as a **required** job | ✅ | `ci.yml:63` `test:ai-adversarial`; re-ran **93/93** |
| Eval set (~50 doctor + ~50 patient, ar/en incl. dialects), documented threshold | ✅ | 52+52 cases; `EVAL_OFFLINE_CONSISTENCY_TARGET=1.0`, `EVAL_PASS_THRESHOLD=0.9`; oracle re-derived from the real registry |
| No adversarial input reaches an unauthorized tool | ✅ | Structural containment via unmounted tools + behavioral `ToolLoopAgent` drive; stored-injection neutralized at the real `sanitizeUntrustedDeep`+`withProvenance` boundary |
| Load tests on webhook + agent routes, documented targets | ✅ (targets) / ⚠️ (results) | `scripts/load-test.mjs` with per-scenario p95/err/rps targets; **results deferred** → P6-I1 |
| Messaging cost dashboard reconciles with raw `usage_counters` | ✅ | `aggregateMessagingCost` pure reduction; unit test asserts column == raw counter sums and cost == Σ`cost_micro` |
| Delivery-failure + per-clinic cost-anomaly alerting fires on a simulated spike | ✅ | `alerts.ts` thresholds (10%/25%, 3×/$100, sample+floor gates); scan → Sentry at mapped severity |
| Meta Tech Provider / Embedded Signup as in-product wizard + connection-state machine + hybrid refresh | ✅ | 4-step wizard; pure total `deriveConnectionState`; webhook + return-from-popup + manual + cron reconcile |
| Per-clinic migration runbook, zero message loss, both providers coexist | ✅ | `P6C_360DIALOG_TO_META_MIGRATION.md`; unique `(clinic_id, channel, provider)`; non-destructive transactional cutover |
| WhatsApp Health page: connection/webhook/template/message health, provider-aware verification+quality+limits, activity timeline, readiness checklist | ✅ | `/settings/messaging/health` (built, in 71 routes); Meta-only signals honest-placeholdered on 360dialog; 50-cap timeline from real `messaging:*` audit rows + derived stamps; fail-closed readiness |
| Operator visibility as a P1.5B registry entry (metadata only, no PHI) | ✅ | `messaging-cost` + `whatsapp-health` registry entries; content-free columns; `requirePlatformAdmin()` before load |
| Honesty rules: no review-time ETA; no data a connection can't supply; sanitized failure reasons | ✅ | Wizard shows decision states + last-checked only; `sanitizeFailureReason` closed-set; `fetchMetaChannelState` requests only documented Graph fields |
| No new cron (2-cron Hobby ceiling) | ✅ | All P6B/P6C/P6D jobs ride the existing `reminders` cron as `allSettled` elements 4–6 |

---

## 4. Cross-phase integration — what was verified

**4.1 The shared messaging cron (`app/api/cron/reminders/route.ts`).** Now carries **six** independent `Promise.allSettled` jobs — 3 core mutation jobs (reminders, followups, booking-expiry) plus P6B `alertScan`, P6C `channelReconcile`, P6D `whatsappHealth`. Failure isolation is correct and the **503 gate is governed solely by the three core jobs** (`route.ts:83–92`) — the P6D-3 fix is in place, so a read-only diagnostic outage no longer forces Vercel to retry already-succeeded reminder/dunning work. Every rejected job is Sentry-captured with a distinct job tag; every fulfilled result is surfaced in the 200 body. No new cron route — the 2-cron Hobby ceiling holds.

**4.2 The shared webhook route (`app/api/webhooks/whatsapp/route.ts`).** Both providers coexist by transport signal: Meta traffic is detected by `X-Hub-Signature-256`, 360dialog by Basic auth. For **both**, the signature is verified **before any clinic lookup** (Meta with the platform app secret + `timingSafeEqual`; 360dialog after a clinic-scoped credential decrypt), and rate limiting runs before auth. Routing degrades safely: Meta routes phone-id → WABA-id → template binding, so WABA-only account events and phone-less template callbacks are no longer 200-dropped. A verified, routed callback stamps `last_verified_webhook_at` for health; a valid-but-unroutable event is acknowledged without a retry storm.

**4.3 The provider-neutral send boundary (`lib/messaging/send.ts`).** `metaWhatsAppProvider` is registered in the `ADAPTERS` map (the P6C-R1 fix); domain callers stay provider-neutral. Double-active legacy data is resolved deterministically in favour of Meta (`send.ts:200–203`). A **Meta template send additionally requires an `approved` Meta provider binding** (`send.ts:286–295`), so a template approved only under 360dialog cannot dispatch over an unverified Meta transport. Ambiguous-outcome classification (timeout / 2xx-without-id) is preserved for Meta, so a fallback never double-sends.

**4.4 Meta ↔ 360dialog coexistence & migration.** Uniqueness moved from `(clinic_id, channel)` to `(clinic_id, channel, provider)`, so Meta claims a *separate* pending row while the 360dialog row + its encrypted envelope stay intact. Cutover is transactional inside `apply_meta_channel_state`: 360dialog demotes `active→pending` only once Meta derives `connected`, and restores if Meta later reaches `error`. `countApprovedTemplates` counts provider-scoped, WABA-scoped bindings, so the Meta `templates_pending→connected` gate cannot be satisfied by a 360dialog approval. Verified live in the prior cycle (two coexisting envelopes, `23505` cross-provider identity collision) and re-confirmed here via the isolation suites.

**4.5 The `messaging:*` audit stream (P6C writes → P6D reads).** P6C writes exactly one clinic-scoped audit row per real transition (`messaging:connection_state`, `messaging:template_status`) via `log_messaging_event`; P6D adds `messaging:webhook_health` (transition-only) and `messaging:health_action` (before provider I/O), and the P6D activity timeline is a filtered read of those same rows merged with derived last-inbound/outbound/sync stamps — **no second logging path, no synthesized history**. The producer/consumer contract is consistent end-to-end.

**4.6 Health readiness fail-closed (P6D-1/P6D-2 fixes).** `isApproved` / `isQualityHealthy` (`health.ts:254–267`) are now exact, normalized allow-lists (`{approved, verified}`, `{green, yellow}`); `not_verified`, `unverified`, `UNKNOWN`, empty, and unrecognized values all fail closed. The old substring heuristic that reported `not_verified` as approved is gone — the §P6D honesty rule holds.

---

## 5. Security, authorization, tenant isolation, audit integrity

- **RPC boundary.** Every P6 RPC (`log_messaging_event`, `apply_meta_channel_state`, `apply_message_template_provider_status`, `claim_meta_channels_for_reconciliation`, `apply_whatsapp_webhook_health`, `claim_whatsapp_channels_for_health_check`, `operator_whatsapp_health_report`) is `SECURITY DEFINER`, `search_path=''`, rejects non-`service_role`, and is revoked from `anon`/`authenticated`. Verified by grep across the three migrations and by the live anon-denial integration assertions.
- **RLS.** `message_template_provider_bindings` has RLS enabled with **intentionally no authenticated policy** (service-role only); `clinic_channels` keeps **zero authenticated read policies** even after the new non-secret operational columns — re-confirmed by `p3a-messaging-rls` (live). New columns are stored **outside** the encrypted credential envelope; no credential/token/secret column was added.
- **Tenant isolation.** Snapshot reads go through `createClinicScopedAdminClient` (injects `.eq('clinic_id', …)`); operator reports gate on `requirePlatformAdmin()` before any data load. Live cross-clinic reads return own-clinic-only / empty. **19/19** live isolation tests pass (`p6d-whatsapp-health`, `p3a-messaging-rls`, `ws7-operator-reports`).
- **PHI minimization (§9.3).** Cost/health/operator projections select only content-free columns — never `body_preview`, recipient, sender, provider token, or raw provider error. Alerts and Sentry `extra` carry only clinic id/name + numeric metrics. Verified live (`body_preview` sentinel absent from serialized operator rows).
- **Audit integrity.** Transition-only writes are atomic (row lock + CAS + audit insert in one transaction); a replayed webhook or repeated poll yields exactly one state and one audit row. Verified live in the P6C cycle; re-checked in source.
- **Credential/secret exposure.** No client component receives credentials; failure reasons reach the client only through the sanitized closed set. Embedded Signup runs in Meta's own popup; the wizard never proxies or stores Meta credentials, and the persisted token is the platform system-user token, not the OAuth user token.
- **Webhook authenticity.** Signature verified before trust for both providers; unsigned/tampered/wrong-secret → 401, never a throw or leak.

No tenant-isolation, authorization, or audit-integrity defect was found.

---

## 6. Validation performed (independently run this cycle)

| Check | Command / method | Result |
|---|---|---|
| Typecheck | `pnpm exec tsc --noEmit` | ✅ clean (exit 0) |
| P6A adversarial + eval suites | `pnpm test:ai-adversarial` | ✅ 2 files / **93 passed** |
| P6B/P6C/P6D focused unit suites | `vitest run` (11 files) | ✅ **98 passed** |
| Broad regression sweep | `vitest run tests/unit/lib tests/unit/api tests/unit/actions` | ✅ 93 files / **772 passed** |
| Live tenant isolation (local Supabase) | `p6d-whatsapp-health` + `p3a-messaging-rls` + `ws7-operator-reports` | ✅ 3 files / **19 passed** |
| Production build | `pnpm build` | ✅ pass; **71 routes** incl. `/settings/messaging/health` |
| RTL gate | `pnpm lint:rtl` | ✅ pass (482 files) |
| Unused-copy gate | `pnpm i18n:unused` | ✅ pass |
| Migration security audit | grep `security definer`/`service_role`/`revoke`/`search_path` across 3 migrations | ✅ all present; new tables service-role only |
| **i18n source gate** | `pnpm lint:i18n` | ❌ **RED** — P6C wizard `:141` (see P6-C1) |
| **i18n catalog/parity gate** | `pnpm i18n:missing` | ❌ **RED** — 3 dynamic P6C keys (see P6-C1) |

Live external Meta/360dialog sends were **not** exercised (no approved Tech Provider app / production credentials) — consistent with every sub-phase report. The adapter boundary, server provisioning contract, DB concurrency/RLS, webhook routing, build config, and regressions were validated locally. Representative load-test *numbers* were not captured (P6-I1); the harness and targets are in place.

---

## 7. Detailed findings

### P6-C1 — Medium (BLOCKING) — Combined branch fails two required CI i18n gates

`components/settings/whatsapp-onboarding-wizard.tsx` (untracked P6C file).

`.github/workflows/ci.yml:43–47` runs `pnpm lint:i18n` and `pnpm i18n:missing` as **required** steps. On the integrated P6 tree both are red:

1. `lint:i18n` reports one "hardcoded JSX string" — text `void, opts: Record` at `whatsapp-onboarding-wizard.tsx:141`. This is the JSX-text heuristic **misparsing the TypeScript type annotation** `(cb: (r: unknown) => void, opts: Record<string, unknown>) => void` on the `FB.login` typing. Not user-facing copy.
2. `i18n:missing` reports three keys — `settings.connectionState.${stateKey}`, `settings.connectionState.${s}`, `settings.connectionReason.${state.reason ?? …}` (wizard lines ~220/250/259). These are **dynamic template-literal keys** the static scanner cannot resolve; every concrete key exists in both EN and AR (`connectionState.*`, `connectionReason.*` verified present).

**Why it is a phase-level finding, not a sub-phase one:** each sub-phase review saw these and correctly deferred them ("P6C-owned; out of *my* boundary; do not fix during review"). No cycle owned P6C's own scanner cleanup because P6C's fix cycle predated the scanner surfacing them in the same tree, and P6D was explicitly P6D-only. The integrated result is a branch that **cannot go green in CI**. A comprehensive/production-readiness gate must treat a red required check as blocking regardless of root-cause triviality.

**Recommended remediation (not applied):** add an `i18n-allow: TypeScript type annotation, not copy` comment (or `scripts/i18n-allowlist.json` entry) for the `FB.login` typing — or lift the type to a named `type` alias off the JSX-adjacent line — and either switch the three lookups to a static key map or add the documented dynamic-key allowance the scanner supports. ~2 lines; no behavior change.

### P6-L1 — Low — `sent` counted as delivered (F6B-1, carried)
`messaging-cost.ts` `DELIVERED_STATUSES` includes non-terminal `sent`. A provider that accepts then silently drops messages leaves them at `sent`, so neither the P6B delivery-failure alert nor the P6D health signal moves. Defensible ("left ClinicFlow") but blind to a stuck-at-`sent` outage. Recommend a stale-`sent` age check in a future ops pass.

### P6-L2 — Low — Truncated cost scan not alerted (F6B-2, carried)
`runMessagingAlertScan` returns `truncated` but does not emit it to Sentry. A tenant whose 3-month `outbound_messages` window exceeds the 10k `REPORT_AGGREGATE_SOURCE_LIMIT` can have its cost/delivery counts under-counted, suppressing the very anomaly the scan exists to catch. Low likelihood at current scale. Recommend a Sentry breadcrumb when `source.data.truncated`.

### P6-L3 — Low — Injection detection layer unwired (F6A-1, carried)
P6A broadened `detectInjectionAttempt` (dialects, extraction, role-hijack), but `lib/ai/guardrails.ts` has **zero runtime importers**, so the advisory telemetry does not emit in production. The security guarantee does not depend on it (containment is the mount, which is wired and verified), and the change is regression-safe *because* the module is inert. Recommend wiring it as genuine advisory telemetry or softening the report wording.

### P6-L4 — Low — API + integration test dirs not in the CI unit step (extends F6A-3)
The CI "Unit tests" step (`ci.yml:56`) enumerates `actions components db lib pages security sanity` — it omits `tests/unit/api`, `tests/unit/ai` (only the 2 P6A files run, via the separate step), and `tests/unit/integration`. P6 adds meaningful route coverage — `p6c-meta-webhook-route`, `p3d-cron-routes`, `p3b-webhook-routes` — that the main unit job never runs. Pre-existing structural gap, not introduced by P6, but P6 materially widens the untested-in-CI surface. Cheap high-value follow-up: add `tests/unit/api` (and ideally `tests/unit/ai`) to the step.

### P6-I1 — Info — Load-test results deferred (F6B-4, carried)
Targets and harness are documented and correct; representative throughput/latency numbers are deferred to a live `pnpm load:test --base=<preview>` run (dev-mode JIT figures are not representative). The §P6 "load-test results documented against targets" line is target-complete, result-deferred — a conscious, tracked deferral to run against a preview before production cutover.

### P6-I2 — Info — Dead CAS-retry branch (P6C-I1, carried)
`applyChannelStateSignals` retries only on `!result`, which `apply_meta_channel_state` never returns; a distinct signal that loses the CAS race is returned `applied=false` rather than retried. Does not violate the one-transition/one-audit invariant; the losing signal converges on the next webhook redelivery or reconcile poll. Recommend documenting the loop as single-pass or retrying on the mismatch when the path is next touched.

### P6-I3 — Info — Vacuous behavioral assertion in injection suite (F6A-2, carried)
`leakSpy` is asserted un-called but never attached, and `expect(executed).not.toContain(forbiddenTool)` is true by construction. The block still adds value (drives a real `ToolLoopAgent` with a compromised model and proves no fabricate-execute / crash), but does not *independently* re-prove containment. Recommend a real tripwire executor. The structural containment control is unaffected.

---

## 8. Localization, RTL & production UX

- **EN/AR parity:** 0 EN-only / 0 AR-only keys across the P6 surface (wizard, health dashboard, reasons, action-errors); confirmed by the parity test and re-checked here.
- **RTL:** `pnpm lint:rtl` clean (482 files) — logical properties throughout, `rtl:` variants on directional icons.
- **Unused copy:** `pnpm i18n:unused` clean.
- **The only i18n reds are the two P6-C1 false positives** (`lint:i18n`, `i18n:missing`) — no genuine missing/hardcoded user-facing copy.
- **Honest UX:** decision-states-only progress rail (no ETA), honest "not available on this connection type" placeholders for Meta-only signals on 360dialog, honest empty timeline for pre-P6 channels, honest resumable/labeled wizard abandonment. Health route builds and is included in the 71 production routes.

---

## 9. Production-readiness assessment of the combined diff

**Ready**, conditional on P6-C1. The phase adds no new cron, no new billing/usage mechanics, no channel-abstraction interface change, no credential/secret column, and no authenticated RLS surface. Migrations are additive and apply cleanly; all new privileged surfaces are service-role only. Typecheck, production build, the full non-integration sweep, the AI adversarial suites, and the live tenant-isolation suites are green. Failure isolation (cron), authenticity (webhooks), non-destructive migration (Meta cutover), and fail-closed readiness are all correct.

**Before merge:** resolve **P6-C1** so CI is green.
**Before production cutover (operational, external):** real Meta Tech Provider approval + a pilot-clinic live cutover per `P6C_360DIALOG_TO_META_MIGRATION.md`; capture live load-test numbers against a preview (**P6-I1**).
**Recommended near-term follow-ups (non-blocking):** P6-L1 (stale-`sent`), P6-L2 (truncated-scan Sentry), P6-L4 (widen CI unit dirs), P6-L3 (wire or reword detection telemetry).

---

## 10. Scope compliance of this review

No fixes applied. No P7 work started. No commit, push, or merge. Only `docs/reviews/P6_COMPREHENSIVE_REVIEW.md` was created.

**Review report path:** `docs/reviews/P6_COMPREHENSIVE_REVIEW.md`
