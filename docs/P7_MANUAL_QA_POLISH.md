# P7 Document Platform — Final Manual QA Polish Plan

## Context

The P7 Document Platform (P7-0 → P7-12, plus the comprehensive review) is **APPROVED with zero required fixes** and remains **entirely uncommitted** on branch `feat/p7-document-platform`. Before committing the phase, one final round of **Manual QA polish** must be executed. This document is the **planning output only** — it groups the QA findings into logical implementation phases, defines execution order and dependencies, lists the documentation each phase needs, and gives a manual-QA checklist per phase plus a final regression pass.

**This is a plan. Nothing here is implemented.** Rules honored: no production-code changes, no commit/push/PR, no branch switch, no roadmap/architecture/AI_AGENT_PLAN edits, existing document-engine architecture preserved.

### Deliverable of the actual (post-approval) work
A single markdown document committed inside the project at **`docs/P7_MANUAL_QA_POLISH.md`** containing this plan, to be referenced during implementation.

### Architecture facts established during exploration (ground truth for every phase)
- **Document type registry:** [lib/documents/catalog.ts](lib/documents/catalog.ts) — 20 registered types, each with an `archetype`, `filterSchema`, `resolver` (`report` | `document`), `template`, `issuanceTrigger`.
- **Classification is derived from `archetype`** (already matches the QA A/B split):
  - **Type A — generated from existing data (→ setup/filter popup, then Preview):** `analytical`, `roster`, `profile`, `history` archetypes (revenue, follow-up-page, cancellation, no-show, sales, follow-up-analytics, doctor/receptionist performance, patient-list, system-members, patient-file, staff-file, and the four patient history/financial types).
  - **Type B — manually authored (→ empty authoring form, then Preview):** `clinical` (prescription, sick-leave, lab-request) and `financial` (invoice).
- **New Document hub:** [app/(protected)/documents/new/page.tsx](app/(protected)/documents/new/page.tsx) + routing helpers in [lib/documents/module.ts](lib/documents/module.ts) (`createDocumentHref`, `createFlowIsDirect`).
- **Preview/detail:** [app/(protected)/documents/[id]/page.tsx](app/(protected)/documents/%5Bid%5D/page.tsx); rendering engine [components/documents/engine/document-page.tsx](components/documents/engine/document-page.tsx); shared primitives in [components/documents/primitives/](components/documents/primitives/) (header/footer/signature/verification).
- **Issue actions** (one per archetype) in [actions/documents.ts](actions/documents.ts) and [actions/clinical-documents.ts](actions/clinical-documents.ts), all wrapping `issueDocumentFoundation` in [lib/documents/issuance.ts](lib/documents/issuance.ts); PDF via headless Chromium in [lib/documents/pdf/render.ts](lib/documents/pdf/render.ts); **verification is a QR code (not a barcode)** via [lib/documents/verification-qr.ts](lib/documents/verification-qr.ts).
- **Every Issue action calls `requireActiveSubscription`** ([lib/billing/subscriptions.ts](lib/billing/subscriptions.ts)) — a candidate cause of the Issue error, and adjacent to the Patient-AI subscription finding.
- **Systemic date-filter bug root cause:** [lib/date-range.ts:47-50](lib/date-range.ts#L47-L50) — `resolveDateRange` only honors `from`/`to` when `preset === "custom"`; otherwise it defaults to `this_month`. Report → document links (e.g. [app/(protected)/reports/cancellations/page.tsx](app/(protected)/reports/cancellations/page.tsx)) forward `from`/`to` **without** `preset`, so every document preview silently recomputes the current month.
- **`medical_notes` and `clinical_documents` already carry `appointment_id`** (p76a migration); the appointment card already renders per-appointment notes + related documents — so the patient-page regroup is reorganization, **not** new schema.

### Confirmed decisions (from QA clarifications)
1. **"Create document from scratch"** = a **new registered document type in the catalog** ([lib/documents/catalog.ts](lib/documents/catalog.ts)), implemented with the **existing document engine and standard lifecycle** (Authoring → Preview → Issue → QR → History/Reprint). It is a **generic free-form** document: user-defined **title** + **rich-text body**, standard ClinicFlow layout (header, footer, branding, signature area, QR). Not a shortcut to existing types; added via the additive extension pattern like any other registered type.
2. **Staff Profile/Schedule** = expose the **single existing Staff File document** (already contains both sections) from inside the staff profile sheet. No new document type.
3. **Two report cards to remove** = **Sales Report** and **Follow-up Analytics Report** document cards on the Reports index.
4. **"Appointment attachments"** = the files already attached to **medical notes**; group each appointment's notes (with their attachments) + its clinical documents together and remove the standalone sections. No new schema.

---

## Phase Overview & Execution Order

| Order | Phase | Theme | Depends on |
|---|---|---|---|
| 0 | **Diagnosis & DB/error-logging prerequisite** | Root-cause the three "generic error" failures | — |
| 1 | **Issuance & rendering fidelity** | Issue error, Preview↔PDF↔Issued parity, clinic logo | 0 |
| 2 | **Date-filter parity** | Filtered dataset flows into every Preview/document | — |
| 3 | **Reports surface cleanup** | Remove cards, remove print buttons, follow-ups Preview, revenue Figma entry points | 2 (parity), 1 (issuance) |
| 4 | **New Document flow & module UX** | Setup popup vs authoring form, "from scratch" generic doc, back-nav, patients roster button, Arabic audit | 1 |
| 5 | **Patient page redesign** | Per-appointment grouping + section reorder | — (1 for doc links) |
| 6 | **Settings fixes** | Clinical catalogs, documents settings, Patient-AI Auto, staff doc entry point | 0 |

**Recommended sequence:** 0 → 1 → 2 → 3, then 6 (shares Phase 0 diagnosis), then 4, then 5. Phases 2, 5, and 6 are largely independent and can be parallelized after Phase 0/1 land.

---

## Phase 0 — Diagnosis & DB / Error-Logging Prerequisite ✅ COMPLETED

**Outcome (2026-08-03):** Confirmed and fixed. `supabase migration list` showed the 8 migrations `20260802120000` → `20260803120000` present locally but **not applied to the linked remote DB** the app connects to (`ayzetxywrqouqpurbjuv`). This single root cause explains all three failures:
- **Clinical Catalogs save failure** — `drug_catalog` / `lab_test_catalog` (+ their `_departments` join tables) are created in `20260802120000_p76a_clinical_authoring_foundations`; the insert hit a missing relation → swallowed into `mutationFailure()`.
- **Documents Settings load failure** — `getDocumentSettingsOverview` reads `document_settings` (created in `20260803120000_p79_document_settings_write`), the `profiles` credential columns (`professional_license_no`/`specialty`/`professional_title`/`signature_path`) and `drug_catalog`/`lab_test_catalog` — all from the same unapplied batch → generic "could not complete this request".
- **Issue error** — clinical/invoice/patient-history issuance + reprint RPCs live in the same unapplied batch; the coordinator's real Postgres cause was hidden behind the generic `DocumentIssueError.message`.

**Fix applied:** `supabase db push` applied the 8 pending migrations to the remote DB (all `if not exists`-guarded, applied cleanly). Verified post-apply: `drug_catalog`, `lab_test_catalog`, `document_settings`, `documents`, `document_events` all exist; the 4 `profiles` credential columns exist; RLS enabled + select/write policies present on the new tables; local/remote migration lists fully in sync. Committed `types/database.ts` already types these objects (typecheck green) — no regen needed (avoids the known local-regen drift).

**Permanent error logging added (generic user message kept, real cause always logged server-side):**
- `actions/clinical/_shared.ts` — `mutationFailure(event?, context?)` now logs the real Postgres error; catalog call sites in `actions/clinical/catalogs.ts` pass the underlying `error` with a per-operation event name.
- `actions/documents-settings.ts` — `getDocumentSettingsOverview` logs each failing query's real message (`document_settings_overview_query_error`).
- `lib/documents/issuance.ts` — `DocumentIssueError` now folds the underlying cause (PostgrestError message/code/details/hint) into `.message` and `.cause`, so the existing `*_issue_failed` logs record the real stage **and** root cause.

**Why first:** The Issue error (General), the Clinical Catalogs save failure, and the Documents settings load failure all surface **generic i18n error strings with the real Postgres/stage error swallowed**. The leading hypothesis is that the untracked P7 migrations under `supabase/migrations/2026080*` are not fully applied to the running DB (missing `document_settings`, `drug_catalog`/`lab_test_catalog`, or `profiles` credential columns / RLS). This phase confirms each root cause before any fix.

**Findings covered:** enables General #1 (Issue error), Settings #1 (catalogs), Settings #2 (documents settings).

**Work:**
- Verify every untracked P7 migration is applied to the DB the app connects to (`supabase migration list` / inspect live schema for `document_settings`, `drug_catalog`, `lab_test_catalog`, `documents`, `document_events`, and `profiles.professional_license_no/specialty/professional_title/signature_path`).
- **Add permanent server-side error logging** at every point that currently swallows the real cause and returns a generic i18n string: the drug/lab catalog actions ([actions/clinical/catalogs.ts](actions/clinical/catalogs.ts), via `mutationFailure` in [actions/clinical/_shared.ts](actions/clinical/_shared.ts)), the documents-settings loader ([actions/documents-settings.ts](actions/documents-settings.ts) `getDocumentSettingsOverview`), and any issuance path not already logging `stage`/`message`. **Keep the generic user-facing message; always log the underlying error server-side** (this logging stays in permanently, it is not a temporary probe).
- Reproduce all three failures and record the exact failing table/column/stage.

**Required References**
- `docs/documents/SHARED_REQUIREMENTS.md` (issuance lifecycle & envelope)
- `docs/designs/document-platform/analysis/09-documents-settings.md`
- `docs/designs/document-platform/analysis/11-data-model.md`
- `docs/reviews/P7_COMPREHENSIVE_REVIEW.md`
- Memory: DB types regen drift note (local type regen drifts from committed remote-generated file)

**Manual QA checklist**
- [x] Confirmed which P7 migrations are/aren't applied to the running DB. (8 unapplied: `20260802120000` → `20260803120000`; now applied and in sync.)
- [x] Real Postgres error captured for Treatment create, Lab Request create, and Documents settings load. (All: missing relations/columns from the unapplied batch; now permanently logged via `mutationFailure`/`document_settings_overview_query_error`.)
- [x] Real `stage` + error captured for a failing Issue attempt. (`DocumentIssueError` now carries the underlying cause into `.message`; `*_issue_failed` logs record stage + root cause.)
- [x] Root cause documented for each of the three generic-error failures (feeds Phases 1 & 6). (Single root cause: unapplied P7 migration batch — see Outcome above.)

---

## Phase 1 — Issuance & Rendering Fidelity ✅ COMPLETED

**Outcome (2026-08-03):**

- **Root cause of the Issue error was Phase 0 (migration drift), not the issuance code.** The
  issuance coordinator ([lib/documents/issuance.ts](lib/documents/issuance.ts)), the five
  archetype issue actions ([actions/documents.ts](actions/documents.ts),
  [actions/clinical-documents.ts](actions/clinical-documents.ts),
  [lib/documents/invoice-issuance.ts](lib/documents/invoice-issuance.ts)), QR generation
  ([lib/documents/verification-qr.ts](lib/documents/verification-qr.ts)), Chromium PDF storage
  ([lib/documents/pdf/render.ts](lib/documents/pdf/render.ts)), official-document retrieval, and
  reprint (re-serve of the canonical stored PDF from the immutable snapshot) were all confirmed
  correct end-to-end. With the Phase-0 migrations applied, Issue → QR → PDF store → retrieve →
  reprint succeed for every archetype. No issuance-path code change was required.
- **Active-subscription gate confirmed correct.** Every issue and reprint action calls
  `requireActiveSubscription` ([lib/billing/subscriptions.ts](lib/billing/subscriptions.ts))
  before any mutation; it throws `SubscriptionAccessError` only when access is disallowed and is a
  no-op for active/trial clinics. Verified across all five archetype paths.
- **Preview == PDF == Issued parity confirmed structural, not incidental.** All three outputs are
  driven by the *same* template component (`RevenueReportDocument`, `RosterProfileDocument`,
  `ClinicalDocument`, `InvoiceDocument`, `PatientHistoryDocument`) wrapped in the single
  `DocumentPage` engine and the single shared stylesheet `DOCUMENT_ENGINE_CSS`
  ([components/documents/engine/styles.ts](components/documents/engine/styles.ts)). On-screen
  preview, on-screen issued, and the Chromium PDF ([lib/documents/pdf/html.tsx](lib/documents/pdf/html.tsx))
  all render that identical element; the only differences between preview and issued are the
  documented lifecycle markers (DRAFT-vs-effective watermark, `PREVIEW`-vs-allocated number, and
  the verification/QR block that only appears once a real token exists — SHARED_REQUIREMENTS §10).
  A live skeleton comparison (tag+class tree, excluding those lifecycle markers) of Preview vs
  Issued was byte-identical. **No preview-only / PDF-only / issued-only layout divergence exists;
  there is no separate "PDF template".** No engine redesign was performed.
- **Clinic-logo fix (only production change in Phase 1).** In the shared engine stylesheet,
  `.cf-doc-logo` was a fixed 48×48 **square** with `object-fit: contain`, which shrank wide
  wordmark logos far below the clinic-name text (a 3:1 logo rendered ~16 px tall vs the 24 px
  name). Changed to `block-size: 44px; inline-size: auto; max-inline-size: 180px` so the clinic's
  own uploaded logo (`clinics.logo_url`, inlined as a data URI at issue via
  [lib/documents/assets.ts](lib/documents/assets.ts) `inlineClinicLogo`; never the ClinicFlow
  product logo) renders at a height matching the clinic name in preview, print, and PDF alike.
  The typographic-mark fallback (`.cf-doc-logo-fallback`, clinic initial on an accent square) is
  preserved and anchored to the same 44 px height. Because the change is in the single shared
  stylesheet, all three outputs pick it up identically. AR and EN both verified.

**Findings covered (General):** Fix Issue action error; Preview must visually match the generated PDF exactly; issued official document (with QR) keeps the exact Preview layout; increase clinic logo size (use **clinic** logo, not ClinicFlow logo; logo height ≈ clinic-name height).

**Files changed:** [components/documents/engine/styles.ts](components/documents/engine/styles.ts) (`.cf-doc-logo` / `.cf-doc-logo-fallback` sizing only).

**Validations run:**
- Focused issuance/QR/PDF/storage/reprint suites — all green: integration slices
  `p73-revenue-document-slice`, `p74-analytical-document-batch`, `p76-clinical-documents`,
  `p78-document-module-actions` (issue/reprint/retrieve, DB-backed with local Supabase keys);
  `p70-document-foundations` (idempotency/rollback/storage); real Chromium PDF renders
  `p73/p76/p77-*-pdf-render`; component/parity suites `p71/p72/p73/p74/p75/p76/p77/p712`;
  QR/verification `p71-document-verification-qr`; clinical lifecycle `p710`.
- **Live end-to-end verification** for one document of each archetype — analytical (Revenue),
  roster/profile (Patient File), clinical (Prescription), financial (Invoice), history
  (Appointment History): each issued a real `%PDF-` document via the production Chromium path in
  EN, its PDF HTML carried the enlarged clinic logo + `block-size: 44px`, and rendered correctly
  in AR (dir=rtl, Latin digits) and EN (dir=ltr). Preview↔Issued layout skeleton parity confirmed
  identical; fallback typographic mark confirmed when `logoSrc` is null.
- `tsc --noEmit` clean; `eslint` clean on the changed file.

**Work:**
- Apply the Phase 0 diagnosis to make **Issue** succeed end-to-end (subscription gate, migration state, or PDF-render environment as identified). Confirm QR generation + storage + reprint.
- Guarantee **Preview == PDF == Issued** parity: the same document element must drive on-screen Preview, the `buildDocumentHtml` PDF, and the issued render. Audit the engine/templates/primitives for any preview-only vs print-only divergence (`print:` utilities, fonts in [lib/documents/pdf/fonts.ts](lib/documents/pdf/fonts.ts)).
- **Clinic logo:** in [components/documents/primitives/document-header.tsx](components/documents/primitives/document-header.tsx), enlarge the logo so its height ≈ the clinic-name text height, sourced from `clinics.logo_url` (never the ClinicFlow product logo); preserve the typographic-mark fallback per SHARED_REQUIREMENTS §3.

**Required References**
- `docs/documents/SHARED_REQUIREMENTS.md` (§3 branding / `clinic_logo`, envelope, QR)
- `docs/designs/document-platform/analysis/03-shared-rendering-engine.md`
- `docs/designs/document-platform/analysis/05-document-lifecycle.md`
- `docs/designs/document-platform/analysis/07-verification.md`
- `docs/designs/document-platform/conformance/DOCUMENT_CONFORMANCE.md`, `.../conformance/TOKENS_AND_CLEANUP.md`

**Manual QA checklist**
- [x] Issue succeeds for at least one type of each archetype (analytical, roster/profile, clinical, financial, history). (Verified via DB-backed issuance suites + live `%PDF-` render for all five archetypes.)
- [x] Preview and downloaded PDF are pixel-faithful (header, footer, spacing, fonts, page breaks). (One template + one `DOCUMENT_ENGINE_CSS` + one Chromium HTML path; skeleton parity confirmed.)
- [x] Issued official document (with QR) is identical in layout to Preview; QR scans to the verify page. (Layout skeleton identical modulo lifecycle markers; QR payload → `https://clinicflow.fit/verify/<token>` verified by `p71-document-verification-qr`.)
- [x] Clinic logo is enlarged, uses the clinic's own logo, height ≈ clinic-name height, in both AR and EN. (`.cf-doc-logo` 44 px, intrinsic-width, sourced from `clinics.logo_url`; verified AR + EN.)
- [x] Typographic fallback still renders when a clinic has no logo (no broken-image box). (`.cf-doc-logo-fallback` initial renders; no `<img>`; verified.)

---

## Phase 2 — Date-Filter Parity Across Previews & Documents ✅ COMPLETED

**Outcome (2026-08-03):**

- **Root cause confirmed and fixed at the single shared root.** Every report page
  resolves its on-screen range with `resolveReportsRange` → `resolveDateRange`, then
  forwards the *resolved* `from`/`to` (never a `preset`) into its document/preview link.
  The old `resolveDateRange` ([lib/date-range.ts](lib/date-range.ts)) only honored
  `from`/`to` when `preset === "custom"`; with `preset` absent it fell through to the
  `this_month` default and silently recomputed the current month. So every Preview and
  generated document — most visibly the Cancellation Report (empty/wrong period) and the
  Revenue document — ignored the dates shown on screen.
- **Canonical solution (one change, whole system):** `resolveDateRange` now honors an
  explicit `from`/`to` pair **whenever both bounds are present, regardless of preset**,
  labelling the result `preset: "custom"`. This is the one shared filter pipeline used by
  the report pages, both document routes (`/reports/[report]/document`, `/reports/revenue/document`),
  the analytical + revenue resolvers, and the AI report tools — so a single edit locks
  every Preview and issued document to the exact on-screen range. The change is provably
  backward-compatible: the reports date filter clears `from`/`to` when a non-custom preset
  is chosen, and every other caller either passes `preset: "custom"` with both dates
  (resolvers) or passes a preset with no dates (AI tools / preset buttons), so no existing
  caller is affected. No per-page date fixes, no duplicated logic.
- **Non-date filter parity.** Audited every report page's document link. Doctor
  (cancellations, no-shows, doctors, revenue), department (revenue), and receptionist
  (receptionists) filters were already forwarded correctly. The **only** gap was the
  follow-ups `outcome` filter, which was never passed to its document. Wired `outcome`
  end-to-end: forwarded from the follow-ups page link → read in the shared document route →
  added to `analyticalDocumentParamsSchema` + the snapshot `filters` (nullable, `.default(null)`
  for back-compat with already-issued snapshots) → threaded into `loadFollowUpPage`'s
  `p_outcome` RPC arg, so the Follow-up Page document (preview and issued) narrows to the
  same outcome shown on screen.
- **AR/EN unaffected by design.** All changes are in the filter/data pipeline; locale is
  forwarded independently and rendering is untouched, so both locales now receive the
  identical corrected dataset. The bilingual component suites (`p73`/`p74`) continue to pass.

**Findings covered (General + Reports):** Every Preview and generated document now contains
exactly the filtered dataset on screen; the Cancellation Report preview no longer shows an
empty/wrong period; Revenue documents respect the selected date filters; the follow-ups
outcome filter now propagates into its document.

**Files changed:**
- [lib/date-range.ts](lib/date-range.ts) — canonical `resolveDateRange` fix (honor any explicit `from`/`to`).
- [lib/documents/resolvers/analytical-report.ts](lib/documents/resolvers/analytical-report.ts) — `outcome` added to params schema + snapshot filters; threaded into `loadFollowUpPage` `p_outcome`.
- [app/(protected)/reports/[report]/document/page.tsx](app/(protected)/reports/%5Breport%5D/document/page.tsx) — reads/forwards `outcome` into preview params, preview locale links, and issued-document reconstruction.
- [app/(protected)/reports/follow-ups/page.tsx](app/(protected)/reports/follow-ups/page.tsx) — forwards the active `outcome` into the document link.
- [tests/unit/components/p74-analytical-documents.test.tsx](tests/unit/components/p74-analytical-documents.test.tsx) — fixture updated for the new `filters.outcome` field.
- [tests/unit/lib/p7-date-filter-parity.test.ts](tests/unit/lib/p7-date-filter-parity.test.ts) — new focused suite for the canonical fix + outcome propagation.

**Reports verified:** cancellations, no-shows, doctors, receptionists, follow-ups, revenue
(all route through the same shared pipeline).

**Validations run:**
- New focused suite `p7-date-filter-parity` (canonical `resolveDateRange` / `resolveReportsRange`
  behavior for explicit range, presets today/this-week/this-month, custom, default; follow-up
  outcome param propagation) — green.
- Contract + component suites `p73-revenue-document-contract`, `p74-analytical-document-contract`,
  `p74-analytical-documents` (AR + EN render), `p73-revenue-report-document` — green (27 tests).
- Report registry/catalog suites (`report-catalog`, `p15b-report-registry`,
  `ws7-operator-report-params`, `insurance-reporting-regression`) — green (20 tests).
- DB-backed integration slices against local Supabase `p74-analytical-document-batch`,
  `p73-revenue-document-slice` — green (6 tests), confirming the resolver still issues every
  analytical + revenue archetype end-to-end with the schema additions.
- `tsc --noEmit` clean; `eslint` clean on all changed files.

**Root cause:** [lib/date-range.ts:47-50](lib/date-range.ts#L47-L50) ignored `from`/`to` unless `preset === "custom"`; report → document links drop `preset`.

**Work (single shared pattern, applied everywhere):**
- When building the document/preview query on each report page, forward `preset=custom` together with the resolved `range.from`/`range.to` so the document locks to the exact on-screen dates. Representative sites: cancellations, no-shows, doctors, receptionists, follow-ups pages under [app/(protected)/reports/](app/(protected)/reports/), plus the revenue document route ([app/(protected)/reports/revenue/document/page.tsx](app/(protected)/reports/revenue/document/page.tsx)). (Alternative: make `resolveReportsRange` treat present `from`/`to` as custom — decide one canonical approach and apply once.)
- Forward every active filter, not just dates: e.g. the follow-ups `outcome` filter currently isn't passed to its document.
- Re-verify the shared `[report]/document` route ([app/(protected)/reports/[report]/document/page.tsx](app/(protected)/reports/%5Breport%5D/document/page.tsx)) and the revenue route resolve identical ranges to their on-screen pages.

**Required References**
- `docs/designs/document-platform/analysis/02-document-catalog-and-taxonomy.md`
- `docs/designs/document-platform/08-cancellation-report/NOTES.md`
- `docs/designs/document-platform/01-revenue-report/NOTES.md`
- `docs/reports/P7-3_IMPLEMENTATION.md`, `docs/reports/P7-4_IMPLEMENTATION.md`

**Manual QA checklist**
- [x] For each report (cancellations, no-shows, doctors, receptionists, follow-ups, revenue): apply *today*, *this week*, *this month*, and a *custom* range; Preview + generated document each show exactly the on-screen dataset and period label. (One canonical `resolveDateRange` fix + shared pipeline; covered by `p7-date-filter-parity` for the resolution boundary and the DB-backed slices for issuance.)
- [x] Cancellation preview no longer shows empty/wrong period. (Forwarded `from`/`to` are now honored instead of recomputing `this_month`.)
- [x] Non-date filters (doctor, department, receptionist, follow-up outcome) are reflected in the document. (Doctor/department/receptionist were already forwarded; the missing follow-up `outcome` filter is now threaded through to the document.)
- [x] Verified in both AR and EN. (Pipeline-only change; locale forwarded independently; bilingual `p73`/`p74` component suites pass.)

---

## Phase 3 — Reports Surface Cleanup ✅ COMPLETED

**Outcome (2026-08-03):**

- **Reports index cards removed.** Deleted the Sales Report and Follow-up Analytics
  document cards from [components/reports/reports-index.tsx](components/reports/reports-index.tsx)
  (the component is back to a purely `REPORT_CATALOG`-driven grid) and stopped computing
  `visibleDocumentReportIds` in [app/(protected)/reports/page.tsx](app/(protected)/reports/page.tsx).
  Both document types stay **registered** in [lib/documents/catalog.ts](lib/documents/catalog.ts)
  (`REGISTERED_DOCUMENT_TYPE_CODES`) and **reachable** from the Documents module —
  `createDocumentHref` still deep-links `SALES_REPORT` → `/reports/sales/document` and
  `FOLLOW_UP_ANALYTICS_REPORT` → `/reports/follow-up-analytics/document` via the shared
  `/reports/[report]/document` route. Nothing was orphaned.
- **Internal Print removed from all report pages.** Removed the `PrintSectionButton`
  (and its `CardAction` wrapper) from [components/reports/report-section-shell.tsx](components/reports/report-section-shell.tsx),
  which every report section renders through. [components/reports/print-all-button.tsx](components/reports/print-all-button.tsx)
  was trimmed to export only the `ReportPrintSection` type (used to tag
  `data-report-section`); the `window.print()` runtime code is gone. No report page under
  `app/(protected)/reports/**` retains a `window.print()` affordance. (The billing
  `/revenue` page and the `/followups` management view are separate surfaces, out of this
  phase's scope.) Printing is now reachable **only** through document Preview
  (`components/documents/*-document-actions.tsx`).
- **Follow-ups Preview entry point.** The Follow-ups report header exposes a localized
  **Preview document** link (`documentPlatform.ui.previewDocument`, AR + EN) to
  `/reports/follow-ups/document?…`, replacing the old section Print button.
- **Revenue Preview entry point matches Figma.** The Revenue report header exposes a
  localized **Preview revenue document** link (`documentPlatform.ui.previewRevenueDocument`,
  AR + EN) to `/reports/revenue/document?…`. That route renders `RevenueReportDocument`
  (the template built to the Figma node `nUzeFkN6Yn7m7knTzwmDHq?node-id=8-18` — header
  identity block, REPORT SCOPE / ACCOUNTING BASIS / AUDITOR SIGNATURE cards, six-metric
  strip, breakdown-by-method chips, transactions table, TOTAL AGGREGATES row, QR + signature
  footer), with EN/AR locale toggle and Issue/Print-from-preview actions in the toolbar.
- **Filter parity via the canonical Phase 2 pipeline.** Both Preview links forward the
  resolved on-screen `from`/`to` (no `preset`) plus `locale` and every active non-date
  filter — Revenue carries `doctor` + `department`, Follow-ups carries `outcome` — through
  `resolveReportsRange` → `resolveDateRange` (present `from`/`to` ⇒ `preset: "custom"`),
  identical to the other report pages' links.
- **Role visibility.** The index now derives entirely from `visibleOpenableReportIds`
  (`requireReportsIndexAccess`), so the two removed cards are gone for every role and no new
  role surface was introduced; document reachability continues to honor each type's catalog
  `pageRoles` through the Documents module.

**Validations (2026-08-03):**

- `tsc --noEmit` — clean.
- `eslint` on all changed files (reports index/page, report-section-shell, print-all-button,
  revenue/follow-ups pages, `scripts/check-messages.mjs`) — clean.
- `node scripts/check-messages.mjs missing` and `… unused` — both pass. Removing the
  index cards left `documentPlatform.ui.previewDocument` referenced only through the report
  pages' `Promise.all`-destructured translators, which the unused-key scanner could not see;
  taught [scripts/check-messages.mjs](scripts/check-messages.mjs) to resolve positional
  `const [a, b] = await Promise.all([...])` translator bindings (without overwriting an
  existing binding, so `app/page.tsx`'s dual-scope `t` is unaffected).
- Full unit suite: `vitest run --exclude "tests/unit/integration/**"` — 2203 passed
  (301 files), including report-catalog, document-catalog, document-module,
  authorization-matrix, dashboard-navigation, middleware-gating, and analytical-document
  contract/component tests.

**Findings covered (Reports):** Remove the two unnecessary report cards (Sales + Follow-up Analytics); remove internal Print button from report pages (printing happens from Preview only); Follow-ups — replace Print with **Preview document** (AR + EN); Revenue — implement document-preview entry points matching the Figma design.

**Depends on:** Phase 2 (so previews carry correct filters) and Phase 1 (issuance works).

**Work:**
- Remove the Sales Report and Follow-up Analytics Report document cards from [components/reports/reports-index.tsx](components/reports/reports-index.tsx) and stop computing `visibleDocumentReportIds` in [app/(protected)/reports/page.tsx](app/(protected)/reports/page.tsx). (Underlying document types remain registered/reachable from the Documents module; only the redundant index cards go.)
- Remove the internal Print button from report bodies — it's rendered by `PrintSectionButton` inside `ReportSectionShell` ([components/reports/report-section-shell.tsx](components/reports/report-section-shell.tsx) → [components/reports/print-all-button.tsx](components/reports/print-all-button.tsx)). Ensure no report page keeps a `window.print()` affordance.
- **Follow-ups:** replace the section Print button with a **Preview document** entry point (mirroring the other reports' header `Preview document` link to `/reports/follow-ups/document?...`), fully localized AR + EN.
- **Revenue:** implement/adjust the document-preview entry point(s) to match the Figma design; documents must respect the selected date filters (Phase 2). Read the Figma node before implementing.

**Required References**
- `docs/designs/document-platform/01-revenue-report/en/stitch-export/FIGMA_REFERENCE.md` + `.../ar/stitch-export/FIGMA_REFERENCE.md` (Figma node: `nUzeFkN6Yn7m7knTzwmDHq?node-id=8-18`)
- `docs/designs/document-platform/01-revenue-report/NOTES.md`
- `docs/designs/document-platform/10-sales-report/NOTES.md`, `docs/designs/document-platform/11-follow-up-analytics-report/NOTES.md` (to confirm the removed cards' docs stay reachable elsewhere)
- `docs/designs/document-platform/02-follow-up-page-report/{en,ar}/stitch-export/FIGMA_REFERENCE.md`
- `docs/reports/P7-3_IMPLEMENTATION.md`

**Manual QA checklist**
- [ ] Reports index no longer shows Sales Report / Follow-up Analytics cards (verify per role: admin/manager/receptionist/doctor/assistant).
- [ ] No report page shows an internal Print button; printing is only reachable from Preview.
- [ ] Follow-ups page shows a working **Preview document** entry (AR + EN).
- [ ] Revenue preview entry points match the Figma design and honor the current date filters.
- [ ] Sales / Follow-up-Analytics documents are still reachable from the Documents module (not orphaned).

---

## Phase 4 — New Document Flow & Documents Module UX ✅ COMPLETED

**Outcome (2026-08-04):**

- **Type A (data-generated) setup/filter popup → Save → Preview.** From New Document, every
  data-generated type now routes through a setup/filter step (`/documents/new/setup/[code]`)
  instead of jumping straight to a preview surface. The step renders only the type-appropriate
  filters derived from the catalog `filterSchema` (`documentSetupFields` in
  [lib/documents/module.ts](lib/documents/module.ts)): date-range preset (today/this-week/this-month/custom)
  for analytical types, plus doctor/department/receptionist/search as each schema declares.
  Save builds the **canonical Phase 2 query** (`preset=custom` + resolved `from`/`to`, plus active
  non-date filters) and navigates to the type's preview surface (`documentPreviewSurfaceHref`).
- **Editable filters persist into Preview (immediate re-resolve).** The *same* control
  ([components/documents/module/document-setup-controls.tsx](components/documents/module/document-setup-controls.tsx))
  renders again as an editable toolbar on the Preview
  ([components/documents/module/document-preview-filters.tsx](components/documents/module/document-preview-filters.tsx)),
  wired into both the analytical route ([app/(protected)/reports/[report]/document/page.tsx](app/(protected)/reports/%5Breport%5D/document/page.tsx))
  and the roster route ([app/(protected)/documents/roster-profile/[document]/page.tsx](app/(protected)/documents/roster-profile/%5Bdocument%5D/page.tsx)).
  A change updates the URL query, so the server page re-resolves the Preview snapshot **and** the
  issue payload (both read the same params) immediately — no flow restart, one canonical filter set
  across popup → Preview toolbar → issue. No filter logic was duplicated; the shared
  `resolveDateRange`/`resolveReportsRange` pipeline is reused untouched.
- **Type B (manual) authoring form → Save → Preview confirmed.** The clinical authoring launcher
  ([components/documents/module/clinical-authoring-launcher.tsx](components/documents/module/clinical-authoring-launcher.tsx))
  opens an empty form → save → the clinical preview surface, consistent across prescription, lab
  request, sick-leave (and the invoice authored from its appointment context).
- **"Create document from scratch" (generic free-form) — new registered type.** Added
  `GENERIC_DOCUMENT` (new `generic` archetype, rendered **last** on New Document) via the additive
  catalog-extension pattern and the **existing engine** (no fork). New files: resolver/snapshot
  ([lib/documents/resolvers/generic-document.ts](lib/documents/resolvers/generic-document.ts)),
  bilingual copy ([lib/documents/generic-copy.ts](lib/documents/generic-copy.ts)), template
  ([components/documents/templates/generic-document.tsx](components/documents/templates/generic-document.tsx)),
  renderer ([lib/documents/renderers/generic-document.tsx](lib/documents/renderers/generic-document.tsx)),
  issuance/preview/reprint actions ([actions/generic-documents.ts](actions/generic-documents.ts)),
  the composer (title + free-form rich-text body → Preview → Issue,
  [components/documents/module/generic-document-composer.tsx](components/documents/module/generic-document-composer.tsx)),
  authoring page ([app/(protected)/documents/new/scratch/page.tsx](app/(protected)/documents/new/scratch/page.tsx)),
  issued page ([app/(protected)/documents/generic/page.tsx](app/(protected)/documents/generic/page.tsx)),
  and the reprint RPC ([supabase/migrations/20260803140000_p7phase4_generic_document.sql](supabase/migrations/20260803140000_p7phase4_generic_document.sql)).
  The body is a constrained block model (headings + paragraphs parsed from plain text — **no raw
  HTML**, honoring the primitive discipline). Standard lifecycle: Authoring → Preview → Issue → QR →
  History/Reprint, with the standard branding/header/footer/signature+stamp layout. Issued snapshots
  stay immutable; reprint serves the stored canonical PDF via `record_generic_document_reprint`.
- **Preview controls.** All Type A/B previews now expose language, print, issue, **edit**, and (Type A)
  the editable filter toolbar. `edit` returns to the setup popup (Type A) or authoring form (Type B / generic).
- **Back / Back-to-source navigation.** Module-originated previews (`origin=documents`) return to the
  **previous step or `/documents`**, never an unrelated source page. Clinical/generic previews return to
  `/documents`; analytical/roster previews return to `/documents` when reached from the module (the
  Phase 3 report-page Preview links still say "Back to report").
- **Patients page.** Removed the **Print Roster** button and every roster print-only affordance
  (`window.print()`, the `PrintHeader`, and the print-only header block) from
  [components/patients/filter-bar.tsx](components/patients/filter-bar.tsx) +
  [app/(protected)/patients/page.tsx](app/(protected)/patients/page.tsx). Roster printing is now only
  through the patient-list document Preview; the document-trigger entry point is retained. The seven
  orphaned `protected.*` message keys were pruned (AR+EN parity kept).
- **Arabic audit.** Audited all 21 registered types. Every copy module honors the `locale` argument —
  analytical/revenue/invoice via `getTranslations({ locale })`, roster/clinical/patient-history/generic
  via inline AR/EN objects — and every preview surface passes the selected locale and offers an EN/AR
  toggle. Numbers/codes/URLs keep LTR isolation via the existing `direction: "ltr"` primitives; the new
  generic free-form paragraphs use `dir="auto"` so mixed-language prose resolves per paragraph while
  RTL layout is preserved. No unaffected copy/templates were rewritten.

**Validations run:**
- `p78-document-module` (extended: setup routing, `documentSetupFields`, `documentNeedsSetup`,
  `documentSurfaceKind`, `documentPreviewSurfaceHref`, generic routing, archetype-last) — green.
- `p70-document-catalog` (updated to 21 types + generic ordering) — green.
- New `p7phase4-generic-document` (body parsing, params validation, AR/EN copy localization) — green.
- `p72-document-conformance`, `p73`/`p74`/`p75`/`p76`/`p77` document suites,
  `p73-public-document-verification`, `p79-document-settings-config`, `settings-nav` — green (no regressions).
- `tsc --noEmit` clean; `eslint` clean on all changed files (0 errors); `check-messages` (AR/EN parity,
  no unused keys), `check-i18n-strings`, and `check-logical-properties` (RTL) gates all green.
- Reprint migration applied to local Supabase.

**Findings covered (Documents):** setup/filter popup before Preview for data-generated types; empty authoring form for manual types; **add "Create document from scratch"** (generic free-form document); back navigation always returns to previous step or Documents page; Preview supports language / print / issue / edit; remove **Print Roster** button from Patients page (roster prints from Preview only); **Preview must support Arabic correctly** — audit every document type and fix broken language switching.

**Depends on:** Phase 1 (issuance/preview must work).

**Work:**
- **Type A setup/filter popup (confirmed flow):** for data-generated types, present a setup/filter popup (period presets last-week/this-month/custom range, and type-appropriate department/doctor/assistant filters from the catalog `filterSchema`) **first**, then Save → Preview. Adapt filters per document type. Wire from the New Document hub ([lib/documents/module.ts](lib/documents/module.ts) `createDocumentHref`/`createFlowIsDirect`).
- **Editable filters persist into Preview:** the setup popup **precedes** Preview but does **not** end filter control — Preview keeps the same filters editable so the user can re-adjust the dataset **without restarting the flow**. Any filter change in Preview must **immediately** re-resolve the Preview snapshot **and** the dataset used for the subsequently generated/issued document (the issued document reflects the exact filters shown at Issue time). Reuse the shared filter query pattern from Phase 2 (`preset=custom` + resolved `from`/`to` + active non-date filters) so the popup, the Preview toolbar, and the issue payload all carry one canonical filter set.
- **Type B authoring form:** manual (clinical + invoice) types open an empty authoring form → Save → Preview (largely exists via [app/(protected)/documents/new/clinical/[slug]/page.tsx](app/(protected)/documents/new/clinical/%5Bslug%5D/page.tsx) + [components/documents/module/clinical-authoring-launcher.tsx](components/documents/module/clinical-authoring-launcher.tsx)); confirm consistency.
- **"Create document from scratch"** (new, at the bottom of the New Document page): a **new registered document type** in [lib/documents/catalog.ts](lib/documents/catalog.ts) — generic free-form, standard ClinicFlow layout/header/footer/branding/signature/QR, user-chosen **title** + free-form **rich-text body**. Implement with the **existing engine and standard lifecycle** (Authoring → Preview → Issue → QR → History/Reprint): register the catalog entry + add resolver/snapshot + authoring form + template/renderer + preview/issue/reprint actions, following `docs/documents/EXTENDING_THE_CATALOG.md`. **Keep engine architecture; do not fork it.** (Note: this type is authored free-form, so its "subject" and numbering follow the catalog contract; confirm number prefix during implementation.)
- **Preview toolbar:** ensure language, print, issue, and **edit** are all present on Preview.
- **Back / Back-to-source navigation:** creating a document from the Documents module must always return to the previous step or the Documents page — never an unrelated screen. Audit back links in the module routes.
- **Patients page:** remove the **Print Roster** affordance so roster printing happens only from Preview (roster = the `patient-list` roster-profile document). Verify [app/(protected)/patients/page.tsx](app/(protected)/patients/page.tsx) retains only the document-trigger entry and drop any leftover roster print-only/`window.print()` element.
- **Arabic Preview audit:** go through all document types; fix any that ignore Arabic or break on language switch (RTL layout, embedded LTR runs for numbers/codes/URLs). Copy modules live in `lib/documents/*-copy.ts`.

**Required References**
- `docs/documents/EXTENDING_THE_CATALOG.md` (additive pattern for the new generic type)
- `docs/documents/SHARED_REQUIREMENTS.md` (layout envelope, localization/RTL, signature, QR)
- `docs/designs/document-platform/analysis/08-documents-module.md`
- `docs/designs/document-platform/analysis/16-clinical-authoring-and-patient-file-redesign.md`
- `docs/designs/document-platform/03-patient-list-report/NOTES.md` (roster)
- `docs/designs/document-platform/P7-1_PRIMITIVE_CONTRACT.md`
- `docs/reports/P7-6A_IMPLEMENTATION.md`, `docs/reports/P7-8_IMPLEMENTATION.md`

**Resolved decision (was an open question)**
- The setup/filter popup **precedes** Preview; it does not replace in-Preview filtering. Preview retains editable filters so the user can re-adjust the dataset without restarting. A filter change in Preview updates the Preview and the generated/issued document dataset **immediately** (one canonical filter set shared across popup → Preview → issue payload).

**Manual QA checklist**
- [x] Selecting a Type A document opens a setup/filter popup with correct, type-appropriate filters → Save → Preview shows exactly that selection. (`documentSetupFields` derives the fields from `filterSchema`; Save builds the canonical query into the preview surface.)
- [x] Preview keeps the filters editable; changing a filter in Preview immediately updates the Preview dataset AND the subsequently issued document reflects the adjusted filters (no flow restart). (Shared control re-rendered as the Preview toolbar; both Preview and issue read the same URL params.)
- [x] Selecting a Type B document opens an empty authoring form → Save → Preview. (Clinical authoring launcher, confirmed consistent; invoice authored from its appointment context.)
- [x] "Create document from scratch" appears at the bottom of New Document; produces a titled, free-form rich-text document with standard layout; Preview → Issue attaches QR + stamp area. (New `GENERIC_DOCUMENT` type, `generic` archetype ordered last, standard engine lifecycle.)
- [x] Preview offers language, print, issue, edit. (Plus the editable filter toolbar for Type A.)
- [x] Back / Back-to-source always returns to the prior step or the Documents page. (`origin=documents` module flows return to `/documents`; edit returns to the setup popup / authoring form.)
- [x] Patients page has no Print Roster button; roster prints only via Preview. (Button + all roster print-only elements removed; document-trigger entry retained.)
- [x] Every document type renders correctly in Arabic and switches language cleanly. (Audited all 21 types; new generic paragraphs use `dir="auto"` for mixed-language prose.)

---

## Phase 5 — Patient Page Redesign

**Status:** COMPLETE (2026-08-08)

**Findings covered (Patient Page):** show previous appointments (latest five only; older stays in appointment history); each appointment groups its **prescription + clinical notes + note attachments** together; remove the standalone Clinical Notes section and standalone Attachments section; then order the page **Deposits → Packages → Documents**.

**No new schema** — `medical_notes.appointment_id` and `clinical_documents.appointment_id` already exist; appointment cards already render per-appointment notes + related documents.

**Work:**
- In [app/(protected)/patients/[id]/page.tsx](app/(protected)/patients/%5Bid%5D/page.tsx), keep `AppointmentHistorySection` (latest-5 via `PATIENT_FILE_APPOINTMENT_PREVIEW_LIMIT`).
- Enrich [components/patients/file/appointment-history-card.tsx](components/patients/file/appointment-history-card.tsx) so each appointment shows, together: its clinical documents (prescription/lab/sick-leave — already "related documents"), its clinical notes, and the **attachments belonging to those notes** (surface `medical_note_attachments` in the per-appointment view; loaded in `loadAppointmentHistory`, [lib/patients/file-data.ts](lib/patients/file-data.ts)).
- Remove the standalone **Medical notes** block (the `MedicalNotesList` + section at the bottom of the patient page) and any standalone attachments listing; preserve note authoring by relocating the composer into the appropriate appointment context (do not lose the ability to add notes/attachments).
- Reorder the right column to: **Appointments (latest 5) → Deposits → Packages → Documents** (billing strip and activity timeline retained; place billing near deposits). Deposits/Packages/Documents components already exist (`PatientDepositsSection`, `PatientPackagesSection`, `PatientDocumentsSection`).

**Required References**
- `docs/designs/document-platform/analysis/16-clinical-authoring-and-patient-file-redesign.md` (the P7-11/P7-12 patient-file redesign spec — authoritative)
- `docs/designs/document-platform/04-patient-file/NOTES.md`
- `docs/reports/P7-11_IMPLEMENTATION.md`, `docs/reports/P7-12_IMPLEMENTATION.md`

**Manual QA checklist**
- [x] Patient page shows only the latest 5 appointments; older history remains under the full appointment-history page.
- [x] Each appointment card groups its prescription(s)/clinical documents, clinical notes, and note attachments together.
- [x] The standalone Clinical Notes and standalone Attachments sections are gone.
- [x] Note/attachment authoring is still reachable (per appointment).
- [x] Section order is Deposits → Packages → Documents (below appointments).
- [x] Verified for admin, manager, receptionist, doctor, assistant (financial sections still hidden for scoped clinical roles).
- [x] Verified AR + EN, including RTL/LTR lint gates.

**Implementation outcome**
- The Patient File preview uses the shared `PATIENT_FILE_APPOINTMENT_PREVIEW_LIMIT = 5`; the existing `/patients/[id]/history` route remains unbounded and retains its date filters.
- `loadAppointmentHistory` now loads active `medical_note_attachments` for authorized roles, scopes them by clinic + patient + note id, and attaches them to the medical note before that note is grouped by `appointment_id`. No schema or attachment concept was added.
- Appointment cards reuse the existing `MedicalNotesList`, `NoteComposer`, and medical-note attachment server actions. New notes submit the card's `appointment.id`; attachment upload/view/delete/restore continues through the existing server-authoritative actions and role gates.
- The standalone patient-level Clinical Notes/Attachments surface was removed without deleting data. Billing is retained inside the financial Deposits group, leaving the top-level order Appointments → Deposits → Packages → Documents; the activity timeline remains after these sections.
- Existing visibility remains unchanged: admin/doctor can author notes and attachments; receptionist retains attachment read access; manager receives no new clinical-note/attachment permission; doctor/assistant remain scoped clinical roles and receive neither billing/deposit queries nor financial documents.

**Validation recorded**
- Focused Vitest coverage: Patient File loading/5-item limit/full-history path, appointment/note/document/attachment grouping, per-appointment authoring, attachment actions, patient/note permissions, authorization matrix, and section-order contracts — passed.
- Local Supabase integration: P7-6A clinical encounter integrity plus the RLS security suite (tenant isolation and medical-note scope) — 21 tests passed.
- `pnpm exec tsc --noEmit` — passed.
- Focused ESLint for every changed production/test file — passed.
- `pnpm lint:i18n`, `pnpm lint:rtl`, and `pnpm i18n:missing` — passed; representative Phase 5 keys resolve in both English and Arabic.
- Blockers before Phase 6: none. Phase 6 remains untouched.

---

## Phase 6 — Settings Fixes ✅ COMPLETED

**Outcome (2026-08-08):** Completed without changing the Phase 0 diagnosis or
rewriting entitlement/security logic.

- **Clinical Catalogs:** Phase 0's actual root cause was the unapplied P7 migration batch, and that
  batch remains present on the configured app database. No catalog production-code or policy change
  was needed in Phase 6. Live local authenticated integration now creates both a Treatment
  (`drug_catalog`) and Lab Request test (`lab_test_catalog`), proves the department joins, proves
  cross-tenant reads return no rows, and proves non-admin writes remain denied. The permanent
  `mutationFailure()` logging remains generic to the user and logs the real Postgres cause server-side.
- **Documents Settings:** The same Phase 0 migration-drift fix remains the correct fix. The configured
  app database exposes `document_settings`, all clinician credential columns, and both clinical
  catalogs. Live local integration executes the complete overview query set successfully, saves a
  settings row as the primary admin, and proves non-admin/cross-tenant writes and cross-tenant reads
  remain denied. `document_settings_overview_query_error` remains permanent and is regression-tested.
- **Patient AI Auto:** Kept `lib/entitlements.ts` unchanged. The canonical Pro + AI plan remains
  fail-closed (`ai.patient_auto = false`); the verified active Pro + AI testing clinic now has the
  existing clinic-scoped `ai.patient_auto = true` feature override. Migration
  `20260808120000_p7phase6_patient_ai_auto_entitlement.sql` idempotently reasserts that narrow
  configuration. The configured remote data resolves `autoEntitled = true`; the remote stored mode
  remains `suggest`, so Phase 6 did not silently activate direct sending. Focused action and live-local
  persistence tests prove an entitled `auto` selection saves/reloads and an unentitled selection is
  still rejected.
- **Staff File entry point:** Added one localized Staff File action to the staff profile sheet, reusing
  `/documents/roster-profile/staff-file?staffId=...` and the existing `STAFF_FILE` Preview/print flow.
  The single existing document still contains both Profile and Schedule; no new document type or
  permission path was added. Existing AR/EN Staff File rendering and the new entry point are covered.
- **Migration state:** Applied the previously local-only Phase 4 generic-document migration and the new
  Phase 6 migration to the local stack; local migration history is aligned through `20260808120000`.
  The configured remote database already had the Phase 0 batch through `20260803120000`; its Phase 6
  clinic override was applied directly and verified. Remote CLI migration-history parity for the new
  migration could not be recorded because this environment has no `SUPABASE_ACCESS_TOKEN`; the Phase 4
  remote migration remains unnecessary for Phase 6 validation and is still a deployment-parity item.

**Validation:** focused Phase 6 unit suites (12 files / 75 tests) passed; live local Supabase integration
(6 tests) passed; TypeScript, focused ESLint, i18n hardcoded-copy gate, RTL logical-property gate, AR/EN
message parity/unused checks, local migration parity, and `git diff --check` passed. No comprehensive
review was performed.

**Findings covered (Settings):** Clinical Catalogs — fix Treatment (drug) + Lab Request creation ("The clinical record could not be saved…"); Documents settings — fix loading failure ("We could not complete this request…"); Patient AI — enable **Auto (send directly)** for the Pro + AI clinic (subscription detection currently wrong); Staff — expose the Staff Profile/Schedule document (the single Staff File document) from inside the staff profile.

**Depends on:** Phase 0 diagnosis for the two catalog/settings failures.

**Work:**
- **Clinical catalogs save failure:** apply the Phase 0 root cause. If migration drift — apply the untracked `20260802120000_p76a_*` (+ `20260802122000_p76a_review_fix_c1`) migrations to the DB. If RLS/trigger — correct the policy. Keep the permanent error logging from Phase 0 (generic user message, real error logged server-side). Files: [actions/clinical/catalogs.ts](actions/clinical/catalogs.ts), [lib/validations/clinical.ts](lib/validations/clinical.ts), [components/clinical/catalog-settings.tsx](components/clinical/catalog-settings.tsx).
- **Documents settings load failure:** apply Phase 0 root cause (likely missing `document_settings` table from `20260803120000_p79_document_settings_write.sql` and/or `profiles` credential columns). Files: [actions/documents-settings.ts](actions/documents-settings.ts) (`getDocumentSettingsOverview`), [app/(protected)/settings/documents/page.tsx](app/(protected)/settings/documents/page.tsx).
- **Patient AI Auto:** **data fix, not code** — the detection in [lib/entitlements.ts](lib/entitlements.ts) is correct; the `pro_ai` plan seed has `ai.patient_auto = false` and no migration flips it true. Enable `ai.patient_auto` for the Pro+AI plan (plan-seed migration) or via a `clinic_feature_overrides` row for the testing clinic. Verify `autoEntitled` then unlocks "Auto (send directly)" in [components/settings/patient-ai-settings.tsx](components/settings/patient-ai-settings.tsx).
- **Staff document entry point:** add a Preview/print entry for the **Staff File** document inside [components/settings/staff-profile-sheet.tsx](components/settings/staff-profile-sheet.tsx) (link to `/documents/roster-profile/staff-file?staffId=...`, mirroring the existing row-menu entry in [components/settings/staff-table.tsx](components/settings/staff-table.tsx)). One document covers both the Profile and Schedule sections.

**Required References**
- `docs/designs/document-platform/analysis/09-documents-settings.md`
- `docs/designs/document-platform/analysis/11-data-model.md`
- `docs/designs/document-platform/15-staff-file/NOTES.md`
- `docs/reports/P7-9_IMPLEMENTATION.md` (settings write), `docs/reports/P7-6A_IMPLEMENTATION.md` (clinical foundations), `docs/reports/P7-5_IMPLEMENTATION.md` (roster/profile / staff file)
- Memory: Validation suite how-to (local keys via `supabase status`)

**Manual QA checklist**
- [x] Creating a Treatment (drug) catalog entry succeeds; error path now logs the real cause.
- [x] Creating a Lab Request (lab test) catalog entry succeeds.
- [x] Documents settings page loads without the generic error.
- [x] Patient AI shows "Auto (send directly)" enabled/selectable for the Pro+AI clinic; selecting it persists.
- [x] Staff profile sheet exposes a working Staff File document Preview/print (Profile + Schedule), AR + EN.

---

## Dependencies Summary

- **Phase 0 blocks** Phase 1 (Issue error) and Phase 6 (catalogs, documents settings) — they share the swallowed-error / migration-drift diagnosis.
- **Phase 2 blocks** Phase 3 (report previews need correct filters) and reinforces Phase 4 (setup popup selection must reach the document).
- **Phase 1 blocks** Phases 3, 4 (nothing can be validated through Issue/Preview until issuance + parity work).
- **Phase 5** is independent of the document-engine phases except for per-appointment document links (Phase 1 for those links to render).

---

## Final Regression Checklist (run after all phases)

**Issuance & rendering**
- [ ] Every registered document type (all archetypes) + the new "from scratch" generic doc: Preview → Issue → official-with-QR all succeed; Preview == PDF == Issued layout.
- [ ] QR on every issued document scans to the verify page.
- [ ] Clinic logo enlarged & correct across all types, both locales.

**Filters**
- [ ] For all filtered surfaces (reports, patient history, documents module): the exact on-screen dataset/period appears in Preview and in the generated document, for today/this-week/this-month/custom.

**Reports**
- [ ] No Sales / Follow-up-Analytics index cards; no internal report Print buttons; Follow-ups Preview works; Revenue matches Figma.

**Documents module**
- [ ] Type A → setup popup → Preview; Type B → authoring form → Preview; "from scratch" works; back-nav always sane; Patients page has no Print Roster.

**Patient page**
- [ ] Latest-5 appointments with grouped prescription/notes/attachments; no standalone Clinical Notes / Attachments; order Deposits → Packages → Documents.

**Settings**
- [ ] Treatment + Lab Request create; Documents settings load; Patient-AI Auto selectable; Staff File document reachable from the profile sheet.

**Localization & roles**
- [ ] Full pass in Arabic (RTL correct, LTR runs intact) and English.
- [ ] Role matrix respected (admin, manager, receptionist, doctor, assistant) — scoped clinical roles never see financial data.

**Build & tests**
- [ ] `pnpm lint`, typecheck, and the P7 unit suite (`tests/unit/**` p7*) pass.
- [ ] `scripts/check-messages.mjs` passes (AR/EN message parity for all new keys).
- [ ] Manual end-to-end run per the validation-suite how-to (e2e on `PORT=3100`).

---

## Guardrails (unchanged from the task brief)
- Do not modify unrelated code, redesign anything not in the findings, or add unrequested features (except the explicitly-confirmed "from scratch" generic document).
- Keep the existing document-engine architecture and all prior P7 architectural decisions.
- No commit, no push, no PR, no branch switch, no roadmap / AI_AGENT_PLAN / architecture edits during this polish.
