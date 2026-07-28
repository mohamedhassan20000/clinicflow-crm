# P6C — Meta Tech Provider Migration & Embedded Signup — Review (fix cycle)

**Review date:** 2026-07-28 (re-review of the fix cycle)
**Plan:** `docs/AI_AGENT_PLAN.md` §P6C
**Implementation report:** `docs/reports/P6C_IMPLEMENTATION.md`
**Fix report:** `docs/reports/P6C_FIXES.md`
**Prior verdict:** REJECTED (5 Critical, 4 High, 2 Medium, 1 Low)
**Verdict:** **APPROVED — merge-ready for P6C scope**

The fix cycle resolves every Critical, High, Medium, and Low finding from the prior
review. Each resolution was independently verified against the source, the three
remediation migrations, and live local-Supabase behaviour — not only against the
authors' tests. The prior review recorded no Informational findings; this review adds
one non-blocking Informational observation (I1) about a dead retry path that does not
affect the atomicity invariant it lives next to.

No P6D work was performed. No fixes, commits, pushes, or merges were performed during
this review.

## Severity summary

| Severity | Prior | Resolved | Remaining |
|---|---:|---:|---:|
| Critical | 5 | 5 | 0 |
| High | 4 | 4 | 0 |
| Medium | 2 | 2 | 0 |
| Low | 1 | 1 | 0 |
| Informational (new) | 0 | — | 1 (non-blocking) |

## Verification of prior findings

### Critical

**P6C-R1 — Meta outbound dispatch — RESOLVED.**
`metaWhatsAppProvider` is imported and registered in the production adapter map
(`lib/messaging/send.ts:21,75-79`). The preference walk's `if (!ADAPTERS[row.provider])`
gate now admits `provider=meta`. Legacy double-active data is resolved deterministically
in favour of Meta (`send.ts:200-203`). Meta template sends additionally require an
`approved` Meta provider binding before dispatch (`send.ts:286-295`), so a template
approved only under 360dialog cannot be sent over an unverified Meta transport.
Covered by the production-boundary adapter-selection test.

**P6C-R2 — Embedded Signup CSP — RESOLVED.**
`next.config.ts:42,47,48` adds `https://connect.facebook.net` to `script-src`,
`graph.facebook.com`/`www.facebook.com`/`web.facebook.com` to `connect-src`, and the
Facebook frame origins to `frame-src`. `headers()` returns this list unconditionally for
`/(.*)`, so the served header carries the origins. Verified by static inspection of the
config (the fix report also documents a live built-server header probe).

**P6C-R3 — Destructive 360dialog overwrite — RESOLVED.**
Migration `20260728220000` drops `clinic_channels_clinic_id_channel_key` and adds
`unique (clinic_id, channel, provider)`, so Meta claims a *separate* pending row while
the 360dialog row and its encrypted envelope remain intact. Cutover is transactional
inside `apply_meta_channel_state`: 360dialog is demoted `active→pending` only once Meta
derives `connected`, and restored `pending→active` if Meta later reaches `error`
(migration lines 184-200). All `clinic_channels` upserts were confirmed to target
`onConflict: clinic_id,channel,provider`. **Live-verified:** two provider rows coexist
with both credential envelopes present.

**P6C-R4 — Asset/token lifecycle — RESOLVED.**
`exchangeMetaSignupCode` is now explicitly documented and used only as the OAuth *user*
token and never persisted (`whatsapp-meta.ts:417-455`). `provisionMetaEmbeddedSignup`
(lines 605-734) performs the full server-side lifecycle before any credential is stored:
`debug_token` validation of app id + `whatsapp_business_management` scope + WABA target,
shared-WABA lookup against the platform Business, system-user assignment **and**
read-back verification, phone-ownership lookup with Meta's `display_phone_number`, phone
`/register` with the six-digit PIN, then app subscription **and** subscription read-back.
Any failure returns before the channel leaves `pending` (`channel-management.ts:322-351`).
The persisted token is the platform system-user token, not the OAuth token.

**P6C-R5 — Invented/unsupported signals — RESOLVED.**
`fetchMetaChannelState` requests only documented fields — WABA `account_review_status`,
phone `verified_name,display_phone_number,code_verification_status,quality_rating`, plus
`subscribed_apps` (`whatsapp-meta.ts:841-856`). It no longer requests
`business_verification_status` or `messaging_limit_tier`; both are returned `null`
(lines 881,887). `account_review_status` and `webhook_subscribed` are persisted columns
(migration `20260728220000`). `deriveConnectionState` now treats
`accountReviewStatus === "approved"` as forward progress (`connection-state.ts:145-147`).
Display-name approval no longer invents phone connectivity
(`whatsapp-meta.ts:396-409`), and `phone_number_quality_update` stores `current_limit`
as the limit tier and only an explicit quality field as `qualityRating`
(lines 381-395). Out-of-order protection: `applyChannelStateSignals` drops signals older
than `last_signal_at`, and `pickOrderedState` prevents an unordered callback from
regressing a settled success or clearing a stored failure without a provider timestamp
or the live Graph snapshot (`meta-reconcile.ts:54-77,95-106`).

### High

**P6C-R6 — Pending/error refresh + phone-less callbacks — RESOLVED.**
`findClinicChannelForWebhook` and `findClinicChannelByProviderAccount` now match
`status in (pending,active,error)` (`admin.ts:522,550`). The webhook route routes by
phone id, else WABA id, else Meta template binding (`route.ts:70-91`), so WABA-only
account-review events and phone-less template callbacks are no longer silently 200-dropped.
`claim_meta_channels_for_reconciliation` claims `pending/active/error`, so the daily poll
is a real safety net. **Live-verified:** a `pending` and an `error` Meta channel are both
claimed by the reconciliation RPC.

**P6C-R7 — Meta template lifecycle/provenance — RESOLVED.**
New `message_template_provider_bindings` table holds per-provider ids/status for one
reusable local template. `submitMetaTemplate` posts to the WABA `message_templates`
endpoint with a claim-first binding (`actions/messaging.ts:104-206`); reconciliation
syncs matching Meta templates fetched with the clinic's own credentials
(`meta-reconcile.ts:241-265`). `countApprovedTemplates` now counts **provider-scoped,
WABA-scoped** bindings (`admin.ts:820-833`), so a 360dialog approval cannot satisfy the
Meta `templates_pending→connected` gate. Legacy 360dialog callbacks are bridged
transactionally in migrations `20260728221000`/`20260728222000`.

**P6C-R8 — Atomic state/template transitions — RESOLVED.**
`apply_meta_channel_state` locks the row `for update`, rejects a stale
`p_expected_updated_at` (the `trg_clinic_channels_updated_at` trigger advances
`updated_at`), and performs the state update, provider cutover, and audit insert in one
transaction; the audit row is written only on an actual `connection_state` change
(migration lines 137-217). `apply_message_template_provider_status` does the same for a
binding + its audit row. **Live-verified:** two concurrent identical `apply_meta_channel_state`
calls produce exactly one `transitioned=true` and exactly one
`messaging:connection_state` audit row while atomically demoting 360dialog; the concurrent
template RPC yields one binding transition and one audit row.

**P6C-R9 — Cross-provider identity claim — RESOLVED.**
`clinic_channels_whatsapp_sender_unique_idx` is now global on `(sender_identity) where
channel='whatsapp'` (migration lines 17-20); the ownership preflight no longer filters by
provider (`admin.ts:527-537`); and `connectMetaChannel` inserts the clinic-scoped pending
claim *before* any provider mutation, with provisioning proving asset ownership
(`channel-management.ts:263-351`). **Live-verified:** updating clinic B's Meta row to
clinic A's 360dialog `sender_identity` fails with `23505`.

### Medium

**P6C-R10 — Cron starvation/runtime — RESOLVED.**
`claim_meta_channels_for_reconciliation` atomically claims a fair bounded batch ordered
by `last_sync_attempt_at asc nulls first` with `for update skip locked`, stamping the
attempt **before** provider I/O so failing rows rotate to the back
(migration lines 314-347). `runChannelStateReconciliation` runs up to 8 clinics
concurrently (`meta-reconcile.ts:298-315`). The cron returns 503 when reconciliation
rejects or when every claimed channel fails, instead of a false `ok:true`
(`app/api/cron/reminders/route.ts:67-82`). **Live-verified:** successive single-row claims
return distinct rows (no monopolization).

**P6C-R11 — Acceptance coverage — RESOLVED.**
New/updated suites cover production adapter selection, onboarding identity/provisioning,
CSP/config, popup abandonment, documented Graph requests, signal allow-listing,
pending/error reconciliation, WABA/template routing, Meta template
submission/sync/provenance, atomic concurrent transitions/audits, and live two-clinic
identity/RLS boundaries. Independently re-run green (see Validation).

### Low

**P6C-R12 — Environment/scope documentation — RESOLVED.**
All ten public/server Meta variables are present in `.env.example` (lines 24-39). The
wizard now always renders and shows the honest `metaNotConfigured` placeholder when
public config is absent (`page.tsx:38-78`, `whatsapp-onboarding-wizard.tsx:229-233`).
The quality-rating and messaging-limit diagnostic panels were removed from the P6C
wizard; step 4 shows only the connected number and last-synced time
(`whatsapp-onboarding-wizard.tsx:286-298`), leaving those panels to P6D.

## New observation

### Informational

**P6C-I1 — The `applyChannelStateSignals` retry loop never retries on a CAS miss (non-blocking).**
`apply_meta_channel_state` always returns exactly one row — including the not-found /
stale-`updated_at` branch (`applied=false`). In `applyChannelStateSignals`
(`meta-reconcile.ts:91-180`) the loop only re-iterates when `!result`, which never
occurs, so a genuinely concurrent *distinct* signal that loses the compare-and-set race
is returned as `applied=false` rather than retried. This does **not** violate the R8
invariant — exactly one caller transitions and writes exactly one audit row — and the
losing signal converges on the next webhook redelivery or the reconciliation poll (the
documented hybrid safety net). Realistic concurrency (webhook redelivery, webhook vs.
single-flight cron claim) is already covered by that convergence, so the impact is
negligible. Recommend, when P6D touches this path, either retrying on the
mismatch return or documenting the loop as single-pass to remove the dead branch. Not a
merge blocker.

## Preserved strengths (re-confirmed)

- Meta HMAC-SHA256 signature verification over the raw body with `timingSafeEqual`; the
  POST route verifies before any clinic lookup and the GET handshake requires an exact
  verify-token match (`route.ts:35-68`).
- All new RPCs are `SECURITY DEFINER`, `search_path=''`, reject non-service roles, and are
  revoked from `anon`/`authenticated`; `message_template_provider_bindings` carries RLS
  with no authenticated policy. Live-verified anon denial.
- Credentials stay inside server-only modules and the encrypted envelope; sanitized
  closed-set failure reasons only, no review-time estimate anywhere.
- Ambiguous-outcome send classification (timeout / 2xx-without-id) is preserved for Meta,
  so a fallback never double-sends.

## Validation performed

| Validation | Result |
|---|---|
| `pnpm exec tsc --noEmit` | Pass (exit 0) |
| ESLint over the 15 changed P6C source files | Pass, 0 warnings/errors |
| Focused P6C + touched regressions (`p6c-*`, `config`, `p3a-messaging-send`, `p3b-channel-management`, `p3d-webhook-template-status`, `p3d-template-actions`, `p3d-cron-routes`) | Pass, 12 files / 94 tests |
| Broad regression sweep (`tests/unit/lib`, `api`, `actions`, `components`) | Pass, 152 files / 1,037 tests |
| Live local-Supabase suites (`p6c-review-fixes`, `p3a-messaging-rls`, `p3b-whatsapp-webhook`) | Pass, 3 files / 25 tests |
| Local Supabase migration list | `20260728190000`, `220000`, `221000`, `222000` all applied |
| Independent DB-boundary checks (coexistence, `23505` cross-provider collision, fair claim rotation, concurrent CAS → one transition + one audit + cutover, atomic template transition, anon denial) | Confirmed via the live suite's real service/anon clients |
| `onConflict` / old-constraint-name audit; `.env.example` Meta vars | All upserts target `clinic_id,channel,provider`; no stale constraint refs; all Meta vars documented |

CSP was verified by static inspection of `next.config.ts` (origins present and
unconditionally emitted); a full production build + served-header probe was not re-run
here, and the fix report documents that live probe. No approved external Meta Tech
Provider app or real clinic assets were available, so no live external Meta signup/send
was exercised — the browser boundary, server provisioning contract, adapter boundary,
database concurrency/RLS, webhook routing, build config, and regressions were validated
locally.

## Final decision

**Approve P6C.** Every Critical, High, Medium, and Low finding from the prior review is
independently confirmed resolved with no regressions in the 1,156 tests exercised. The
one new item (I1) is Informational and does not block merge. Remaining external
dependency is unchanged: a real Meta Tech Provider approval and pilot-clinic live cutover,
to be exercised operationally per the runbook. P6D (Health page, diagnostics, recovery
actions) remains out of scope.
