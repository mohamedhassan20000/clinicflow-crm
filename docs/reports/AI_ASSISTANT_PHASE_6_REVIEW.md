# AI Assistant — Phase 6 Review (re-review after P6-01 … P6-11 remediation)

**Phase:** 6 — Documents, export, retention (`docs/plans/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md` §15)
**Implementation report reviewed:** `docs/reports/AI_ASSISTANT_PHASE_6_IMPLEMENTATION.md` (§9 remediation)
**Supersedes:** the previous revision of this file (verdict NOT PASS — 1 High, 3 Medium, 7 Low).

**Verdict:** **NOT PASS — 1 Low finding remains (P6-12).**

All eleven prior findings (P6-01 … P6-11) and the §4 coverage note are **genuinely resolved
in the real implementation and protected by meaningful runtime coverage** — verified
individually below, not taken from the report. The single remaining item is a denial-taxonomy
regression that the P6-06 remediation itself introduced: an out-of-scope or non-existent
subject record on the document preview path is now reported as `transient_failure` instead of
`unauthorized_scope`. It is localized to one mapping in one file, has no security or
enumeration impact, and does not touch the phase's architecture. Nothing else blocks.

No production code was modified by this review.

---

## 1. Verification performed

| Check | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | **clean** |
| The six Phase 6 suites | `npx vitest run tests/unit/ai/phase6-{documents,document-actions,retention,review-fixes,document-dispatch}.test.ts tests/unit/components/phase6-document-confirmation-card.test.tsx` | **6 files, 122 tests passed** |
| Full unit regression | `npm run test` | **355 files, 2 673 tests passed** |
| P7 / document + component regression | `npx vitest run tests/unit/lib/p7 tests/unit/components` | **114 files, 623 tests passed** |
| Adversarial / eval | `npm run test:ai-adversarial` | **2 files, 112 tests passed** |
| Phase 6 RLS integration | `npx vitest run tests/unit/integration/phase6-documents-retention-rls.test.ts` (local Supabase, keys via `supabase status`) | **9 tests passed** |
| Full integration + RLS | `npm run test:integration` | **54 files passed, 1 skipped; 471 passed, 3 skipped** |
| Static service-role guard | `npx vitest run tests/unit/security/admin-client-static-guard.test.ts` | passed |
| i18n / RTL / message parity | `npm run lint:i18n`, `npm run lint:rtl`, `npm run i18n:missing` | ✓ 439 files / ✓ 680 files / ✓ 3 984 leaf messages |

Every number in the report's §9.13 reproduces exactly.

**One flake, not a Phase 6 defect.** A first `npm run test:integration` run reported
`tests/unit/integration/ws8-operator-clinic-history.test.ts` failing on a usage-metric
assertion. It is not a Phase 6 file, and it failed only because this review had already run
`phase6-documents-retention-rls.test.ts` standalone against the same local stack immediately
before, leaving seed rows behind. Re-run alone under the suite's own
`--no-file-parallelism`, it passes. Recorded here so it is not mistaken for a regression, but
the file's dependence on a pristine stack is a pre-existing test-hygiene issue outside this
phase.

---

## 2. Each prior finding, verified against the implementation

### P6-01 — `GENERIC_DOCUMENT` body on the confirmation card — **resolved**

`DocumentSnapshotSummary.body` and `snapshotBody(code, snapshot)`
([lib/documents/mutations.ts:885,902](lib/documents/mutations.ts#L885)) project the authored
title plus **every** block in order, verbatim, labelled `body <n> (heading|paragraph)`, and
return `[]` for every data-derived type. `issueChanges` emits one preview change row per entry
([lib/ai/actions/definitions/documents.ts:176](lib/ai/actions/definitions/documents.ts#L176)),
and the card renders every change row with `break-words` and no clamp, truncation, scroll
container, or collapse
([components/assistant/assistant-chat.tsx:667-687](components/assistant/assistant-chat.tsx#L667))
— I checked the JSX specifically for a height cap and there is none.
`issueSummary` appends the provenance sentence only when a body is present.

The cap is real and it refuses rather than truncates: `MAX_ASSISTANT_AUTHORED_BODY_CHARS =
20_000` is compared against `authoredBodyLength(preview.data.body)` in `prepareDocumentIssue`
([capability.ts:372-380](lib/ai/documents/capability.ts#L372)), returning `content_too_long`,
which `requireReadyIssue` converts to
`documents.authored_body_too_long:<actual>/<cap>`. The platform's own 240 KB schema limit is
untouched, so the UI path is unchanged. Both action phases run `prepareDocumentIssue`, so
execute cannot slip past the cap the preview enforced.

Coverage is genuine, not mocked: `phase6-document-dispatch.test.ts` runs the real
`previewDocumentCore` and asserts 12 blocks come back character-for-character in order; the
action-level test asserts each block string is present in `preview.changes`; the oversize test
asserts `business_rule_violation`, an `authored_body_too_long` receipt, **and**
`issueDocumentFoundation` never called; the adversarial case asserts an injected
"waives all liability" / "Ignore previous instructions" payload appears on the card in full.
`phase6-document-confirmation-card.test.tsx` renders the real card and asserts the blocks are
visible while the confirm control is un-pressed and enabled.

### P6-02 — Reports-page gate for all analytical types — **resolved**

`requiresReportsPageVisibility(code)`
([mutations.ts:200](lib/documents/mutations.ts#L200)) is
`reportIdFor(code) !== null || documentIssueFamily(code) === "analytical" ||
issuanceTrigger.href.startsWith("/reports")`, and `assertDocumentTypeAccess` requires
`getPageVisibilityState(user, "reports") === "visible"` for every such type while keeping the
per-report grant for the six report-backed ones. It still fails closed on `lookup_failed`
(anything other than `"visible"` denies).

I re-derived the parity independently rather than trusting the test's model: `/reports*` hrefs
in `DOCUMENT_CATALOG` are exactly the eight analytical + revenue types
([catalog.ts:135-226](lib/documents/catalog.ts#L135)); `requireReportsIndexAccess` and
`requireReportAccess` ([lib/reports/access.ts](lib/reports/access.ts)) both `notFound()` on a
hidden `reports` page and nothing else applies a page gate to the roster / invoice /
patient-history / clinical / generic helpers. The predicate reproduces the UI branch exactly.
The AI path is additionally stricter (`pageSlug: "documents"` in `assertActionAccess`), which
is the permitted direction.

The 21 × 5 × 2 parity sweep, the `describeIssuableDocuments` omission, and the
`resourceExportSuggestion(user, "follow_ups") === null` case all pass.

### P6-03 — clinical finalization disclosed, audited, and gated — **resolved, all three parts**

1. **Disclosed.** `resolveClinicalRecordIssueState` reads (never writes) the record's status
   on the caller's RLS client ([mutations.ts:576](lib/documents/mutations.ts#L576));
   `prepareDocumentIssue` calls it *before* snapshot resolution and returns
   `clinical_record: { table, record_id, status, will_finalize }`
   ([capability.ts:339-351](lib/ai/documents/capability.ts#L339)). A state outside
   `{draft, finalized}` returns `record_not_issuable` **at preview**, naming the state.
   `issueChanges` emits `prescriptions <id>: draft → finalized` with `identifiesRecord: true`,
   and `issueSummary` appends *"…cannot return to draft; it can only be voided afterwards."*
2. **Audited.** `issueAudit(code, documentId, sideEffect)` sets
   `targetRecordIds = [documentId, sideEffect.recordId]` and carries
   `prescriptions.<id>: <before> → finalized`
   ([mutations.ts:301-336](lib/documents/mutations.ts#L301)). `issueClinicalDocumentCore`
   captures `stateBefore` *before* the transition, so the receipt records the real prior state.
   `auditDigests` keeps both ids (both are UUIDs).
3. **Gated on `ai.write_records`.** `assertClinicalIssuanceFeature`
   ([definitions/documents.ts:82](lib/ai/actions/definitions/documents.ts#L82)) applies the
   second feature conditionally on `documentIssueFamily(code) === "clinical"`, on **both**
   phases, throwing `AiToolAuthorizationError("feature_not_entitled")`; both
   `previewRegisteredAction` and `executeRegisteredAction` now map a definition-thrown
   `AiToolAuthorizationError` through `mappedAuthorizationReason`, so it lands as a
   `plan_not_entitled` denial with a **denied** receipt rather than an unhandled error
   ([execute.ts:517-540](lib/ai/actions/execute.ts#L517)). `"ai.write_records"` is a real key in
   `lib/ai/commercial-policy.ts` and is the same one `clinical.ts` and `patients.ts` use.

Covered over the **real** dispatch: draft transitioned once through the shared Phase 5c core;
already-finalized not re-transitioned; a `void` record refused with nothing issued or
transitioned; a controlled medicine blocked before the record is touched; the executed
receipt's `targetRecordIds` asserted `[documentId, recordId]`; and the withheld-feature case
denied `plan_not_entitled` **with a negative control** proving the same tier still issues a
revenue report.

### P6-04 — retention scrubs conversation title and active context — **resolved**

`20260814150000_ai_assistant_phase6_retention_scrub.sql` adds a fourth step that `update`s
(never `delete`s) `title = null, active_context = '{}'::jsonb` for conversations past
`p_message_retention_days` **with no surviving `agent_messages`**, bounded by
`limit p_batch_limit`, and returns `scrubbed_conversations`. `'{}'` rather than `null` is
correct — the column is `not null default '{}'`. Idempotent by predicate
(`title is not null or active_context is distinct from '{}'`). Every safety property survived
the drop/recreate: `security definer`, `set search_path = ''`, the
`coalesce(auth.role(),'') <> 'service_role'` guard, revoked from `public/anon/authenticated`,
granted only to `service_role`, windows as arguments, fail-closed validation, the
receipt-vs-message window inversion check, and the claimable-token exclusion. A
`agent_conversations_created_at_idx` was added for the new scan.

Verified against **real local Supabase with real policies and JWTs**: the expired conversation
keeps its row with `title === null` and `active_context === {}`; an equally old conversation
holding an in-window message keeps **both** (this is what proves the `not exists` guard rather
than only the age guard); a second run reports `scrubbed_conversations: 0`; and the scrubbed
conversation's `ai_action_receipts` row and still-claimable `ai_action_confirmations` row are
intact. `types/database.ts` gained the one return column surgically (354 insertions, **0
deletions** overall).

### P6-05 — permission-filtered type discovery — **resolved**

`accessibleDocumentTypeCodes(user)`
([capability.ts:251](lib/ai/documents/capability.ts#L251)) runs role list →
`assertDocumentTypeAccess` per candidate with the hoisted page read, and
`prepareDocumentIssue` builds `valid_document_types` from it. The test asserts the returned
list is **set-equal** to `describeIssuableDocuments`' codes for the same user, and that a
role-granted but report-hidden `REVENUE_REPORT` is absent. The two surfaces can no longer
disagree.

### P6-06 — `transient_failure` outcome exists and is threaded — **resolved as specified**, but see **P6-12**

`DocumentPreviewOutcome` gained `transient_failure`; `previewFailed` maps to it while
`documentTypeNotAvailable` / `reportNotVisible` / `documentTypeUnknown` keep
`unauthorized_scope`. `ActionTransientError` ([lib/ai/actions/errors.ts](lib/ai/actions/errors.ts))
is thrown by `requireReadyIssue` and mapped to the `transient_failure` denial reason in **both**
`previewRegisteredAction` and `executeRegisteredAction`, so it never becomes a permanent
`business_rule_violation`. The dispatch test forces a resolver to throw and asserts both the
returned reason and `denialReason: "transient_failure"` on the receipt.
`preview_document`'s description states the retry semantics for the read surface.

The instruction as written in the prior review is implemented faithfully. What that instruction
did not account for is that `previewFailed` is also the bucket for *"record not found / not
yours"* — that is P6-12 below.

### P6-07 — server-derived canonical input and context on both phases — **resolved**

`ActionResolverContext` ({conversationId, locale, activePatientId, activeAppointmentId, now?})
is resolved by `resolveActionResolverContext`
([lib/ai/actions/resolver-context.ts](lib/ai/actions/resolver-context.ts)) from the
`agent_conversations` row itself, on the caller's own RLS-scoped session client, in **both**
phases — so it is identical across them and never passes through the model. It fails soft to
`DETACHED_RESOLVER_CONTEXT` (all-null), which makes the action ask rather than guess. Both
`issueAction.preview` and `issueAction.execute` pass `{patientId, appointmentId, locale, now}`
into `prepareDocumentIssue`.

The token binding is sound and strictly strengthens the Phase 3 pipeline: `ActionPreview`
gained `canonicalInput`; `previewRegisteredAction` re-parses it through **the action's own
input schema** before minting the token over it, so a canonicalisation can only produce input
the action already accepts ([execute.ts:430-437](lib/ai/actions/execute.ts#L430)). The
canonical object is returned as `ActionPreviewSuccess.action_input`, which
`assistant-chat.tsx:556` resends. Crucially, `action_input` is **not** in `modelSafeOutput`'s
explicit allow-list ([lib/ai/tools/execute-action.ts:16-28](lib/ai/tools/execute-action.ts#L16)),
so neither the token nor the canonical input enters model context.

Coverage is real: the active patient fills `PATIENT_FILE` with no explicit id (with a negative
control that it still asks without context); the period test previews three minutes before a
Europe/Istanbul month boundary and confirms five minutes later in the next month, asserting the
issued range is the previewed one **plus** a negative control proving re-deriving `this_month`
at confirm time would differ; and resending the un-canonicalised model input is denied with
nothing issued.

### P6-08 — unknown params keys surfaced — **resolved**

`unknown_keys` is on the `missing_information`, `invalid_input` **and `ready`** outcomes;
`requireReadyIssue` appends `;unknown:<keys>` to the refusal code; `issueChanges` renders an
`ignored input keys` row; `preview_document`'s description names the field. Tests cover the
mis-cased `patient_id` case and smuggled `clinic_id`/`table` keys on the ready path. The
underlying defence is unchanged — `params` never carries a clinic id and the non-strict family
schemas still strip unknowns before use.

### P6-09 — localized label and stated language — **resolved**

`getDocumentTypeLabel(code, locale)`
([lib/documents/module-labels.ts](lib/documents/module-labels.ts)) shares its literal-key table
with `getDocumentTypeLabels()`, so the i18n gate still proves every key is referenced (gate
re-run clean). `previewDocumentCore` resolves `title` through it and keeps the raw key
separately as `titleKey`. `issueChanges` emits a `language` row on every issue preview.
`issueInputSchema.locale` is now optional and falls back to `context.locale` — the
conversation's own language, read server-side — with an explicit model choice still winning,
and the resolved value pinned into `canonicalInput` so the phases cannot disagree. The dead
`documentCatalogTitle()` helper is gone. Tests assert no change row matches
`/^documents\.catalog\./`, that `en` and `ar` produce different non-key titles, and that an
`ar` conversation yields `language: ar` and `action_input.locale === "ar"`.

### P6-10 — one page-visibility read per describe — **resolved, both mechanisms**

`readPageVisibilityFor` is wrapped in React `cache()` keyed on
`(userId, clinicId, role, pageSlug)`, mirroring `readReportVisibilityFor`
([lib/server-page-permissions.ts](lib/server-page-permissions.ts)), and both
`describeIssuableDocuments` and `accessibleDocumentTypeCodes` additionally hoist the single
`reports` lookup and pass it via the new optional `reportsPageVisibility`. That option is a
read the caller already performed for the same `(user, "reports")` pair, so it cannot widen
access. The dispatch suite's table-recording PostgREST stub asserts **exactly one**
`user_page_permissions` read for an admin's describe call.

### P6-11 — bounded drain with a backlog signal — **resolved**

`drainExpiredAiData` loops `purgeExpiredAiData` while any dataset returns a saturated batch
(`purgeBatchSaturated` covers all four counters including the new scrub), stopping on the first
short batch, on `AI_RETENTION_MAX_PASSES = 20`, or on
`AI_RETENTION_DRAIN_BUDGET_MS = 120_000`. Each pass is an independent idempotent transaction.
The cron route calls it, **returns** the counts, and raises a `Sentry.captureMessage` at
`warning` with the per-dataset counts when `backlogRemaining` is true, while still leaking no
database detail on failure. `vercel.json` schedules `/api/cron/ai-retention` at `30 3 * * *`
behind the same `CRON_SECRET` bearer guard. All five drain behaviours are tested, including the
injected-clock budget stop and failure propagation.

### §4 coverage note — real per-family dispatch — **resolved**

`tests/unit/ai/phase6-document-dispatch.test.ts` (31 tests) runs `issueDocumentCore`,
`previewDocumentCore` and every per-family core **for real**; only the data layer beneath them
is stubbed (snapshot resolvers, `issueDocumentFoundation`, `issueInvoiceDocument`, the PDF
renderer, `transitionClinicalRecordMutation`, and a chainable PostgREST stub that records which
tables were read). It asserts per-family routing with the correct idempotency-key prefixes, the
`INVOICE` path bypassing `issueDocumentFoundation`, the `attachmentKeys: []` default in both the
resolver call and the persisted params, `mode: "preview"` writing and transitioning nothing, the
whole action pipeline over that dispatch, and that the executed result exposes only identifiers
and hrefs. The two original suites were not deleted or weakened — only their fixtures were
updated to the new summary shape.

---

## 3. Other properties re-verified

- **Export / RLS / tenancy / `national_id` intact.** `lib/ai/resources/compile.ts` is untouched
  by the remediation (mtime predates it): the `ai.bulk_export` gate on pages beyond the first
  ([compile.ts:367](lib/ai/resources/compile.ts#L367)) and the `maxListRows: 25` enforcement for
  the explicit-only `national_id` ([definitions/patients.ts:26-31,138](lib/ai/resources/definitions/patients.ts#L26))
  still apply. `resourceExportSuggestion` still checks catalog role ∧ `ai.documents` ∧
  `assertDocumentTypeAccess` before emitting and grants nothing. The `documents` resource still
  declares no snapshot/params field, and the issue action returns only ids and hrefs — asserted
  by a dedicated dispatch test. Document bodies still never enter model context. The
  cross-tenant document read and the receptionist receipt-ledger cases pass against real RLS.
- **Service-role confined to the retention control plane.** `purgeAiRetentionData` in
  `lib/supabase/admin.ts` remains the only new service-role surface;
  `admin-client-static-guard.test.ts` passes.
- **No Phase 7 leakage.** `lib/ai/eval/injection-corpus.ts` (mtime 2026-08-14 02:26, before the
  remediation) and `lib/ai/eval/eval-set.ts` contain no document or retention case; no
  `supersededBy` unmount exists anywhere in `lib/ai/`; `types/database.ts` is additive-only.
- **Unrelated dirty work preserved.** `describeDocumentIssueFailure` / `DocumentIssueStage` in
  `lib/documents/issuance.ts` and `findCompletedClinicDocument` in `lib/supabase/admin.ts` are
  present and still consumed; the six retargeted P7 source-contract tests and the whole
  `tests/unit/lib/p7*` + `tests/unit/components` set are green.

### The `GENERIC_DOCUMENT` feature-key question — non-blocking, and correct as built

Point 3 of the original P6-01 asked whether `GENERIC_DOCUMENT` should sit behind its own
feature key. The plan is explicit on this: §10 states *"The `ai.documents` feature key gates the
whole family."* Gating it separately would be a **deviation** from the approved plan, not
compliance with it, so declining to take that decision here is right. The mitigation the
finding actually demanded is implemented and tested (full body on the card, provenance stated,
oversize refused rather than truncated), and §9.14 records the hook —
`assertClinicalIssuanceFeature`'s conditional shape — if the product owner later decides to
gate it. No action required for Phase 6.

---

## 4. Remaining finding

### P6-12 — a record that is out of scope or does not exist is reported as `transient_failure`

**Severity:** Low
**Files:** [lib/ai/documents/capability.ts:366-369](lib/ai/documents/capability.ts#L366),
[lib/documents/mutations.ts:1024-1031](lib/documents/mutations.ts#L1024)
**Introduced by:** the P6-06 remediation (§9.6)

`previewDocumentCore` wraps its entire resolver call in one `try/catch` that collapses every
thrown error to `domainFailure("previewFailed")`. `prepareDocumentIssue` now maps that whole
bucket to `{ status: "transient_failure" }`. But `previewFailed` is not only the infrastructure
bucket — it is also how the resolvers report *"that record is not in your data"*, because they
signal an empty RLS result by throwing:

- `roster-profile.ts:167` — `throw new Error("Patient not found")`
- `roster-profile.ts:220` — `throw new Error("Staff member not found")`
- `clinical-document.ts:106,122,133` — `Prescription / Lab request / Sick leave not found`
- `patient-history.ts:241,246` — `Patient not found` (including the explicit access check)

Verified empirically, not inferred: driving `prepareDocumentIssue` for `PATIENT_FILE` with the
real code path and the resolver failing exactly as it does on an empty RLS result returns

```
{"status":"transient_failure","document_type":"PATIENT_FILE"}
```

Before P6-06 this case returned `unauthorized_scope`, which was the **correct** row for it. The
remediation fixed the rare case (a genuine 5xx) by mis-classifying the common one.

**Why it matters.** §11's taxonomy assigns `unauthorized_scope` to *"RLS returned nothing /
record outside scope"* and `transient_failure` to *"Timeout / 5xx"*, with the behaviours
*"Never retries"* and *"One retry, then explains and offers the UI path"* respectively. As
built, a user who names a patient the Assistant cannot see is told the problem is temporary and
asked to try again, the Assistant burns a retry on a permanently failing call, and the
`ai_action_receipts` row records `denialReason: "transient_failure"` for what was actually a
scope miss — degrading the §12 ledger's ability to answer *why* an attempt was refused. It is
the same class of defect P6-06 was raised about, pointing the other way.

**Not a security or enumeration problem.** Both "does not exist" and "not yours" produce the
identical `transient_failure` shape, so §11's non-distinguishability property holds. The
reprint path is unaffected — `reprintDocumentCore` still collapses out-of-scope id,
unregistered type and role/report denial to `documentNotFound` before the status check, and the
RLS integration test still proves a cross-tenant document id returns empty rather than denied.
That is why this is Low.

**Required fix.** Distinguish "resolved to nothing" from "the resolution itself failed" instead
of routing both through one code. Either:

- add a `documentSubjectNotFound` failure code that `previewDocumentCore` returns when the
  thrown error is the resolvers' own not-found signal (give the resolvers a typed error rather
  than matching on message text), and map it to `unauthorized_scope`; **or**
- resolve subject existence explicitly before the snapshot call — the pattern
  `resolveClinicalRecordIssueState` already establishes for clinical types — and return
  `unauthorized_scope` when it comes back empty, leaving `previewFailed` to mean only a genuine
  infrastructure failure.

The first is preferable: it fixes all seven resolver sites at once and does not add a
round-trip.

**Acceptance criteria.**
- A test drives `prepareDocumentIssue` for `PATIENT_FILE` with a patient id the caller cannot
  see and asserts `unauthorized_scope`, with the existing forced-`previewFailed` test still
  asserting `transient_failure` as a negative control.
- The same pair for a clinical type (`PRESCRIPTION` with an invisible `recordId`) and for
  `STAFF_FILE`.
- A test asserts a non-existent id and an out-of-scope id produce byte-identical outcomes, so
  the fix does not reintroduce an enumeration signal.
- A `documents.issue` preview for an out-of-scope subject records
  `denialReason: "unauthorized_scope"` on the receipt.

---

## 5. Summary

| ID | Severity | Status |
|---|---|---|
| P6-01 | High | **Fixed** — full body on the card, provenance stated, oversize refused not truncated |
| P6-02 | Medium | **Fixed** — Reports-page gate covers all `/reports` types; parity re-derived independently |
| P6-03 | Medium | **Fixed** — disclosed at preview, both ids in the receipt, `ai.write_records` enforced on both phases |
| P6-04 | Medium | **Fixed** — title and `active_context` scrubbed, row never deleted, verified on real Supabase |
| P6-05 | Low | **Fixed** — `valid_document_types` set-equal to `describe_documents` |
| P6-06 | Low | **Fixed as specified** — `transient_failure` outcome and `ActionTransientError` threaded (see P6-12) |
| P6-07 | Low | **Fixed** — server-derived context on both phases; canonical input bound to the token, withheld from the model |
| P6-08 | Low | **Fixed** — `unknown_keys` on every outcome and on the card |
| P6-09 | Low | **Fixed** — localized title, `language` row, locale from the conversation |
| P6-10 | Low | **Fixed** — `cache()` plus an explicit hoist; one read asserted |
| P6-11 | Low | **Fixed** — drain loop with pass/time ceilings and a Sentry backlog signal |
| §4 note | — | **Fixed** — 31-test suite over the real per-family dispatch |
| **P6-12** | **Low** | **Open** — out-of-scope / non-existent record reported as `transient_failure` |

Phase 6 is architecturally sound and the remediation is substantive rather than cosmetic: the
fixes are in the real code paths, not in the test doubles, and the new suites drive the genuine
per-family dispatch, the real confirmation card, and a real local Postgres. The single open
item is one mapping in one file with a well-defined fix and no security impact. Once P6-12 is
addressed with the coverage above, this phase passes.
