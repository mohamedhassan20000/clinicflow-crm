# P7 Manual QA Polish — Comprehensive Integrated Review

**Phase:** P7 Document Platform — Final Manual QA Polish (Phases 0–6)
**Source of truth:** `docs/P7_MANUAL_QA_POLISH.md`
**Branch:** `feat/p7-document-platform` (unchanged — no commit, push, PR, or branch switch)
**Date:** 2026-08-08
**Type:** Single comprehensive review of the complete integrated polish as ONE system.

**Working-tree posture:** verified in place on `feat/p7-document-platform`. No production code was
modified during this review. All P7 work remains intentionally uncommitted (185 working-tree entries;
14 P7 migrations, of which two — `20260803140000_p7phase4_generic_document.sql` and
`20260808120000_p7phase6_patient_ai_auto_entitlement.sql` — are polish-specific; the other twelve are
the already-approved base P7 platform).

---

## 1. Verdict

**APPROVED — ZERO REQUIRED FIXES.**

The Manual QA polish (Phases 0–6) is a coherent, faithful, and well-tested set of changes layered on
the already-approved P7 platform. Every phase's stated outcome was verified against the actual code,
migrations, and tests. The full validation suite is green. No required fixes remain before Manual QA.
Three **non-blocking observations** are recorded in §5; none block Manual QA.

The next step after this APPROVED review is **Manual QA — not commit.**

---

## 2. Validation results (integrated)

All commands run against the working tree with the local Supabase stack running.

| Gate | Result |
|---|---|
| `tsc --noEmit` (typecheck) | ✅ clean (exit 0) |
| `eslint .` (lint) | ✅ clean (exit 0) |
| `git diff --check` (whitespace/conflict) | ✅ clean (exit 0) |
| `check-messages.mjs missing` (AR/EN parity) | ✅ 3,868 base leaf messages; declared locale variants valid |
| `check-messages.mjs unused` | ✅ no unreferenced keys |
| `check-i18n-strings.mjs` (hardcoded copy) | ✅ 420 files scanned · 37 documented exceptions |
| `check-logical-properties.mjs` (RTL gate) | ✅ 609 files scanned · 10 documented exceptions |
| Full unit suite (`vitest run --exclude integration`) | ✅ **306 files / 2,232 tests passed** |
| Integration — module/clinical/foundations (DB-backed) | ✅ 3 files / 14 tests passed |
| Integration — revenue/analytical/clinical slices + Phase-6 migration + security RLS | ✅ 5 files / 10 tests passed |

The unit suite includes every P7 polish suite: `p7-date-filter-parity`, `p7phase4-generic-document`,
`p7phase5-patient-page`, `p7phase6-patient-ai`, `p7phase6-clinical-error-logging`,
`p7phase6-settings-fixes-migration`, `p70-document-catalog` (21 types + generic ordering),
`p78-documents-table`/`p78-document-module`, plus the full `p71…p712` document, conformance,
authorization-matrix, dashboard-navigation, and middleware-gating suites. Local Supabase RLS/tenant
isolation and medical-note-scope suites pass.

---

## 3. Per-phase verification

### Phase 0 — Diagnosis & permanent error logging — ✅ PASS
- Generic user-facing messages are preserved: catalog/settings/issuance failures still return the
  generic i18n strings (`clinical.mutationFailed`, `document_settings` generic error, `issueFailed`).
- Real underlying causes are permanently logged server-side:
  - `actions/clinical/_shared.ts` `mutationFailure(event, context)` extracts and logs the real
    Postgres `.message`; every catalog call site (`actions/clinical/catalogs.ts`) passes the real
    `error` with a per-operation event name (`drug_catalog_insert_failed`, etc.).
  - `actions/documents-settings.ts` logs each failing overview query (`document_settings_overview_query_error`).
  - `lib/documents/issuance.ts` folds the underlying cause into `DocumentIssueError`.
- **No sensitive DB details leak to the client.** Logged context is limited to `clinicId` + the error
  `.message` (never row payloads, tokens, or secrets); the client only ever receives the generic string.
- Root cause (unapplied P7 migration batch) is a deployment/ops matter, correctly handled.

### Phase 1 — Issuance & rendering fidelity — ✅ PASS
- The only production change was `.cf-doc-logo` / `.cf-doc-logo-fallback` sizing in the single shared
  engine stylesheet (`components/documents/engine/styles.ts`), so Preview, on-screen issued, and the
  Chromium PDF inherit it identically. Preview == PDF == Issued parity is structural (one template +
  one `DOCUMENT_ENGINE_CSS` + one HTML path), confirmed by the passing `p71…p77` parity/conformance
  and PDF-render integration suites.
- Clinic logo is sourced from `clinics.logo_url` (inlined at issue via `inlineClinicLogo`), never the
  product logo; typographic fallback preserved. QR/storage/retrieval/reprint suites green.
- Immutable snapshots + reprint semantics preserved (reprint re-serves the stored canonical PDF).

### Phase 2 — Date/filter parity — ✅ PASS
- `lib/date-range.ts` `resolveDateRange` now honors an explicit `from`/`to` pair whenever **both**
  bounds are present, labelled `preset: "custom"` — one canonical rule for the whole pipeline
  (report pages, `/reports/[report]/document`, `/reports/revenue/document`, analytical/revenue
  resolvers, AI tools). Change is backward-compatible: non-custom presets clear `from`/`to`, so no
  existing caller is affected. Verified via diff and `p7-date-filter-parity` suite.
- Non-date filter parity: doctor/department/receptionist already forwarded; the missing follow-ups
  `outcome` filter is now threaded end-to-end (link → route → params schema → snapshot filters →
  `loadFollowUpPage` `p_outcome`), with a nullable `.default(null)` for back-compat with already-issued
  snapshots. Preview and issued documents read the same params → same filtered dataset.

### Phase 3 — Reports cleanup — ✅ PASS
- Sales Report and Follow-up Analytics cards removed only from the Reports index; both types stay
  registered in the catalog and reachable via the Documents module (`createDocumentHref`:
  `SALES_REPORT → sales`, `FOLLOW_UP_ANALYTICS_REPORT → follow-up-analytics`) — not orphaned.
- Interactive `PrintSectionButton` (+ its `CardAction`) removed from `report-section-shell.tsx`;
  no report page retains an in-app `window.print()` affordance. Printing is reachable only from
  document Preview.
- Follow-ups and Revenue expose localized Preview entry points (AR + EN) that forward the resolved
  on-screen range + active non-date filters through the Phase-2 canonical pipeline.

### Phase 4 — New Document flow & generic type — ✅ PASS
- Type A setup/filter popup → Preview and Type B authoring → Preview flows verified via
  `p78-document-module`; Preview keeps the same filter control editable and re-resolves from URL
  params (one canonical filter set across popup → toolbar → issue payload) — no filter-logic fork.
- **"Create document from scratch"** is a properly registered `GENERIC_DOCUMENT` type (new `generic`
  archetype) built on the existing engine — no engine fork. Verified:
  - Body is a **constrained block model (headings + paragraphs, plain text), never raw HTML**
    (`lib/documents/generic-shared.ts`); the only `dangerouslySetInnerHTML` in the document layer is
    the static engine stylesheet.
  - Standard lifecycle Authoring → Preview → Issue → QR → History/Reprint via `issueDocumentFoundation`;
    role-gated (`pageRoles`), subscription-gated, tenant-scoped.
  - **Reprint serves the stored canonical PDF** (`record_generic_document_reprint` returns
    `pdf_storage_path`; the action signs it) — no snapshot mutation, no mutable-data regeneration.
- Patients Print Roster button + all roster print-only affordances removed; document-trigger entry
  retained; the 7 orphaned `protected.*` keys pruned (parity kept).
- Arabic/English switching verified across all 21 types (audit + bilingual suites).

### Phase 5 — Patient page redesign — ✅ PASS
- Latest-5 via `PATIENT_FILE_APPOINTMENT_PREVIEW_LIMIT = 5`; `/patients/[id]/history` stays unbounded.
- **No cross-appointment / cross-tenant leakage:** in `lib/patients/file-data.ts`, notes, follow-ups,
  documents, and settlements are all scoped by `patient_id` (+ `clinic_id`) and `appointment_id IN`
  the latest-5 set; `medical_note_attachments` are scoped by `clinic_id` + `patient_id` + `note_id`
  (from the loaded, appointment-scoped notes) and grouped by `note_id` before their note is grouped by
  `appointment_id`. RLS enforces tenant isolation (security suite green).
- Authoring still uses the existing server-authoritative note/attachment actions; standalone Clinical
  Notes / Attachments sections removed without data loss; order Appointments → Deposits → Packages →
  Documents; role-based financial visibility intact (authorization-matrix + `p7phase5` suites green).

### Phase 6 — Settings fixes — ✅ PASS
- Clinical catalogs + Documents Settings load/write correctly against the applied migration batch;
  Phase-0 permanent logging retained; RLS/validation unchanged. DB-backed + `p79`/`p7phase6` suites green.
- **Patient AI Auto entitlement is fail-closed globally.** `lib/entitlements.ts` is **unchanged**
  (confirmed via `git status`). The Phase-6 migration reasserts the `pro_ai` plan default
  `ai.patient_auto = false` and enables it **only** for the single testing clinic
  (`caf2711f-…`) via a `clinic_feature_overrides` row, and only when that clinic has an
  active/trialing `pro_ai` subscription. Idempotent (`on conflict … do update`); stored mode remains
  `suggest` (no silent direct-send activation).
- Staff File entry point: `staff-profile-sheet.tsx` now links to
  `/documents/roster-profile/staff-file?staffId=…` (label `documentPlatform.ui.staffFileDocument`),
  reusing the single existing combined Profile + Schedule document — no new type/permission.

---

## 4. Cross-cutting review — ✅ PASS

- **No duplicated business logic / no engine fork / no duplicated filter logic** — the generic type
  reuses `issueDocumentFoundation` + the shared engine; the date fix is one shared rule.
- **No browser-authoritative clinical data** — authoring flows through existing server actions; the
  generic body is validated server-side by the same zod schema before issuance.
- **RLS / tenant isolation intact** — new reprint RPC is `security definer` with `set search_path = ''`,
  authenticated-only, role- and clinic-scoped; local RLS security suite passes.
- **No mutation of issued snapshots / no mutable-data regeneration on reprint** — reprint returns the
  stored PDF path and only increments `print_count` + logs a `reprinted` event.
- **No unsafe logging** — scan found no secrets/tokens/DB-payloads logged; error logs carry `clinicId`
  + `error.message` only.
- **No unrelated feature additions attributable to the polish** — the two polish migrations and the
  phase file-sets match the plan. (The `lib/messaging/invoice-delivery.ts` / `lib/supabase/admin.ts`
  changes belong to the already-approved base P7 invoice-delivery slice, not the polish.)
- **No polish-phase roadmap/architecture edits** — `docs/AI_AGENT_PLAN.md` carries only base-P7
  reconciliation entries dated **2026-08-01/08-02**, predating the polish (2026-08-03→08); no
  polish-dated edits. Consistent with the guardrail.
- **No orphaned routes/types/i18n keys/dead actions** — unused-message gate clean; removed report
  cards remain catalog-reachable; typecheck/lint clean (would flag dead imports).
- **No accidental commit/push/branch changes** — branch remains `feat/p7-document-platform`, tree
  uncommitted.

---

## 5. Findings (all non-blocking — none required before Manual QA)

**O1 — Low — `actions/clinical/_shared.ts:200,219`** — `finalizeClinicalRecord` and
`voidClinicalRecord` call `mutationFailure()` with **no** `event`/`context`, so their DB errors are
still swallowed without a server-side log. This is *outside* the three Phase-0 target failures
(catalog create + Documents-settings load, both of which now log correctly). Not required before
Manual QA. *Minimal fix (optional):* pass an event name + the `error` (e.g.
`mutationFailure("clinical_finalize_failed", { table, id, error })`) to match the catalog pattern.

**O2 — Informational — `components/reports/report-section-shell.tsx:34`** — the passive `PrintHeader`
(a print-media-only header block) is retained after the interactive Print button was removed. It has
no interactive affordance and only renders under `@media print`, so it does not contradict "printing
from Preview only." No action required.

**O3 — Operational (deployment) — remote migration-history parity** — as the plan records, remote
migration-history parity for the polish migrations cannot be recorded in this environment without
`SUPABASE_ACCESS_TOKEN`. Local migration order is correct and chronological through
`20260808120000`; both polish migrations are additive/idempotent and non-destructive. Treat as a
deploy/ops item — **not** a functional or schema blocker.

---

## 6. Database / migration review — ✅ PASS

- **`20260803140000_p7phase4_generic_document.sql`** — defines `record_generic_document_reprint`
  only. Non-destructive (increments `print_count`, inserts a `document_events` row, returns the stored
  PDF path). `security definer`, empty `search_path`, `authenticated`-only, role- and clinic-scoped,
  `for update` row lock, restricted to `doc_type = 'GENERIC_DOCUMENT'`. No schema/table drop or alter.
- **`20260808120000_p7phase6_patient_ai_auto_entitlement.sql`** — reasserts the fail-closed plan
  default and inserts a single clinic-scoped override for the testing clinic (guarded by an
  active/trialing `pro_ai` subscription). Idempotent, non-destructive; no global entitlement change.
- **Order/history:** filenames are chronological; the two polish migrations follow the base batch.
  No destructive behavior in either. Remote parity is the ops item in O3.

---

## 7. Manual QA readiness

All prerequisites for Manual QA are satisfied: the build typechecks, lints, and passes 2,256+ tests
(unit + DB-backed integration + RLS); i18n/RTL/message gates are green; migrations are additive and
locally applied; and every phase's stated behavior was verified in code. Proceed to **Manual QA** per
`docs/P7_MANUAL_QA_POLISH.md` (e2e on `PORT=3100`). Do not commit until Manual QA is complete.

**Verdict: APPROVED — ZERO REQUIRED FIXES.**
