# AI Assistant — Phase 6 Implementation Report

**Phase:** 6 — Documents, export, retention (`docs/plans/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md` §15)
**Depends on:** Phases 3 and 5 (complete)
**Status:** implementation complete + **all 12 review findings (P6-01 … P6-12) remediated**, self-verified.
**Not re-reviewed. No review approval or PASS is claimed here.**
**Phase 7 was not started.**

> **Reading order.** §§1–8 describe the original Phase 6 implementation as it was
> submitted for review. **§9 is the remediation of `AI_ASSISTANT_PHASE_6_REVIEW.md`**
> and supersedes §§1–8 wherever the two disagree; §5 and §7 have been updated in
> place to reflect the post-remediation state. **§10 is the remediation of P6-12**,
> the single finding left open by the re-review, and supersedes §9.6 where the two
> disagree.

---

## 1. Scope delivered

Plan §15 Phase 6 asks for three things and one refactor:

| Plan requirement | Delivered |
|---|---|
| **New:** `lib/ai/actions/definitions/documents.ts` | `documents.issue` (sensitive) and `documents.reprint` (normal) registered actions |
| **New:** export path | Bulk-read → document escape hatch on truncated `query_resource` results (§7.5) |
| **New:** retention job | Fixed-window purge for `agent_messages`, `ai_action_receipts`, `ai_action_confirmations` + scheduled cron |
| **Changed:** `lib/documents/*` — extract `(user, params)` cores from the `issue*` server actions | `lib/documents/mutations.ts`; all seven document families' issuance bodies moved there; the server actions are now thin adapters |
| Slot-filling loop (§10) | `lib/documents/slots.ts` + `lib/ai/documents/capability.ts` + the `describe_documents` / `preview_document` tools |

---

## 2. What was implemented

### 2.1 Session-free document cores (§8.1 extraction rule)

`lib/documents/mutations.ts` (new) now owns everything that used to sit inside the
`issue*` server actions after their session guard: params schema selection,
snapshot resolution, catalog-derived numbering prefix / period key / sequence
padding, the idempotency-key shape, and the `issueDocumentFoundation` call.

Seven per-family cores, one per document archetype:

- `issueRevenueDocumentCore`
- `issueAnalyticalDocumentCore`
- `issueRosterProfileDocumentCore`
- `issueInvoiceDocumentCore` (wraps the already session-free `issueInvoiceDocument`)
- `issuePatientHistoryDocumentCore`
- `issueClinicalDocumentCore` (takes an injectable record finalizer)
- `issueGenericDocumentCore`

plus a generic dispatcher `issueDocumentCore(user, input, mode)`, a read-only
`previewDocumentCore`, `reprintDocumentCore`, and the authorization helper
`assertDocumentTypeAccess`.

`assertDocumentTypeAccess` mirrors the UI's own stack exactly — catalog
`pageRoles`, plus Reports page visibility and the per-user report grant for
report-backed types — but returns a value instead of calling `notFound()`, which
is what makes it callable from the agent. **The Assistant is not granted a single
document type the UI would not grant the same user.**

The corresponding server actions in `actions/documents.ts`,
`actions/clinical-documents.ts`, and `actions/generic-documents.ts` are now thin
adapters: session guard → `requireActiveSubscription` → core → map to the
existing UI error codes. The UI and the Assistant therefore issue documents
through byte-identical code.

Behaviour deliberately preserved through the move:
- Invoice issuance keeps its structured Postgres-field logging
  (`describeDocumentIssueFailure(error, "invoice-action")`), which the generic
  stage-only failure shape would have dropped.
- Clinical issuance keeps its controlled-medicine block and its
  record-derived idempotency key (`clinical:<type>:<recordId>:<locale>`).
- The UI's clinical path still passes its own session-scoped
  `ensureClinicalRecordFinalizedForIssue`; the Assistant path uses
  `finalizeClinicalRecordForIssue`, built on the Phase 5c
  `transitionClinicalRecordMutation` domain core.

### 2.2 Slot filling (§10)

`lib/documents/slots.ts` (new, pure, dependency-free) projects each catalog
entry's `filterSchema` onto the keys of that type's own params schema:

- `documentIssueSlots(code)` — required/optional slots with a resolver hint
  (`patient`, `staff`, `doctor`, `department`, `appointment`, `clinical_record`).
- `evaluateDocumentSlots(code, params)` — `filled` / `missingRequired` /
  `optional` / `unknownKeys` / `ready`.
- `autoFillDocumentSlots(code, params, hint)` — fills reporting periods through
  the same `resolveDateRange()` core the reports pages use, and the active
  patient/appointment from server-derived conversation context. Never overwrites
  an explicitly supplied value.
- `documentValidationQuestions(code, issues)` — turns zod issues into per-slot
  questions (§10 step 5: validation errors become questions, not failures).
- `undeclaredSlotFilterKeys(code)` — registry invariant: a slot may never claim
  a filter the catalog does not declare.

`lib/ai/documents/capability.ts` (new) composes those behind the `ai.documents`
plan gate:

- `describeIssuableDocuments(user, { query })` — permission-filtered; a type the
  user may not issue is **absent**, never denied.
- `prepareDocumentIssue(user, input, hint)` — auto-fill → evaluate → validate →
  resolve snapshot, returning one of `not_supported` / `unauthorized_scope` /
  `missing_information` / `invalid_input` / `ready`. It returns the auto-filled
  params it validated, so the issue action operates on exactly that object.

### 2.3 AI surface

**Two new read tools** (§11 classes a document preview as `read`, so neither
takes a confirmation):

| Tool | Roles | Features | Task classes |
|---|---|---|---|
| `describe_documents` | all staff | `ai_assistant`, `ai.documents` | shared |
| `preview_document` | all staff | `ai_assistant`, `ai.documents` | shared |

Both are mounted for every staff role on purpose: the catalog's `pageRoles` and
the report-visibility gate decide what each role actually sees, so declaring a
narrower role list here would be an AI-local restriction the app does not have.

Presentation entries and EN/AR strings were added
(`toolDescribeDocuments`, `toolPreviewDocument`).

**Two new actions**, running the standard Phase 3 preview → server-minted
single-use token → confirm → re-authorize → receipt pipeline:

| Action | Risk | Feature | Page slug |
|---|---|---|---|
| `documents.issue` | `sensitive` (confirm always, per §11) | `ai.documents` | `documents` |
| `documents.reprint` | `normal` | `ai.documents` | `documents` |

`documents.list` needed no new surface: the `documents` resource added in Phase 1
already serves it through `query_resource`, and its catalog base filter makes an
unauthorized type invisible rather than denied.

Idempotency (§8.4) comes from `context.idempotencyKey`, which is derived from the
single-use confirm token — a confirmed issue retried with the same token reuses
the same document and number; a replay is refused outright.

### 2.4 Bulk-read → document escape hatch (§7.5)

`lib/ai/resources/export-hatch.ts` (new). When a `query_resource` page is
`truncated`, the result now carries an `export_suggestion` naming the document
type that covers that resource (`patients` → `PATIENT_LIST_REPORT`, `profiles` →
`SYSTEM_MEMBERS_REPORT`, `follow_ups` → `FOLLOW_UP_PAGE_REPORT`, `appointments` →
`APPOINTMENT_HISTORY_REPORT`, `patient_packages` → `PACKAGE_HISTORY_REPORT`) plus
guidance to offer that document instead of paging.

It is emitted **only** when the caller could genuinely issue that type (plan
feature ∧ catalog role ∧ report visibility), so it can never advertise a
capability that would then be denied. It grants nothing: issuing still runs the
full action pipeline. The pre-existing `ai.bulk_export` gate on pages beyond the
first (Phase 1) is untouched.

### 2.5 Retention (§13 audit finding M2, §12, decision 6)

`lib/ai/retention.ts` (new) holds one named constant per dataset:

| Constant | Value |
|---|---|
| `AI_MESSAGE_RETENTION_DAYS` | 180 |
| `AI_ACTION_RECEIPT_RETENTION_DAYS` | 400 |
| `AI_ACTION_CONFIRMATION_RETENTION_DAYS` | 30 |
| `AI_RETENTION_BATCH_LIMIT` | 10 000 |

Migration `20260814130000_ai_assistant_phase6_retention.sql` adds
`public.purge_ai_retention_data(...)`: `security definer`, `service_role` only,
revoked from `public`/`anon`/`authenticated`, with `set search_path = ''`. The
windows are **arguments, not SQL literals**, so making retention clinic-
configurable later is a lookup change in `lib/ai/retention.ts` and nowhere else
(decision 6's "structured so it can become clinic-configurable later without
rework").

It fails closed: a window below 1 day, an out-of-range batch limit, or a receipt
window shorter than the message window all raise rather than delete.

Deliberately **not** deleted:
- `agent_conversations` — `ai_action_receipts` and `ai_action_confirmations`
  cascade from it, so purging a conversation would destroy accountability
  records ahead of their own window.
- `audit_logs` — the clinic's permanent audit trail, never AI-scoped.
- Claimable confirmation tokens — only spent or expired ones are purged,
  regardless of age.

Three `created_at` indexes were added so the age scans do not become seq scans.

`app/api/cron/ai-retention/route.ts` (new) mirrors the existing cron routes'
`CRON_SECRET` bearer guard and leaks no database detail on failure. Scheduled in
`vercel.json` at `30 3 * * *`. The purge is idempotent, so a failed or partial
run is simply picked up by the next one.

---

## 3. Files changed

### New
```
lib/documents/mutations.ts
lib/documents/slots.ts
lib/ai/documents/capability.ts
lib/ai/actions/definitions/documents.ts
lib/ai/resources/export-hatch.ts
lib/ai/retention.ts
lib/ai/tools/describe-documents.ts
lib/ai/tools/preview-document.ts
app/api/cron/ai-retention/route.ts
supabase/migrations/20260814130000_ai_assistant_phase6_retention.sql
tests/unit/ai/phase6-documents.test.ts
tests/unit/ai/phase6-document-actions.test.ts
tests/unit/ai/phase6-retention.test.ts
tests/unit/integration/phase6-documents-retention-rls.test.ts
```

### Modified
```
actions/documents.ts                 — thin adapters over the five cores it owns
actions/clinical-documents.ts        — thin adapter over issueClinicalDocumentCore
actions/generic-documents.ts         — thin adapter over issueGenericDocumentCore
lib/ai/actions/registry.ts           — mounts DOCUMENT_ACTION_DEFINITIONS
lib/ai/tools/registry.ts             — mounts describe_documents + preview_document
lib/ai/tools/query-resource.ts       — attaches export_suggestion on truncation
lib/ai/tool-presentation.ts          — presentation entries for the two new tools
lib/supabase/admin.ts                — purgeAiRetentionData wrapper
messages/en.json, messages/ar.json   — toolDescribeDocuments, toolPreviewDocument
types/database.ts                    — purge_ai_retention_data (added surgically)
vercel.json                          — /api/cron/ai-retention schedule
```

### Migration
One: `supabase/migrations/20260814130000_ai_assistant_phase6_retention.sql`.
Applied to **local** Supabase only (`supabase db push --local`). Nothing was
pushed, deployed, or applied remotely.

`types/database.ts` was edited surgically — a single `purge_ai_retention_data`
entry inserted in alphabetical order — per the known ~1184-line drift between a
local regen and the committed remote-generated file.

### Existing tests updated (retargeted, not weakened)

Six P7 source-contract tests assert the *text* of the issuance bodies. Those
bodies moved to `lib/documents/mutations.ts`, so the tests were retargeted to the
new location with every assertion's substance preserved (and in several cases
strengthened with an extra assertion that the server action now delegates):

```
tests/unit/lib/p73-revenue-document-contract.test.ts
tests/unit/lib/p74-analytical-document-contract.test.ts
tests/unit/lib/p712-patient-history-document-contract.test.ts
tests/unit/lib/p76-clinical-document-contract.test.ts
tests/unit/lib/p77-invoice-document-contract.test.ts
tests/unit/lib/p7-followups-filter-flow.test.ts
```

`tests/unit/ai/phase3-action-foundation.test.ts` — the registry-size assertion
moved 87 → 89 for the two new document actions.

No test was deleted or relaxed to make the implementation pass.

---

## 4. Test coverage added

### Unit — `tests/unit/ai/phase6-documents.test.ts` (32 tests)
Slot projection (a slot set for every registered type; no slot claims a filter
the catalog lacks; every slot is a real key of the type's own params schema;
required subject slots per subject-bound type); slot evaluation (only genuinely
missing required slots are reported; optional slots are never asked for);
auto-fill (period through the shared date-range core; never overwrites an
explicit value; active patient from server-derived context; no period invented
when none is implied); validation-as-questions; capability filtering (role miss
omits, hidden report grant omits, `ai.documents` off denies the family; unknown
type → `not_supported`; unauthorized type indistinguishable from unavailable;
missing slot short-circuits before any snapshot resolution; ready path returns
the validated params); registry invariants (risk classes, features are
`isKnownAiFeature`, page slug, no AI-local role narrowing, one reprint RPC per
family, every type mapped to a family); export hatch (offered, and silent when
the feature, the role, or a covering type is missing).

**Adversarial:** injected instructions inside a document request do not widen
the permitted type list; a SQL-flavoured type string is `not_supported`; a
smuggled `clinic_id`/`table` key is reported as unknown and never reaches the
params schema.

### Unit — `tests/unit/ai/phase6-document-actions.test.ts` (12 tests)
Preview never issues and mints a server-side token; the confirmation card
identifies the exact document; a missing required slot refuses at preview; an
unauthorized type and an unknown type refuse identically; `ai.documents` off
yields `plan_not_entitled` with a denied receipt; execute issues once with a
token-derived idempotency key; the token is burned (replay refused, core called
once); a token minted for different params is rejected; authorization is
re-asserted at execute (a feature revoked between phases denies a confirmed
issue); a domain refusal is relayed as `business_rule_refused`, never as success.
Reprint: preview shows the exact print-count delta without reprinting; an
out-of-scope id refuses without revealing whether it exists.

### Unit — `tests/unit/ai/phase6-retention.test.ts` (11 tests)
One named constant per window; ledger strictly outlives transcripts; the
constants are passed to the purge and no day literal survives in the SQL; empty
and error paths; migration contract (service-role only, revoked from everyone
else, fails closed on a bad window, never deletes conversations or `audit_logs`,
only purges unclaimable confirmations, deletes exactly the three declared
datasets); the cron route is scheduled and secret-guarded.

### Integration / RLS — `tests/unit/integration/phase6-documents-retention-rls.test.ts` (6 tests)
Run against **local Supabase with real policies and real JWTs**:
the purge RPC is unreachable for an authenticated clinic admin; nonsensical and
inverted windows raise instead of deleting; expired messages/receipts/spent
confirmations are deleted on schedule while in-window rows, a still-claimable
token, and the conversation itself survive; a second run deletes nothing more
(idempotent); a cross-tenant document id returns empty rather than denied, so
"not yours" is indistinguishable from "does not exist"; a receptionist sees no
`ai_action_receipts`.

---

## 5. Verification actually run

Superseded by **§9.13**, which lists the post-remediation results. The
pre-remediation numbers were: 352 unit files / 2 606 tests, 112 adversarial
tests, 54 integration files / 468 tests, clean types, clean build, 0 lint errors.

Local Supabase keys are obtained per project convention:
`eval "$(supabase status -o env | grep -E '^(PUBLISHABLE_KEY|SECRET_KEY)=')"`.

---

## 6. Deviations and judgement calls

1. **§10's four "document tools" are split into two tools and two actions.**
   The plan's §10 table calls them "registered as actions, not bespoke tools",
   but §11's risk table classes a document *preview* as `read` — no
   confirmation — while the Phase 3 action pipeline issues a confirm token for
   every registered action by design. Rather than weaken that reviewed pipeline
   with a read-only risk class, `documents.describe` and `documents.preview`
   ship as registry-declared *tools* and `documents.issue` / `documents.reprint`
   ship as *actions*. The declarative-registry intent (no bespoke per-document
   tool; one catalog-driven contract) is preserved; the confirmation model is
   unchanged.

2. **`documents.list` added no new surface.** The Phase 1 `documents` resource
   already serves listing through `query_resource` with the non-leaking catalog
   base filter §10 asks for. Adding a second listing path would have duplicated
   authorization logic, which the plan forbids.

3. **Slot projection is not bidirectional with `filterSchema`.** The invariant
   enforced is "no slot claims a filter the catalog does not declare"; the
   reverse is deliberately not asserted, because `filterSchema` is the documents
   *module's listing* vocabulary. `status`, `documentNumber`, `creator`, `date`,
   and an invoice's `patient`/`dateRange` describe how issued documents are
   *found*, not how one is *issued* — an invoice is issued from an appointment,
   not from a date range. This is documented in `lib/documents/slots.ts`.

4. **Retention windows (180 / 400 / 30 days) are a judgement call.** The plan
   fixes the *mechanism* (one named constant, scheduled purge, later
   configurable) but not the numbers. These are stated assumptions and are
   trivially changed in one file; the SQL refuses a receipt window shorter than
   the message window so a future edit cannot invert the accountability
   guarantee.

5. **`agent_conversations` is never purged.** The plan's M2 finding names
   `agent_messages` and `ai_action_receipts`. Deleting conversations would
   cascade-delete receipts and confirmations ahead of their own windows, so it is
   excluded and asserted against by test.

6. **The per-archetype reprint server actions were left in place.** Their only
   logic beyond the session guard is a single RPC name, so refactoring them
   would have added churn without removing business logic. `reprintDocumentCore`
   owns the family → RPC table for the Assistant path, and a test asserts that
   table's shape (one distinct RPC per family, matching the actions' names).

## 7. Unresolved issues

Both open items below were **resolved** by the review remediation:

- ~~Locale on `documents.issue` defaults to `"en"`~~ — resolved in **P6-09**
  (§9.9). `ActionExecutionContext` now carries the conversation's locale.
- **The retention cron requires `CRON_SECRET`** to be set in the deployment
  environment (already required by the two existing cron routes). No environment
  change was applied; nothing was deployed. *(Still true, unchanged.)*

The remaining known items after remediation are listed in **§9.14**.

---

## 8. Boundaries respected

- **Phase 7 was not started.** `lib/ai/eval/injection-corpus.ts` and
  `lib/ai/eval/eval-set.ts` were not modified; no superseded tool was unmounted;
  no dead code was deleted; `types/database.ts` was not regenerated wholesale.
  The Phase 6 adversarial coverage lives in the Phase 6 test files.
- **Nothing was pushed, deployed, or applied remotely.** The single migration
  was applied to the local stack only.
- **No unrelated dirty work was modified.** Changes are confined to the document
  platform, the AI document/retention surface, and their tests.
- **Existing security guarantees intact:** no service-role client entered the AI
  read/write path; every document read and write still runs on the caller's
  RLS-scoped session client; the preview → confirm → re-authorize → receipt
  pipeline is unchanged and now covers the two new actions; the injection and
  containment suites remain green.
- **No test was weakened or deleted** to make the implementation pass.

---

**This report claims implementation completeness and the verification results
listed in §5. It does not claim review approval or a PASS.**

---

## 9. Review remediation — P6-01 through P6-11

Source: `docs/reports/AI_ASSISTANT_PHASE_6_REVIEW.md` (verdict **NOT PASS** —
1 High, 3 Medium, 7 Low). All eleven findings are fixed. Phase 7 was **not**
started, and no change outside the Phase 6 surface and its immediate dependencies
was made.

| ID | Severity | Status |
|---|---|---|
| P6-01 | **High** | Fixed — full authored body projected into the preview; oversize refused, never truncated |
| P6-02 | Medium | Fixed — Reports-page gate now covers all analytical types |
| P6-03 | Medium | Fixed — finalization disclosed at preview, audited at execute, gated on `ai.write_records` |
| P6-04 | Medium | Fixed — new migration scrubs `title` + `active_context`; row never deleted |
| P6-05 | Low | Fixed — `valid_document_types` is permission-filtered |
| P6-06 | Low | Fixed — new `transient_failure` outcome and `ActionTransientError` |
| P6-07 | Low | Fixed — resolver context on both action phases; resolved input bound to the token |
| P6-08 | Low | Fixed — `unknown_keys` on every outcome and on the card |
| P6-09 | Low | Fixed — localized title, `locale` change row, locale derived from the conversation |
| P6-10 | Low | Fixed — `cache()` + explicit hoist; one `user_page_permissions` read per describe |
| P6-11 | Low | Fixed — cron drains with a pass/time ceiling and reports a remaining backlog |
| §4 note | — | Fixed — new suite drives the real `issueDocumentCore` dispatch per family |

---

### 9.1 P6-01 — the `GENERIC_DOCUMENT` body is now on the confirmation card

**What was wrong.** `snapshotHighlights` projected only `range`, `from`, `to`,
`subject.fullName`, `patient.fullName` and `title`, capped at six entries.
`blocks` — up to 60 × 4 000 characters of model-authored text — was never
projected, so the user confirmed a clinic-branded, permanently numbered,
externally verifiable document whose entire body was invisible to them.

**Fix.**

1. `DocumentSnapshotSummary` gained a `body: { label; text }[]` field
   ([lib/documents/mutations.ts](../../lib/documents/mutations.ts)).
   `snapshotBody(code, snapshot)` projects the authored title plus **every**
   block, in order, verbatim, each labelled `body <n> (heading|paragraph)`.
   It returns `[]` for every data-derived type, whose content is a rendering of
   clinic records the user can inspect elsewhere — that distinction is why this
   is not simply "dump the snapshot".
2. `issueChanges` emits one preview change row per body entry, so the card
   renders the complete text ([lib/ai/actions/definitions/documents.ts](../../lib/ai/actions/definitions/documents.ts)).
3. `issueAction.preview.summary` now appends, whenever a body is present: *"The
   title and body shown below were composed by the Assistant, not taken from
   clinic records. They will appear verbatim on a document carrying this clinic's
   name, logo, licence number and tax id, with a permanent document number and an
   externally verifiable code. Read the full text before confirming."*
4. **No silent truncation.** `MAX_ASSISTANT_AUTHORED_BODY_CHARS = 20_000` caps
   what the Assistant path will issue. Above it, `prepareDocumentIssue` returns
   `content_too_long` and the action refuses with
   `documents.authored_body_too_long:<actual>/<cap>` — the review's explicit
   instruction ("state the cap and refuse rather than issue an unshown
   remainder"). The document platform's own schema limit (240 KB) is unchanged;
   a user authoring that much text does it in the UI, where they read it all.

**Point 3 of the review's required fix** (whether `GENERIC_DOCUMENT` belongs in
the Assistant surface at all, or behind its own feature key) is a product
decision and is **not** taken here — see §9.14.

**Tests.**
- `tests/unit/ai/phase6-document-dispatch.test.ts` — "emits every block of a
  GENERIC_DOCUMENT, in order and untruncated" (12 blocks, each asserted
  character-for-character); "projects no body for a data-derived type"; "shows
  the full authored body and its provenance on the confirmation card"; "refuses
  rather than issuing an unshown remainder above the body cap"; and the
  adversarial case "shows body text an injection steered the model into
  composing" (a stored-injection payload is asserted present in full on the card).
- `tests/unit/components/phase6-document-confirmation-card.test.tsx` — renders
  the real card and asserts every block is visible **while the confirm control is
  still un-pressed and enabled**.

---

### 9.2 P6-02 — the Reports-page gate now matches the UI for all analytical types

**What was wrong.** `assertDocumentTypeAccess` applied the page + report
visibility pair only when `resolver.kind === "report"`. `SALES_REPORT` and
`FOLLOW_UP_ANALYTICS_REPORT` declare `resolver.kind === "document"`, so the AI
path checked catalog `pageRoles` and `pageSlug: "documents"` and nothing else —
while the UI routes exactly those two through `requireReportsIndexAccess()`,
which `notFound()`s when the `reports` page is hidden for that user. A gate
*below* app authorization was missing.

**Fix.** New `requiresReportsPageVisibility(code)` in
[lib/documents/mutations.ts](../../lib/documents/mutations.ts):

```ts
reportIdFor(code) !== null
  || documentIssueFamily(code) === "analytical"
  || getDocumentCatalogEntry(code).issuanceTrigger.href.startsWith("/reports")
```

`assertDocumentTypeAccess` requires `getPageVisibilityState(user, "reports") ===
"visible"` for every such type, and still additionally requires the per-report
grant for the six report-backed ones (unchanged). It continues to fail closed on
`lookup_failed`.

**Tests** — `tests/unit/ai/phase6-review-fixes.test.ts`:
- both types denied with `reportNotVisible` when the Reports page is hidden, and
  allowed when visible (negative control in both directions);
- the parity sweep the review asked for: **all 21 registered types × 5 roles ×
  {reports visible, reports hidden}**, asserting `assertDocumentTypeAccess`
  returns `ok` exactly when the corresponding `actions/**` helper would not
  `notFound()`;
- `describeIssuableDocuments` omits both types for a Reports-hidden user while
  still listing `GENERIC_DOCUMENT`;
- `resourceExportSuggestion(user, "follow_ups")` is silent for that user.

---

### 9.3 P6-03 — clinical finalization is disclosed, audited, and separately gated

**What was wrong.** Issuing a `PRESCRIPTION` / `LAB_REQUEST` /
`SICK_LEAVE_CERTIFICATE` transitions the draft record to `finalized` as a side
effect. The card said only *"document: not issued → PRESCRIPTION"*; the receipt's
`target_table`/`target_record_ids` named only the document; and the composite was
gated on `ai.documents` alone, so a tier withholding `ai.write_records` still
mutated a clinical record.

**Fix — all three parts of the required fix.**

1. **Preview discloses it.** New `resolveClinicalRecordIssueState(user, code,
   recordId)` reads (never writes) the record's current status on the caller's
   RLS client. `prepareDocumentIssue` calls it for clinical types *before*
   resolving a snapshot and returns `clinical_record: { table, record_id, status,
   will_finalize }` on the ready outcome. `issueChanges` emits a change row
   `prescriptions <id>: draft → finalized` with `identifiesRecord: true`, and
   `issueSummary` appends *"Confirming also finalizes prescriptions <id>. A
   finalized clinical record cannot return to draft; it can only be voided
   afterwards."* A record that is neither `draft` nor `finalized` returns
   `record_not_issuable` at **preview**, naming the state, instead of surfacing
   as a generic execute-time failure.
2. **The receipt records it.** `issueAudit` in
   [lib/documents/mutations.ts](../../lib/documents/mutations.ts) takes an
   optional `sideEffect`, and `issueClinicalDocumentCore` captures the record's
   status *before* the transition and passes it. `targetRecordIds` is now
   `[documentId, recordId]`, and `before`/`after` carry
   `prescriptions.<id>: draft` → `finalized`. The §12 ledger can now answer
   "which prescription did the Assistant finalize".
3. **Decision on `ai.write_records`, and it is enforced.** A clinical-document
   issuance is a clinical-record mutation, so it requires **both**
   `ai.documents` and `ai.write_records`. `requiredFeatures` is static per
   action, so `assertClinicalIssuanceFeature` applies the second gate
   conditionally on the family, on **both** phases, throwing
   `AiToolAuthorizationError("feature_not_entitled")`. `executeRegisteredAction`
   / `previewRegisteredAction` now map a definition-thrown
   `AiToolAuthorizationError` through the existing `mappedAuthorizationReason`,
   so it lands as a `plan_not_entitled` **denial with a denied receipt** rather
   than an unhandled error.

**Tests** — `tests/unit/ai/phase6-document-dispatch.test.ts` (real dispatch):
draft record is transitioned through the shared Phase 5c core and audited with
both ids; already-finalized is not re-transitioned; a `void` record refuses
without issuing or transitioning; a controlled medicine still blocks before the
record is touched; the executed receipt's `targetRecordIds` is
`[documentId, recordId]`; withholding `ai.write_records` denies the clinical
issuance with `plan_not_entitled` **and the same tier still issues a revenue
report** (negative control). `tests/unit/ai/phase6-review-fixes.test.ts` covers
the preview-outcome shapes, including that a non-clinical type never resolves a
record state at all.

---

### 9.4 P6-04 — retention now scrubs the conversation row's own free text

**What was wrong.** The purge deleted `agent_messages` and deliberately never
deleted `agent_conversations` (correct — receipts and confirmations cascade from
it). But it left the row *entirely untouched*, and `agent_conversations.title` is
a verbatim copy of the user's first message (`userText.trim().slice(0, 120)`)
while `active_context` holds the patient/appointment ids that re-identify it.
Both survived indefinitely, so the stated retention guarantee was materially
weaker than the policy claimed.

**Fix.** New migration
`supabase/migrations/20260814150000_ai_assistant_phase6_retention_scrub.sql`
drops and recreates `purge_ai_retention_data` with a fourth step and a fourth
return column `scrubbed_conversations`:

```sql
with scrubbable as (
  select c.id from public.agent_conversations c
  where c.created_at < p_now - make_interval(days => p_message_retention_days)
    and (c.title is not null or c.active_context is distinct from '{}'::jsonb)
    and not exists (select 1 from public.agent_messages m
                    where m.conversation_id = c.id)
  order by c.created_at limit p_batch_limit
)
update public.agent_conversations c
set title = null, active_context = '{}'::jsonb
from scrubbable where c.id = scrubbable.id;
```

- **`update`, never `delete`** — referential integrity for receipts and
  confirmations is untouched.
- **`active_context` is set to `'{}'::jsonb`, not `null`**, because the column is
  `not null default '{}'::jsonb` ([the P4.10A migration](../../supabase/migrations/20260725120000_p410a_conversation_context.sql));
  `'{}'` is the empty equivalent the review asked for.
- **Idempotent by predicate**: an already-scrubbed row no longer matches
  `title is not null or active_context is distinct from '{}'`.
- Every other property preserved: `security definer`, `set search_path = ''`,
  `service_role` only, revoked from `public/anon/authenticated`, windows as
  arguments, fail-closed validation, `limit p_batch_limit`. A
  `agent_conversations_created_at_idx` index keeps the scan off a seq scan.

`lib/ai/retention.ts` reports `scrubbedConversations`; `types/database.ts` gained
the one new return column, edited surgically per the known local-regen drift.

**Tests.**
- `tests/unit/integration/phase6-documents-retention-rls.test.ts` (**real local
  Supabase, real policies, real JWTs**): a conversation past the window whose only
  message expired keeps its row but has `title === null` and
  `active_context === {}`; an equally old conversation with an in-window message
  keeps **both** untouched (this is what proves the `not exists` guard, not just
  the age guard); a second run reports `scrubbed_conversations: 0`; the scrubbed
  conversation's `ai_action_receipts` row and still-claimable
  `ai_action_confirmations` row are byte-identical afterwards.
- `tests/unit/ai/phase6-retention.test.ts` asserts the migration contract.

---

### 9.5 P6-05 — the `not_supported` path no longer enumerates hidden types

**What was wrong.** An unregistered `document_type` returned
`valid_document_types: getAccessibleDocumentTypeCodes(user.role)` — a **role-only**
list that named types the very next call would refuse by name.

**Fix.** New `accessibleDocumentTypeCodes(user)` in
[lib/ai/documents/capability.ts](../../lib/ai/documents/capability.ts) runs the
same permission-filtered path `describeIssuableDocuments` uses — role list →
`assertDocumentTypeAccess` per candidate (with the hoisted page read from §9.10).
`prepareDocumentIssue` builds `valid_document_types` from it.

**Test.** A user with the catalog role for `REVENUE_REPORT` but its report
visibility hidden asks for an unknown type: `REVENUE_REPORT` is absent, and the
returned list is asserted **set-equal** to the `document_type`s
`describeIssuableDocuments` returns for the same user.

---

### 9.6 P6-06 — a transient failure is no longer reported as `unauthorized_scope`

**What was wrong.** Every non-`invalidInput` failure from `previewDocumentCore`
was mapped to `unauthorized_scope`, including `previewFailed` — which the core
returns for any thrown resolver / render / database error. A transient database
error made the Assistant tell the user their own data was out of scope.

**Fix.**
- `DocumentPreviewOutcome` gained `{ status: "transient_failure" }`;
  `prepareDocumentIssue` maps `previewFailed` to it and keeps
  `unauthorized_scope` for `documentTypeNotAvailable` / `reportNotVisible` /
  `documentTypeUnknown`.
- New `ActionTransientError` in
  [lib/ai/actions/errors.ts](../../lib/ai/actions/errors.ts), thrown by
  `requireReadyIssue`, so it does **not** become a permanent
  `business_rule_violation`. Both `previewRegisteredAction` and
  `executeRegisteredAction` map it to the `transient_failure` denial reason,
  which §11's taxonomy already defines and which carries the "retry once, then
  offer the UI path" behaviour.
- `preview_document`'s tool description now states what `transient_failure`
  means, so the model gets the same guidance on the read surface.

**Tests.** `prepareDocumentIssue` with a forced `previewFailed` yields
`transient_failure` (and a genuine authorization miss still yields
`unauthorized_scope` — negative control). In the real-dispatch suite, a resolver
that throws produces a `transient_failure` denial whose receipt records
`denialReason: "transient_failure"`, not `documents.type_unavailable`.

> **Superseded in part by §10 (P6-12).** This fix routed *every* thrown resolver
> error into `transient_failure`, but `previewFailed` was also the bucket the
> resolvers used to signal "that record is not in your data". §10 splits the two:
> `previewFailed` now means only a genuine transient/infrastructure failure, and a
> subject that resolved to nothing is reported as `unauthorized_scope`.

---

### 9.7 P6-07 — context auto-fill on the action path, and the resolved range bound to the token

Two defects, both fixed by one mechanism.

**(a) Conversation context was applied by `preview_document` but not by
`documents.issue`.** `ActionDefinition.preview` had no context parameter and
`ActionExecutionContext` carried none, so `prepareDocumentIssue(user, input)` ran
with no hint on either action phase. A `PATIENT_FILE` request that
`preview_document` reported `ready` became `missing_information` at
`documents.issue`.

**Fix.** New `ActionResolverContext`
(`{ conversationId, locale, activePatientId, activeAppointmentId, now? }`):

- `ActionDefinition.preview` takes it as a third argument;
  `ActionExecutionContext` extends it.
- New [lib/ai/actions/resolver-context.ts](../../lib/ai/actions/resolver-context.ts)
  resolves it **from the conversation row itself**, on the caller's RLS-scoped
  session client, in both phases. This matters: the preview runs in the chat
  route (which holds a hydrated `DoctorToolContext`) while the execute runs in
  the `confirmAssistantAction` server action (which holds only a conversation
  id). Reading it server-side in both places means it is identical across the two
  phases *and* never passes through the model. It fails soft to
  `DETACHED_RESOLVER_CONTEXT` (all-null), which makes an action **ask** rather
  than guess, and every id it yields is still re-authorized by the resolver that
  consumes it.
- Both `issueAction.preview` and `issueAction.execute` pass
  `{ patientId, appointmentId, locale, now }` from it into `prepareDocumentIssue`.

**(b) The confirm token digested the *input*, not the resolved dates.** A confirm
crossing a period boundary inside the 10-minute TTL issued a different period
than the one previewed, with the token still valid.

**Fix.** `ActionPreview` gained an optional `canonicalInput`. When an action
returns one, `previewRegisteredAction` re-parses it through the action's **own
input schema**, mints the confirm token over *that* object, and returns it to the
UI as `ActionPreviewSuccess.action_input`. `documents.issue` returns
`{ document_type, params: outcome.params, locale: outcome.locale, … }` — so the
server-resolved `from`/`to` and the context-derived `patientId` are pinned into
the input the token is bound to. `assistant-chat.tsx`'s confirm button sends
`preview.action_input ?? input`.

This **strengthens** the Phase 3 pipeline rather than relaxing it: the
canonicalisation may only produce input the action already accepts, and a client
that resends the model's original arguments simply fails the digest check and is
denied. `action_input` is not in the model-facing projection
(`modelSafeOutput` builds an explicit allow-list), so the token and the canonical
input both stay out of model context.

**Tests** — `tests/unit/ai/phase6-document-dispatch.test.ts`:
- with an active patient in the resolver context, `documents.issue` preview for
  `PATIENT_FILE` succeeds with **no** explicit `patientId`, and execute issues for
  that same patient (`issueDocumentFoundation` receives it);
- with no context patient it still asks (`missing_information`) — negative control;
- period binding: preview three minutes before a clinic-calendar month boundary
  (Europe/Istanbul), confirm five minutes later inside the TTL but in the next
  month → the issued range is the previewed one, and a negative control asserts
  that re-deriving `this_month` at confirm time really does give a different
  period, so the test would fail without the binding;
- resending the un-canonicalised model input is **denied** and nothing is issued.
- `tests/unit/components/phase6-document-confirmation-card.test.tsx` asserts the
  button sends `action_input` when present and falls back to the model input for
  an action that does not canonicalise (`documents.reprint`).

---

### 9.8 P6-08 — unknown params keys are reported, not silently dropped

**What was wrong.** `evaluateDocumentSlots` computed `unknownKeys` but
`prepareDocumentIssue` discarded them, so a mis-cased slot (`patient_id` for
`patientId`) came back as "missing `patientId`" with no signal that the supplied
key had been ignored — the model then re-asked the user for something it was
already given.

**Fix.** `unknown_keys` is now on the `missing_information`, `invalid_input`
**and `ready`** outcomes. `requireReadyIssue` appends `;unknown:<keys>` to the
`missing_information` refusal code, `issueChanges` renders an
`ignored input keys` row on the card, and `preview_document`'s description tells
the model the field exists.

**Test.** `prepareDocumentIssue` for `PATIENT_FILE` with `{ patient_id: <uuid> }`
reports `missing: ["patientId"]` **and** `unknown_keys: ["patient_id"]`; a ready
request with smuggled `clinic_id`/`table` keys reports both.

---

### 9.9 P6-09 — localized title, and the document's language is always stated

**What was wrong.** `DocumentSnapshotSummary.title` was the catalog's `titleKey`
(e.g. `documents.catalog.genericDocument`), interpolated straight into a change
row the card rendered verbatim. Separately, `locale` defaulted to `"en"` and
appeared in no change row.

**Fix.**
- New `getDocumentTypeLabel(code, locale)` in
  [lib/documents/module-labels.ts](../../lib/documents/module-labels.ts), sharing
  its literal-key table with the existing `getDocumentTypeLabels()` so the i18n
  gate still proves every key is referenced. `previewDocumentCore` takes an
  optional `locale` and resolves `title` through it; the raw key is preserved
  separately as `titleKey` for tests and logging.
- `issueChanges` emits a `language` change row on every issue preview.
- `issueInputSchema.locale` is now **optional**; when the model omits it the
  action uses `context.locale`, the conversation's own language, resolved from
  the `agent_conversations` row by the §9.7 machinery. An explicit model choice
  still wins. The resolved value is pinned into `canonicalInput`, so preview and
  execute cannot disagree about it.
- The dead `documentCatalogTitle()` helper (which returned a raw key) was
  removed so it cannot be reintroduced into a user-facing path.

**Tests.** No preview change row matches `/^documents\.catalog\./` (asserted over
every row of a real preview); `en` and `ar` produce different, non-key titles; an
`ar` conversation with no explicit locale yields a `language: ar` row and
`action_input.locale === "ar"`; an explicit `locale: "en"` overrides an `ar`
conversation. The card test asserts the same on the rendered DOM.

---

### 9.10 P6-10 — one `reports` page read per describe call

**What was wrong.** `describeIssuableDocuments` awaited `assertDocumentTypeAccess`
per role-accessible type inside a `Promise.all`; for an admin that was six
independent `getPageVisibilityState(user, "reports")` calls, each a fresh
`user_page_permissions` query. Unlike `getReportVisibilityState`, the page reader
was not memoized.

**Fix — both options the review offered, because neither alone is sufficient.**
1. `getPageVisibilityState`'s read is now wrapped in React `cache()` keyed on
   `(userId, clinicId, role, pageSlug)`, mirroring `readReportVisibilityFor`
   ([lib/server-page-permissions.ts](../../lib/server-page-permissions.ts)). This
   fixes every caller at once and cannot change a decision — `cache()` is
   per-request, so a permission changed between requests is still read fresh.
2. Because React `cache()` only dedupes **inside a request scope** (verified: it
   does not memoize outside one), the loop *also* hoists the single `reports`
   lookup and passes it to `assertDocumentTypeAccess` via a new optional
   `reportsPageVisibility` option. That is purely a read the caller already
   performed for the same `(user, "reports")` pair, so it cannot widen access.
   `accessibleDocumentTypeCodes` (§9.5) does the same.

**Test.** With the spied Supabase client, `describeIssuableDocuments` for an admin
performs **exactly one** `user_page_permissions` read.

---

### 9.11 P6-11 — the purge drains, and an exceeded window is observable

**What was wrong.** `AI_RETENTION_BATCH_LIMIT = 10_000` per table, one call per
nightly tick, and the route discarded the returned counts — a backlog larger than
10 000 rows drained at 10 000 rows/day with no signal, so data could sit past its
declared window indefinitely.

**Fix.** New `drainExpiredAiData()` in
[lib/ai/retention.ts](../../lib/ai/retention.ts) loops `purgeExpiredAiData` while
any dataset returns a saturated batch, stopping on the first short batch, on
`AI_RETENTION_MAX_PASSES = 20`, or on `AI_RETENTION_DRAIN_BUDGET_MS = 120_000`
(well inside the 300 s function limit). Each pass is an independent idempotent
transaction, so an interruption leaves the remainder for the next tick. It
returns `passes` and `backlogRemaining`.

`app/api/cron/ai-retention/route.ts` calls it, **returns the counts** instead of
discarding them, and — when `backlogRemaining` is true — raises a
`Sentry.captureMessage` at `warning` level with the per-dataset counts. The
retention window is a stated policy commitment, so exceeding it is now an
explicit signal rather than something inferred from a drain rate.

**Tests.** The loop re-invokes while saturated and stops on the first short batch
(3 calls); a single short batch does not cause a second round-trip; a permanently
saturated backlog sets `backlogRemaining` on the pass ceiling; an injected clock
proves the wall-clock budget stops it; a purge failure propagates instead of
reporting a partial success. The route's contract (drain call, backlog branch,
Sentry, counts in the response) is asserted from source.

---

### 9.12 Review §4 — the real document-family dispatch is now executed

The review's coverage note: `phase6-document-actions.test.ts` and
`phase6-documents.test.ts` mock `previewDocumentCore`, `issueDocumentCore` and
`reprintDocumentCore` wholesale, so **no test executed the per-family routing** —
not the `attachmentKeys` default, and not `finalizeClinicalRecordForIssue`.

**New suite:** `tests/unit/ai/phase6-document-dispatch.test.ts` (31 tests). Here
`issueDocumentCore`, `previewDocumentCore` and every per-family core run **for
real**; only the data layer beneath them is stubbed — snapshot resolvers,
`issueDocumentFoundation`, `issueInvoiceDocument`, the PDF renderer,
`transitionClinicalRecordMutation`, and a chainable PostgREST stub that also
records which tables were read (which is what makes the §9.10 assertion
possible). It asserts:

- each family routes to its own core, with the correct `documentType` and the
  correct idempotency-key prefix (`revenue:`, `analytical:<type>:`,
  `roster-profile:<type>:`, `patient-history:<type>:`, `generic-document:`), and
  `INVOICE` routes through the pre-existing appointment-keyed core **without**
  touching `issueDocumentFoundation`;
- `attachmentKeys` defaults to `[]` for roster/profile types, both in the
  resolver call and in the persisted params;
- `mode: "preview"` writes nothing and transitions nothing;
- the full P6-01 and P6-03 behaviour described above;
- the whole action pipeline (preview → server-minted token → confirm →
  re-authorize → receipt) over that real dispatch;
- the executed result still exposes only identifiers and hrefs — never the
  document body — so document content still never enters model context.

The two original suites were **not** deleted or weakened; their mocked fixtures
were updated to the new `DocumentSnapshotSummary` shape (`title` is now a
localized label, plus `titleKey`, `locale`, `body`) and their assertions are
intact.

---

### 9.13 Verification actually run (post-remediation)

| Check | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | **clean** |
| Targeted Phase 6 | the six `phase6-*` suites (see §9.13.1) | **6 files, 122 tests passed** |
| P7 / document regression | `npx vitest run tests/unit/lib/p7*` + `tests/unit/components/` | **114 files, 623 tests passed** |
| Full unit regression | `npm run test` | **355 files, 2 673 tests passed** |
| Integration + RLS | `npm run test:integration` (local Supabase, keys via `supabase status`) | **54 files passed, 1 skipped; 471 passed, 3 skipped** |
| Adversarial / eval | `npm run test:ai-adversarial` | **2 files, 112 tests passed** |
| Migration | `supabase db push --local` | `20260814150000_…_retention_scrub.sql` applied cleanly |
| Production build | `npm run build` | **compiled successfully in 12.9 s**; `/api/cron/ai-retention` present in the route manifest |
| Lint | `npm run lint` | **0 errors**, 28 warnings — all pre-existing, none in any file touched here |
| RTL gate | `npm run lint:rtl` | ✓ 680 files, 17 documented exceptions |
| i18n gate | `npm run lint:i18n` | ✓ 439 files, 43 documented exceptions |
| Message parity | `npm run i18n:missing` | ✓ 3 984 base leaf messages, locale variants valid |
| Whitespace | `git diff --check` | clean |

Nothing was pushed, deployed, or applied to any remote. The one new migration was
applied to the **local** stack only.

#### 9.13.1 The six Phase 6 suites

```
npx vitest run \
  tests/unit/ai/phase6-documents.test.ts \
  tests/unit/ai/phase6-document-actions.test.ts \
  tests/unit/ai/phase6-retention.test.ts \
  tests/unit/ai/phase6-review-fixes.test.ts \
  tests/unit/ai/phase6-document-dispatch.test.ts \
  tests/unit/components/phase6-document-confirmation-card.test.tsx
→ 6 files, 122 tests passed
```

| Suite | Tests | Covers |
|---|---|---|
| `phase6-documents.test.ts` | 32 | original slot/capability/registry/export-hatch coverage (fixtures updated to the new summary shape) |
| `phase6-document-actions.test.ts` | 12 | original pipeline coverage (tokens, receipts, re-authorization, replay) |
| `phase6-retention.test.ts` | 20 | windows, migration contracts, **P6-04** scrub, **P6-11** drain loop |
| `phase6-review-fixes.test.ts` | 18 | **P6-02** (incl. the 21×5×2 parity sweep), **P6-05**, **P6-06**, **P6-08**, **P6-09**, **P6-03** preview half |
| `phase6-document-dispatch.test.ts` | 31 | the **real** per-family dispatch, **P6-01**, **P6-03**, **P6-06**, **P6-07**, **P6-10** |
| `phase6-document-confirmation-card.test.tsx` | 8 | the rendered card: **P6-01**, **P6-03**, **P6-07**, **P6-09** |

**A caveat on the full-suite runs.** Two intermediate `npm run test` invocations
reported worker-startup failures (`[vitest-pool]: Failed to start forks worker`,
`Timeout waiting for worker to respond`) and 45–60-minute durations. Those were
machine-level resource exhaustion from overlapping runs on this workstation, not
test regressions: `tests/unit/lib/p2b-rtl-retrofit.test.ts` plants and removes a
probe file under `app/`, and an interrupted run leaves it behind, which then
fails the RTL gate and any concurrent run. The leftover probe was removed and the
suite re-run **alone** to produce the numbers above.

---

### 9.14 Remaining issues

1. **`GENERIC_DOCUMENT` in the Assistant's action surface is still a product
   decision.** Point 3 of P6-01's required fix asks whether the type belongs
   there at all this phase, or behind its own feature key so it can be withheld
   independently of `ai.documents`. That is a commercial/product call, not an
   implementation one, so it was **not** taken. What is implemented is the
   mitigation the finding demands: the full body is on the card, its provenance
   is stated, and an oversize body is refused rather than truncated. If the
   decision later is to gate it, the hook is a one-line conditional feature check
   in `documents.ts` exactly like `assertClinicalIssuanceFeature`.
2. **`MAX_ASSISTANT_AUTHORED_BODY_CHARS = 20_000` is a judgement call.** The
   plan fixes no number here. It is one named constant in
   `lib/documents/mutations.ts`, and the document platform's own 240 KB schema
   limit is untouched — this cap applies only to the Assistant path, where the
   card is the sole human checkpoint.
3. **`active_context` is scrubbed to `'{}'`, not `null`.** The column is
   `not null`. `'{}'` is its declared empty value and is what the RLS test
   asserts; changing the column to nullable would be a schema change with no
   privacy benefit.
4. **The retention cron still requires `CRON_SECRET`** in the deployment
   environment. No environment change was applied; nothing was deployed.
5. **React `cache()` does not dedupe outside a request scope.** This is why
   §9.10 also hoists the lookup explicitly. The same caveat applies to the
   pre-existing `getReportVisibilityState` memo; it was not changed here, as that
   is outside this remediation's scope.

---

### 9.15 Files changed by the remediation

**New**
```
lib/ai/actions/resolver-context.ts
supabase/migrations/20260814150000_ai_assistant_phase6_retention_scrub.sql
tests/unit/ai/phase6-review-fixes.test.ts
tests/unit/ai/phase6-document-dispatch.test.ts
tests/unit/components/phase6-document-confirmation-card.test.tsx
```

**Modified**
```
lib/documents/mutations.ts              — P6-01 body projection + cap, P6-02 page gate,
                                          P6-03 record state + side-effect audit, P6-09 title/locale,
                                          P6-10 hoisted visibility option
lib/documents/module-labels.ts          — P6-09 explicit-locale label resolver
lib/ai/documents/capability.ts          — P6-01/03/05/06/08/09/10 outcome shapes and gates
lib/ai/actions/definitions/documents.ts — P6-01/03/06/07/08/09 preview rows, summary,
                                          canonical input, ai.write_records gate
lib/ai/actions/types.ts                 — ActionResolverContext, canonicalInput, action_input
lib/ai/actions/execute.ts               — resolver context both phases, canonical-input token,
                                          AiToolAuthorizationError + ActionTransientError mapping
lib/ai/actions/errors.ts                — ActionTransientError
lib/ai/tools/preview-document.ts        — locale hint + guidance for unknown_keys/transient_failure
lib/ai/retention.ts                     — scrubbedConversations, drainExpiredAiData
app/api/cron/ai-retention/route.ts      — P6-11 drain loop + backlog signal
lib/server-page-permissions.ts          — P6-10 request-scoped memo
components/assistant/assistant-chat.tsx — P6-07 confirm resends action_input
types/database.ts                       — scrubbed_conversations return column (surgical)
tests/unit/ai/phase6-documents.test.ts            — fixture shape only
tests/unit/ai/phase6-document-actions.test.ts     — fixture shape only
tests/unit/ai/phase6-retention.test.ts            — P6-04 + P6-11 coverage
tests/unit/ai/phase4-legacy-action-equivalence.test.ts — execution-context shape only
tests/unit/integration/phase6-documents-retention-rls.test.ts — P6-04 coverage
```

**Boundaries.** `lib/ai/eval/injection-corpus.ts` and `lib/ai/eval/eval-set.ts`
were **not** modified — the P6-01 adversarial case lives in the Phase 6 suite, as
Phase 6 already established. No superseded tool was unmounted, no dead code was
deleted beyond the one unused helper P6-09 required removing, `types/database.ts`
was not regenerated wholesale, and no unrelated dirty work was touched. Every
document read and write still runs on the caller's RLS-scoped session client; the
only service-role surface remains the retention control plane.

---

## 10. Re-review remediation — P6-12

Source: `docs/reports/AI_ASSISTANT_PHASE_6_REVIEW.md` (re-review verdict **NOT
PASS — 1 Low remaining**). P6-12 is the only finding it left open, and it is the
only thing changed here. **Phase 7 was not started** and nothing outside the
document preview path and its denial classification was touched.

| ID | Severity | Status |
|---|---|---|
| P6-12 | Low | **Fixed** — typed subject-not-found outcome mapped to `unauthorized_scope`; `previewFailed` / `transient_failure` narrowed to genuine infrastructure failures |

### 10.1 What was wrong

`previewDocumentCore` wrapped its whole resolver call in one `try/catch` that
collapsed every thrown error into `domainFailure("previewFailed")`, and the P6-06
remediation then mapped that entire bucket to `{ status: "transient_failure" }`.
But `previewFailed` was not only the infrastructure bucket — it was also how the
resolvers reported *"that record is not in your data"*, because they signalled an
empty RLS result by throwing a bare `Error("… not found")`:

```
lib/documents/resolvers/roster-profile.ts:167,220   Patient / Staff member not found
lib/documents/resolvers/clinical-document.ts:106,122,133  Prescription / Lab request / Sick leave not found
lib/documents/resolvers/patient-history.ts:241,246  Patient not found (incl. the doctor access gate)
lib/documents/resolvers/invoice.ts:195              Appointment was not found
```

So naming a patient the Assistant cannot see was reported as a *temporary*
problem: the model was told to retry a permanently failing call, and
`ai_action_receipts` recorded `denialReason: "transient_failure"` for what §11's
taxonomy assigns to `unauthorized_scope` ("RLS returned nothing / record outside
scope", behaviour *"never retries"*). P6-06 fixed the rare case by
mis-classifying the common one.

### 10.2 Fix

The review offered two options and preferred the first — a typed not-found error
rather than message matching — because it fixes every resolver site at once
without adding a round-trip. That is what was implemented.

**1. A typed outcome for the resolvers.** New
[lib/documents/resolvers/errors.ts](../../lib/documents/resolvers/errors.ts):

- `DocumentSubjectNotFoundError`, carrying only a `subject` kind
  (`patient | staff | appointment | clinical_record`) derived from the requested
  **document type**, never from the lookup result — so it encodes nothing about
  whether the record exists. No id is attached, for the same reason.
- `isDocumentSubjectNotFoundError()`, an `instanceof` check with a `name`
  fallback, so a resolver and its caller loaded through different module
  instances (a test that spreads `importOriginal`, a re-bundled server chunk)
  cannot silently degrade a scope miss back into an outage.
- `isNoRowsError()`, matching PostgREST's `PGRST116`. `.single()` reports zero
  rows — absent row and RLS-filtered row alike — as an *error*; that is a subject
  miss. Any other error code is a genuine failure.

Message-text matching was deliberately avoided: it is not a contract and breaks
under a reworded database message.

**2. The seven resolver sites now distinguish the two.** Each empty-subject site
throws `DocumentSubjectNotFoundError`; each genuine PostgREST error keeps a plain
`Error`. Concretely, `if (error || !row) throw new Error(...)` became
`if (error && !isNoRowsError(error)) throw new Error(error.message);` followed by
`if (!row) throw new DocumentSubjectNotFoundError(<kind>)`, and the
`.maybeSingle()` clinical sites split the same way (`maybeSingle` reports an
empty result as no data *and* no error, so any error there is real). The
patient-history doctor department/assignment gate raises the **same** typed error
as an empty row, and `invoice.ts` was included for the same class of miss.

Supporting-data failures were **not** reclassified: `Clinic branding was not
found`, `Physician not found` and `Preparer not found` are data-integrity /
infrastructure problems about the clinic, not about the requested subject, and
still resolve to `previewFailed` → `transient_failure`.

**3. A distinct core failure code.** `DocumentCoreFailureCode` gained
`documentSubjectNotFound`. `previewDocumentCore`'s catch now branches on
`isDocumentSubjectNotFoundError` and logs `document_preview_subject_not_found` at
`warn` with the subject kind (no id), leaving `console.error
document_preview_core_failed` → `previewFailed` for real failures only.

**4. Mapped to `unauthorized_scope`.** In
[lib/ai/documents/capability.ts](../../lib/ai/documents/capability.ts),
`previewFailed` alone yields `transient_failure`; `documentSubjectNotFound` falls
through to the existing `{ status: "unauthorized_scope", document_type }`
outcome, joining `documentTypeNotAvailable` / `reportNotVisible` /
`documentTypeUnknown` there.

**5. Receipts and denial classification.** `requireReadyIssue` in
[lib/ai/actions/definitions/documents.ts](../../lib/ai/actions/definitions/documents.ts)
previously ended in `ActionBusinessRuleError("documents.type_unavailable")`,
which produced an `outcome: "business_rule_refused"` receipt with **no**
`denialReason`. It now throws `AiToolAuthorizationError("unauthorized_scope")`,
which both `previewRegisteredAction` and `executeRegisteredAction` already map
through `mappedAuthorizationReason`, so the attempt is recorded as
`authorizationOutcome: "denied", denialReason: "unauthorized_scope"` — what §12's
ledger needs to answer *why* an attempt was refused. `documents.issue`'s
`execute` re-runs `prepareDocumentIssue` before touching `issueDocumentCore`, so
a subject that disappears between preview and confirm is classified identically
on the write phase, with nothing issued.

`preview_document`'s tool description now also states that `unauthorized_scope`
is permanent, must not be retried, and must never be attributed to a specific
cause.

**The non-enumeration property is preserved, and is now wider than before.** The
`unauthorized_scope` outcome carries nothing but the requested `document_type`,
so an unknown type, a type this caller may not issue, a subject that does not
exist and a subject in another scope are one byte-identical shape and one denial
reason. This is *stronger* than the pre-P6-06 state, which distinguished the
type-unavailable case (`business_rule_violation`) from a scope miss.

**Out of scope, deliberately.** The reprint path was not touched:
`reprintDocumentCore` already collapses out-of-scope id, unregistered type and
role/report denial into `documentNotFound` before the status check, and the
re-review confirmed it is unaffected by P6-12.

### 10.3 Tests

New suite `tests/unit/ai/phase6-subject-not-found.test.ts` (**15 tests**). It
runs the **real** resolvers, the real `previewDocumentCore`, the real
`prepareDocumentIssue` and the real action pipeline; only Supabase and the
authorization lookups beneath them are stubbed, with each table's result
(including its PostgREST error code) controlled per test.

Against the review's acceptance criteria:

| Criterion | Coverage |
|---|---|
| Non-existent subject → `unauthorized_scope` | `PATIENT_FILE`, `STAFF_FILE` (`.single()` → `PGRST116`) and `PRESCRIPTION` (`.maybeSingle()` → empty) each assert the exact outcome object |
| Out-of-scope subject → identical `unauthorized_scope` | a doctor previewing `APPOINTMENT_HISTORY_REPORT` for an absent patient vs. an **existing** patient assigned to another doctor in another department — two genuinely different code paths — asserted `JSON.stringify`-identical; the resolver-level pair asserts the same typed error and the same message |
| Genuine resolver/system failure → `transient_failure` | the same three types with a statement timeout (`57014`) and a connection failure (`08006`) on the subject table, as the negative control for each pair |
| Receipt records `denialReason: "unauthorized_scope"` | `documents.issue` preview for an out-of-scope subject asserts the denial reason on both the result and the finalized receipt, with the timeout case asserting `transient_failure` on both, and a third case asserting no `confirm_token` is minted |

Two further tests pin the mechanism itself: the typed error carries no record id
and `isDocumentSubjectNotFoundError` does **not** match a plain
`Error("Patient not found")` — so the fix cannot silently regress into message
matching. One more asserts an unavailable **type** and a missing **subject**
produce identical outcomes, guarding the non-enumeration property directly.

**Discrimination check.** With the mapping reverted (routing
`documentSubjectNotFound` back through `transient_failure`) **6 of the 15 tests
fail**; they are not vacuous.

**One existing test updated, not weakened.**
`tests/unit/ai/phase6-document-actions.test.ts`'s "unauthorized document type"
case asserted `reason: "business_rule_violation"`. Its actual property — that an
unauthorized type and an unknown type are reported *identically*, so an
out-of-catalog type is never confirmed to exist — is unchanged and still
asserted; only the expected reason moved to `unauthorized_scope`, and the test
now **additionally** asserts the receipt's `authorizationOutcome: "denied"` /
`denialReason: "unauthorized_scope"`. No assertion was removed.

### 10.4 Verification actually run

| Check | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | **clean** |
| Phase 6 suites (now seven) | the six previous `phase6-*` suites + `phase6-subject-not-found.test.ts` | **7 files, 137 tests passed** |
| P7 / document + component regression | `npx vitest run tests/unit/lib/p7 tests/unit/components` | **114 files, 623 tests passed** |
| Full unit regression | `npm run test` | **356 files, 2 688 tests passed** (was 355 / 2 673; +1 file, +15 tests) |
| Integration + RLS (incl. `phase6-documents-retention-rls`) | `npm run test:integration` (local Supabase, keys via `supabase status`) | **54 files passed, 1 skipped; 471 passed, 3 skipped** |
| Adversarial / eval | `npm run test:ai-adversarial` | **2 files, 112 tests passed** |
| Lint | `npm run lint` | **0 errors**, 28 warnings — all pre-existing, none in any file touched here |
| Whitespace | `git diff --check` | clean |

Every pre-existing number reproduces exactly. Nothing was pushed, deployed, or
applied to any remote; no migration was added or run.

### 10.5 Files changed

**New**
```
lib/documents/resolvers/errors.ts            — DocumentSubjectNotFoundError, isNoRowsError
tests/unit/ai/phase6-subject-not-found.test.ts — 15 tests
```

**Modified**
```
lib/documents/resolvers/roster-profile.ts     — patient / staff subject miss (2 sites)
lib/documents/resolvers/clinical-document.ts  — prescription / lab request / sick leave (3 sites)
lib/documents/resolvers/patient-history.ts    — patient row + doctor access gate (2 sites)
lib/documents/resolvers/invoice.ts            — appointment subject miss (1 site)
lib/documents/mutations.ts                    — documentSubjectNotFound failure code + catch branch
lib/ai/documents/capability.ts                — documentSubjectNotFound → unauthorized_scope
lib/ai/actions/definitions/documents.ts       — requireReadyIssue throws AiToolAuthorizationError
lib/ai/tools/preview-document.ts              — unauthorized_scope guidance for the read surface
tests/unit/ai/phase6-document-actions.test.ts — expected denial reason + receipt assertion
```

**Boundaries.** No migration, no schema or `types/database.ts` change, no change
to the retention control plane, the export hatch, the eval/injection corpora, or
any Phase 7 surface. `lib/documents/resolvers/analytical-report.ts` and
`revenue-report.ts` appear dirty in `git status` from pre-existing branch work
and contain none of these changes. Every document read still runs on the caller's
own RLS-scoped session client.
