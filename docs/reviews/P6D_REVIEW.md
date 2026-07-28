# P6D — WhatsApp Health, Diagnostics & Production-Readiness — Review

**Review date:** 2026-07-29
**Plan:** `docs/AI_AGENT_PLAN.md` §P6D (plan lines 101, 1319–1328)
**Implementation report:** `docs/reports/P6D_IMPLEMENTATION.md`
**Reviewer scope:** P6D only. No comprehensive P6 review, no fixes, no commit/push/merge.
**Verdict:** **CHANGES REQUESTED** — conditional approval. One Medium honesty-rule
defect (P6D-1) must be fixed before merge; everything else in P6D scope is
merge-ready. 2 Low + 1 Informational are non-blocking.

---

## Fix-verification cycle — 2026-07-29 (re-review)

**Fixes reviewed:** `docs/reports/P6D_FIXES.md`
**Re-review verdict:** **APPROVED.** All four prior findings raised for the fix
cycle (P6D-1 Medium, P6D-2 Low, P6D-3 Low, P6D-I1 Informational) are independently
verified resolved. No new findings. No regressions in P6C/P6D behavior, EN/AR
parity/RTL, cron failure isolation, or tenant isolation/audit boundaries.

| Prior finding | Severity | Fix status |
|---|---|---|
| P6D-1 — `isApproved` substring false-positive on `not_verified` | Medium | ✅ Resolved — exact allow-list `{approved, verified}`, fails closed |
| P6D-2 — `isQualityHealthy` treats `UNKNOWN`/unrecognized as healthy | Low | ✅ Resolved — exact allow-list `{green, yellow}`, fails closed |
| P6D-3 — daily-cron 503 gate trips on read-only reconcile/health total failure | Low | ✅ Resolved — 503 gate restored to the 3 core jobs only |
| P6D-I1 — "last verified inbound event" wording overstates specificity | Informational | ✅ Resolved — relabeled "Last verified provider callback" (EN/AR) |

### Independent verification of each finding

**P6D-1 (business-verification readiness fails closed).**
`lib/messaging/health.ts:254-263` now derives approval from
`APPROVED_META_BUSINESS_STATES = new Set(["approved", "verified"])` via
`normalizedState()` (trim + lower-case) and `isApproved()` = exact `Set.has`. The
substring regex is gone. Verified fail-closed for: `not_verified`, `unverified`,
`pending`, `rejected`, `expired`, `revoked` (negatives); `""`/`null` (empty);
`complete`, `passed`, `approved_later` (substring lookalikes that the old regex
passed); passes only `verified`/`APPROVED`. Table test
`tests/unit/lib/p6d-whatsapp-health.test.ts:228-280` asserts exactly this matrix and
that `readiness.ready` flips to `false` for every rejected state. ✔

**P6D-2 (quality readiness fails closed).**
`health.ts:255,265-267` now uses
`HEALTHY_META_QUALITY_STATES = new Set(["green", "yellow"])` with the same
normalized exact match. Verified fail-closed for `UNKNOWN`, `""`, `null`, `RED`,
`DEGRADED`, `POOR`, `BLOCKED`, `BLUE`, `GREENISH`; passes only `GREEN`/`yellow`
(test `:282-326`). `UNKNOWN` now correctly fails instead of passing. ✔

**P6D-3 (cron failure isolation).**
`app/api/cron/reminders/route.ts:83-92` — the 503 gate is again governed solely by
`reminders && followups && bookingExpiry` all rejecting. The read-only
`channelReconcile` and `whatsappHealth` jobs run in the same `allSettled` batch;
each rejection is Sentry-captured with its job tag (`:73-82`) and surfaced as `null`
in the 200 response body (`:100-104`), so a diagnostic outage no longer forces a
retry that would re-run already-succeeded reminder/followup work. Fulfilled
all-failed diagnostic summaries (`failed === scanned`) remain visible without
tripping 503. Cron tests `tests/unit/api/p3d-cron-routes.test.ts:111-175` assert:
503 only when all three core jobs fail (Sentry called 3×); reconcile/health
rejection → 200 + `null` + tagged Sentry capture; fulfilled failure counts pass
through at 200. ✔

**P6D-I1 (callback wording matches stored timestamp).**
`messages/en.json:1111` = `"Last verified provider callback"`;
`messages/ar.json:1147` = `"آخر استدعاء موثّق من المزوّد"`. The dashboard binds this
label to `snapshot.webhook.lastVerifiedAt`
(`components/settings/whatsapp-health-dashboard.tsx:339-340`), sourced from
`clinic_channels.last_verified_webhook_at`, which `recordVerifiedWhatsAppWebhook`
(`health.ts:654-672`) stamps for **any** signature-verified, clinic-routed provider
callback (message, template-status, account-update) — matching the DB column
semantics rather than the narrower "inbound event". Wording now accurate. ✔

### No-regression verification

- **P6C/P6D messaging behavior:** touched-file regression cluster (p3b-webhook,
  p6c-meta-webhook, p15b-report-registry, ws7-report-params, p3d-template-actions,
  p46b-copy-parity, p6d-operator-report) — 7 files / **48 passed**.
- **Cron failure isolation:** the sixth `allSettled` job still runs independently;
  read-only rejections are isolated from the HTTP status (see P6D-3). ✔
- **Tenant isolation & audit behavior:** the fix cycle touched only `health.ts`
  readiness helpers, the cron job list, and message catalogs — no RPC, RLS, scoped-
  client, or audit path changed. Live local-Supabase integration re-run confirms it
  holds: `p6d-whatsapp-health` (3 passed) + `ws7-operator-reports` (8 passed) cover
  service-role-only RPCs, anon/authenticated cross-clinic denial, and content-free
  projection. ✔
- **EN/AR localization + RTL:** catalog key diff = **0 EN-only / 0 AR-only**; the
  reworded `healthLastVerifiedEvent` present in both; `pnpm lint:rtl` clean (482
  files). ✔

### Re-review validation performed (independent)

| Check | Command / method | Result |
|---|---|---|
| Focused fix tests | `vitest run` p6d-whatsapp-health + p3d-cron-routes + p6d-dashboard | 3 files / **42 passed** ✔ |
| Touched regressions | 7-file cluster (see above) | **48 passed** ✔ |
| Live integration | p6d-whatsapp-health + ws7-operator-reports (local Supabase) | **11 passed** ✔ |
| TypeScript | `pnpm exec tsc --noEmit` | Pass ✔ |
| RTL gate | `pnpm lint:rtl` | Pass (482 files) ✔ |
| EN/AR parity | recursive catalog key diff | 0 drift ✔ |
| Production build | `pnpm build` | Pass; 71 routes incl. `/settings/messaging/health` ✔ |

**Pre-existing (out of scope, unchanged):** the two repository-wide i18n scanner
reds remain P6C-owned (`whatsapp-onboarding-wizard.tsx`); no P6D fix file
introduces a new scanner violation, consistent with `P6D_FIXES.md §4`.

The original findings and the initial review below are retained verbatim for the
Claude→Codex handoff record.

The implementation is high quality: correct service-role boundaries, genuine
transition-only auditing, honest 360dialog placeholders, content-free projections,
full EN/AR parity, and clean RTL. The single blocking issue is a substring heuristic
that reports a Meta `not_verified` business status as **passed** in the readiness
checklist — a direct violation of the §P6D binding honesty rule.

## Severity summary

| Severity | Count | Blocking |
|---|---:|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 1 | Yes (P6D-1) |
| Low | 2 | No |
| Informational | 2 | No |

---

## Findings

### Medium

**P6D-1 — Readiness `isApproved` treats Meta `not_verified` as approved (honesty-rule violation).**
`lib/messaging/health.ts:254-256`

```ts
function isApproved(value: string | null): boolean {
  return value ? /approved|verified|complete|passed/i.test(value) : false;
}
```

`business_verification_status` is populated from Meta's raw Graph field
`business_verification_status` (`lib/messaging/whatsapp-meta.ts:368`), whose real
production values include `verified`, **`not_verified`**, `pending`, `rejected`,
`expired`, `revoked`. The regex matches the substring `verified` inside
`not_verified` (and `unverified`), so `isApproved("not_verified") === true`.

**Failure scenario:** A Meta-direct channel whose WABA business verification is
`not_verified` renders the readiness "Business verification" check as **passed**
(`readiness()`, `health.ts:293-300`), and because `readiness.ready` is
`checks.every(status !== "failed")` (`health.ts:314`), overall readiness can flip to
**"ready"** and the dashboard badge to green while the account is not actually
verified. This violates the §P6D honesty rule (plan line 1282: "never display
quality/limit/verification data a channel's connection model cannot actually
provide"; line 1326: readiness derived from real sources, "No hardcoded ready").
The value shown next to the row is honest, but the pass/fail status is not.

**Suggested fix:** match against an exact allow-set of approved states (e.g.
`["verified", "approved", "complete", "passed"]` with word-boundary/exact
comparison), or explicitly reject the known negatives (`not_verified`, `unverified`,
`pending`, `rejected`, `expired`, `revoked`) before the positive test. The
neighbouring P6C reconcile already uses a stricter `/pending|review|onboarding|unverified/`
negative check (`meta-reconcile.ts:66-68`), so this heuristic is inconsistent with
the rest of the codebase.

### Low

**P6D-2 — `isQualityHealthy` treats `UNKNOWN`/unrecognized quality as healthy.**
`lib/messaging/health.ts:258-260`

```ts
function isQualityHealthy(value: string | null): boolean {
  return value ? !/red|degrad|poor|blocked/i.test(value) : false;
}
```

Meta `quality_rating` is `GREEN|YELLOW|RED|UNKNOWN`. `UNKNOWN` (and any future/unseen
value) passes the readiness "quality" check. This is a softer version of P6D-1: it
reports a passed quality signal the connection has not actually confirmed. `YELLOW`
passing is a defensible product choice; `UNKNOWN` passing is not. Lower severity
because quality is a warning signal, not a gating verification state. Consider
treating `UNKNOWN`/unmatched as `unavailable`/`failed` rather than `passed`.

**P6D-3 — Daily-cron 500 gate now trips on total failure of the read-only P6C/P6D jobs.**
`app/api/cron/reminders/route.ts` (new `reconcileFailed` / `healthCheckFailed` block)

The pre-P6 contract returned 500 only when **all three** core jobs (reminders,
followups, booking-expiry) failed. P6D broadens it so a total failure of the
read-only reconcile (`failed === scanned`) or health-check job forces the whole cron
to 500, which makes Vercel mark the run failed and retry — re-invoking the
already-succeeded reminder/followup jobs. Mitigated because (a) reminders/followups
are idempotent, and (b) `claim_whatsapp_channels_for_health_check` stamps
`last_webhook_check_at = now()` before I/O, so retried runs skip already-claimed
channels and cannot starve. Net: acceptable, but it couples critical-work success
signalling to a best-effort diagnostic job. Consider signalling health/reconcile
failure via Sentry only (already done) and keeping the HTTP status governed by the
core jobs.

### Informational

**P6D-I1 — "last verified *inbound* event" wording vs. implementation.**
`recordVerifiedWhatsAppWebhook` stamps `last_verified_webhook_at` / `healthy` for
**any** signature-verified, clinic-routed Meta callback — including template-status
and account-update callbacks, not only inbound messages
(`route.ts` `handleMeta`, `health.ts:647-665`). This is consistent with the DB column
comment ("Last provider callback that passed signature verification and resolved to
this clinic/channel") and is arguably the correct health signal, but the report §1.1
/ dashboard label "last verified inbound event" slightly overstates specificity.
No behavioural defect.

**P6D-I2 — `safeText` allow-list silently blanks non-conforming operational values.**
`health.ts:204-212` restricts surfaced status strings to `[A-Za-z0-9 _-]`, ≤64 chars,
rendering anything else as `—`. This is the intended PHI/raw-error guard and is a
good default; noting it so future provider enums containing `/`, `.`, or parentheses
are known to render as `—` rather than their literal value.

---

## What was independently verified (holds up)

- **Role authorization.** Both the page (`health/page.tsx:14`) and the server action
  (`actions/messaging-health.ts:35`) gate on `requireRole(["admin","manager"])` plus
  a `whatsapp` entitlement check. Operator report is gated by `requirePlatformAdmin()`
  (`registry.ts` `whatsappHealthQuery`). ✔
- **Provider-aware signals.** Meta-only panels (business/account review, phone,
  quality, messaging limit) render real values; 360dialog gets the honest
  `notAvailableOnConnection` placeholder and `meta: null` in the snapshot
  (`health.ts:558-568`, dashboard `provider-health` card). ✔
- **Webhook verification / rejection telemetry.** Signature is verified **before** any
  clinic lookup for both providers; signature and rate-limit rejections are counted as
  provider-route aggregates *before* tenant trust (`webhook-telemetry.ts`,
  `route.ts`, `webhook-http.ts`). Verified events stamp health only after signature +
  routing. ✔
- **Transition-only auditing / idempotency.** `apply_whatsapp_webhook_health` writes
  exactly one `messaging:webhook_health` audit row on `unknown/healthy/degraded`
  transitions and none on repeats — **live-verified**: repeated identical `degraded`
  writes produced `transitioned:false` and a single audit row. Already-correct webhook
  repair is a no-op (`checkWebhook` only subscribes when `!subscribed`). Recovery
  actions audit `messaging:health_action` **before** provider I/O. ✔
- **Daily cron / failure isolation.** Sixth `allSettled` job runs independently; a
  throwing channel is Sentry-captured and counted `failed` without aborting the batch;
  fair bounded claim (`skip locked`, stamp-before-I/O) prevents starvation. (See P6D-3
  for the 500-gate observation.) ✔
- **Service-role-only RPCs + tenant isolation.** All four RPCs
  (`apply_whatsapp_webhook_health`, `claim_whatsapp_channels_for_health_check`,
  `operator_whatsapp_health_report`, plus reused `log_messaging_event`) enforce
  `auth.role() = 'service_role'`, `security definer`, `search_path=''`, and are
  revoked from `public/anon/authenticated`. Snapshot reads go through
  `createClinicScopedAdminClient`, which injects `.eq('clinic_id', …)` on every
  select for all six queried tables. **Live-verified:** anonymous RPC calls error;
  authenticated cross-clinic channel/audit reads return empty/own-clinic only. ✔
- **Non-secret persistence.** Migration adds only non-secret health columns; the
  encrypted envelope is untouched; `clinic_channels` keeps zero authenticated
  policies. Operator report and snapshot select no credentials, senders, recipients,
  bodies, or raw errors — **live-verified**: `body_preview` sentinel string absent
  from the serialized operator row. ✔
- **Readiness + timeline accuracy.** Timeline merges only real `messaging:*` audit
  rows and derived last-inbound/outbound/sync stamps, newest-first, capped at 50, with
  an honest empty state; no synthesized history. Readiness links each row to a
  remediation surface. (Readiness *status* derivation flagged in P6D-1/P6D-2.) ✔
- **Operator report.** `whatsapp-health` report registered with clinic/provider/health
  filters, content-free columns, `not_available` for 360dialog quality/limit. ✔
- **EN/AR localization + RTL.** Full catalog parity (0 EN-only, 0 AR-only keys); all
  P6D `settings.*` / `protected.*` / action-error keys present in both; RTL gate clean
  (logical properties, `rtl:` variants on directional icons). ✔

## Two repository-wide i18n scanner findings — investigation

Both are **pre-existing P6C issues, not P6D regressions.** They originate entirely in
`components/settings/whatsapp-onboarding-wizard.tsx` — an untracked **P6C** file (git
status `??`), not in P6D's changed-file set and not modified by P6D. P6D's own files
introduce zero new scanner violations (the scanners report only the wizard).

1. **`pnpm lint:i18n`** — one "hardcoded string" at `whatsapp-onboarding-wizard.tsx:141`,
   text `"void, opts: Record"`. This is a **false positive**: the JSX-text heuristic
   misparses the TypeScript type annotation
   `(cb: (r: unknown) => void, opts: Record<string, unknown>) => void`. Not user-facing
   copy.
2. **`pnpm i18n:missing`** — three keys
   `settings.connectionState.${stateKey}`, `settings.connectionState.${s}`,
   `settings.connectionReason.${state.reason ?? …}` (wizard lines 220, 250, 259). These
   are **dynamic template-literal keys** the scanner cannot resolve; the concrete keys
   all exist in both catalogs (verified: `connectionState` = not_started …
   verification_failed; `connectionReason` = business_verification_rejected … generic,
   present in EN and AR). Runtime lookups succeed.

Both would be red the moment the P6C working tree exists, independent of P6D. Left
unfixed per the P6D-only boundary and the instruction not to fix during review.

---

## Validation performed (independent)

| Check | Command / method | Result |
|---|---|---|
| P6D migration applied locally | REST probe of new `clinic_channels` columns | Present ✔ |
| TypeScript | `pnpm exec tsc --noEmit` | Pass ✔ |
| ESLint (P6D source) | `eslint` on action/lib/component/page | Pass ✔ |
| P6D unit (lib + report + component) | `vitest run` (3 files) | 9 passed ✔ |
| P6D **live** integration | `vitest run tests/unit/integration/p6d-whatsapp-health.test.ts` (local Supabase) | 3 passed ✔ |
| Touched regressions | p3b-webhook, p6c-meta-webhook, p3d-cron, p15b-report-registry, ws7-report-params | 30 passed ✔ |
| ws7 operator reports (live) | `vitest run … ws7-operator-reports` (local Supabase) | 8 passed ✔ |
| RTL gate | `pnpm lint:rtl` | Pass (482 files) ✔ |
| Unused copy | `pnpm i18n:unused` | Pass ✔ |
| EN/AR parity | catalog key diff + action-errors | 0 drift ✔ |
| Tenant isolation | live anon/authenticated cross-clinic RPC + channel/audit denial | Denied ✔ |
| Content-free projection | live operator-report serialization (`body_preview` sentinel) | Absent ✔ |
| i18n scanners | `pnpm lint:i18n`, `pnpm i18n:missing` | Red — pre-existing P6C only (see above) |

Live provider (Meta/360dialog) calls were exercised via adapter fixtures/mocks and the
local DB boundary; no real external send/repair was performed (no production
credentials), consistent with the implementation report.

---

## Handoff (Claude → Codex)

- **Must fix before merge:** P6D-1 (readiness `isApproved` false-positive on
  `not_verified`). Recommend an exact approved-state set or explicit negative rejection.
- **Should fix:** P6D-2 (quality `UNKNOWN` → passed). Optional: P6D-3 (cron 500 gate).
- **No action:** P6D-I1, P6D-I2 (informational); the two i18n scanner reds (P6C-owned,
  out of P6D scope).

**Review report path:** `docs/reviews/P6D_REVIEW.md`
