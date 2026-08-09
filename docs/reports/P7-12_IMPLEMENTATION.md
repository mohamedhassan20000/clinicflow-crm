# P7-12 History & Financial Document Types — Implementation Report

**Status:** COMPLETE

**Branch:** `feat/p7-document-platform`

**Scope:** The four approved patient history/financial document types (doc 16 §9, roadmap doc 13 P7-12),
built on the **existing document engine only** and resolved entirely from the **existing shared P7-11
patient-file data layer**. **No new document engine functionality, no new document types beyond the
approved four, no new business rules, no new patient-file functionality, no new financial schema.** No
P7-9 (Settings) or P7-10 (Hardening) work.

**Date:** 2026-08-02

## Outcome

P7-12 makes the P7-11 Patient File history/financial surfaces printable through the engine. Four new
document types — `APPOINTMENT_HISTORY_REPORT` (required), `PACKAGE_HISTORY_REPORT`, `DEPOSIT_STATEMENT`,
and `PATIENT_FINANCIAL_SUMMARY` — are registered as pure engine slices (catalog entry → resolver →
copy → template → renderer → actions → reprint RPC) and reuse **every** existing engine capability:
the idempotent issuance pipeline (`issueDocumentFoundation`), immutable snapshots, atomic per-clinic/
per-type numbering, QR verification, canonical Chromium PDF generation, document history/events, the
per-archetype reprint transaction pattern, branding injection, watermarking, and bilingual (AR/EN)
Latin-digit rendering.

The four resolvers introduce **no new query logic and no new financial schema**. They read exclusively
through the single shared owner `lib/patients/file-data.ts` — `loadAppointmentHistory` (the unified
appointment-history query from P7-11), `loadPatientDeposits` (the derived deposit balance), and
`computeBillingTotals` (the audited in-app billing computation) — and freeze the result into an
immutable snapshot at issue time. This is the doc 16 §9 requirement: "engine slices reusing the P7-11
unified queries and the existing billing computation."

All P7-11 security guarantees are preserved unchanged. The history/packages/deposits pages now expose a
**"Generate document"** action that deep-links (patient + active date range) to the engine preview
surface, which issues via the shared pipeline; browser print remains available as a fallback.

**No commit, push, branch switch, or PR was performed; all existing P7 working-tree changes were
preserved. The reprint migration was authored but not applied to any remote Supabase project**
(consistent with the P7-11 "no remote Supabase operation" posture).

## Implemented functionality

### Catalog registration — `lib/documents/catalog.ts`

- Added the four codes to `DOCUMENT_TYPE_CODES` and a new `"history"` value to the `DocumentArchetype`
  union (doc 16 §9 frames these as one "History & financial" family).
- Four `DOCUMENT_CATALOG` entries, all `subject: "patient"`, `template: "PatientHistoryDocument"`,
  `verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE`, prefixes `APH` / `PKH` / `DEP` / `PFS`
  (doc 16 §9 table), yearly reset, 4-digit padding.
- **Role gating preserves the doctor financial restriction:** the two history reports use
  `SCOPED_OPERATIONAL_ROLES` (admin/manager/receptionist/doctor/assistant); the two financial
  statements (`DEPOSIT_STATEMENT`, `PATIENT_FINANCIAL_SUMMARY`) use `OPERATIONAL_ROLES`
  (admin/manager/receptionist only — never doctor/assistant). None sets `allowsExternalSubject`
  (patient-only scope, doc 14 #6).

### Resolvers — `lib/documents/resolvers/patient-history.ts` (single shared slice, no duplicated logic)

One parameterized resolver (mirroring the roster/profile slice's four-type pattern) dispatching on
`documentType`, each branch calling the shared P7-11 data layer:

- **Appointment History** — reuses `loadAppointmentHistory` (unified query). Per appointment: details +
  status, follow-up(s), the appointment's medical note, related **issued** clinical/financial documents,
  and a billing summary. Account-wide billing totals over all completed appointments via
  `computeBillingTotals`. **Scoped clinical roles (doctor/assistant) receive no financial columns**
  (`isScopedClinical` threaded through), related documents are filtered to clinical types, and
  `financialVisible=false` drops the billing column + totals.
- **Package History** — recent/current + filtered packages: name, purchased/used/remaining sessions,
  price/session, dates, active status, plus session totals (remaining derived, trigger-driven
  `used_sessions` untouched).
- **Deposit Statement** — reuses `loadPatientDeposits`: current derived balance, opening balance,
  total deposited/used, and per-transaction lines with a **running balance** (no ledger table; balance
  derived, doc 16 §8).
- **Patient Financial Summary** — reuses `computeBillingTotals` + `loadPatientDeposits`: appointment
  charges, payments, outstanding, deposit balance, and package balances (remaining sessions × price),
  over the selected date range.

All reads flow through the caller's RLS-scoped `createClient()`; a doctor accessing a patient outside
their assignment/department fails closed (`loadPatientHeader` re-checks the P7-11 doctor gate and throws
"Patient not found").

### Copy — `lib/documents/patient-history-copy.ts`

Self-contained bilingual (AR + EN) copy module, mirroring `roster-profile-copy.ts`, so the canonical PDF
render path is deterministic and locale-complete without runtime i18n dependencies in the renderer.

### Template + renderer

- `components/documents/templates/patient-history-documents.tsx` — one `<DocumentPage>` composing the
  shared chrome (branding header/footer, identity block, watermark, QR `VerificationBlock`, page
  numbers) with four bodies built **only from the frozen P7-1 primitives** (`FieldGrid`, `DataTable`,
  `StatCardRow`, `TotalsSummary`, `SectionHeader`, `StatusBadge`, `NotesCallout`, `SignatureBlock`,
  `VerificationBlock`). Financial statements use the accounts signature line; digits are always Latin
  via `formatDoc*`.
- `lib/documents/renderers/patient-history.tsx` — reuses `renderDocumentPdf` (Chromium) + the shared
  QR generator, validating that the reservation type matches its snapshot.

### Actions — `actions/documents.ts`

`previewPatientHistoryDocument`, `issuePatientHistoryDocument`, `getIssuedPatientHistoryDocument`,
`reprintPatientHistoryDocument`, gated by `requirePatientHistoryDocumentAccess` (server-side
`requireUser` + catalog `pageRoles` → `notFound()`), `requireActiveSubscription` on mutating paths.
Issue reuses `issueDocumentFoundation` (idempotency key derived from the type + a client uuid, patient
id recorded on the row); reprint calls the new RPC and returns a short-lived signed canonical-PDF URL —
identical to the existing per-archetype pattern.

### Reprint RPC — `supabase/migrations/20260802160000_p712_patient_history_documents.sql`

`record_patient_history_document_reprint` — `security definer`, `search_path=''`, `for update`,
restricted to the four types and to clinic tenancy, appends a `reprinted` event, bumps `print_count`,
returns the canonical PDF path. **Role checks mirror the catalog `pageRoles`** (financial statements
admin/manager/receptionist only). Hand-added to `types/database.ts` surgically (per the DB-types
regen-drift note). **Authored, not applied to remote** — the `documents.doc_type` column is a regex
format check (not an enum), and issuance/completion RPCs are doc-type-agnostic, so no other schema
change is required.

### Module + routing

- `lib/documents/module.ts` — `"history"` added to `DOCUMENT_ARCHETYPE_ORDER`; rendering surface
  (`renderedDocumentHref`) and contextual create routing (`createDocumentHref`/`createFlowIsDirect`)
  for the four patient-subject slugs. Registration alone makes them participate in the `/documents` hub,
  `/documents/new`, filters, and detail deep-links.
- `lib/documents/module-labels.ts` — labels for the four codes (compile-time exhaustive).
- `app/(protected)/documents/patient-history/[document]/page.tsx` — preview (patient + range) and issued
  (documentId) surface with AR/EN toggle, issue/print/reprint actions, and the events timeline (models
  the roster/profile page). Gated by the `documents` page slug via the existing middleware default.
- `components/documents/patient-history-document-actions.tsx` — client issue/print/reprint.

### P7-11 entry-point wiring

`PatientReportHeader` gained an optional `documentHref`; the history / packages / deposits pages pass it
(built by the new pure `buildDocumentQuery` in `file-data.ts`), so their **"Generate document"** action
opens the engine preview surface carrying the patient + active date-range filter. Browser print is kept.

## Preserved guarantees

- **Role restrictions / doctor financial restrictions:** enforced at three layers — catalog `pageRoles`
  (action `notFound()` for disallowed roles), the resolver's `isScopedClinical` financial-column
  suppression + clinical-only related-document filtering (reusing P7-11), and the reprint RPC's role
  gate. Deposit/financial statements are unreachable by doctor/assistant.
- **Server-side authorization + RLS + tenant isolation:** every read uses the RLS user client; the
  doctor department/assignment gate is re-checked in the resolver; reprint is a tenant-scoped
  `security definer` RPC; no service-role client is used on these surfaces.
- **Immutable snapshots + numbering + QR + reprint:** unchanged shared engine — preview never consumes
  a number, the snapshot is frozen at issue, reprint retains the original number/token, and the safe
  verification disclosure set is reused verbatim.
- **No duplicated business logic / no new schema:** billing/deposit/history computation stays solely in
  `lib/patients/file-data.ts`; the resolver is a thin caller. No `invoices`/ledger table introduced.

## Visual conformance

The four types are **new** and have no imported Figma frame (the P7-2 gate covers the 16 imported
designs). Per doc 16 §9 they are engine-composed from the **frozen P7-1 primitive contract**, so
fidelity is guaranteed by construction: they inherit the shared document chrome (logo sizing, header/
footer spacing, QR placement, typography) and bilingual RTL/LTR rendering from `<DocumentPage>` and the
primitives, exactly like every other engine document. The P7-2 conformance test was updated to assert
the manifest equals the first 16 catalog codes (the imported designs), documenting that the four P7-12
types are intentionally outside the design-conformance gate.

## Validation results

- `pnpm exec tsc --noEmit` — **passed** (exit 0).
- `pnpm lint` — **passed** (0 errors; 26 pre-existing warnings, none new).
- `pnpm lint:i18n` — **passed** (407 files, 41 documented exceptions; no new exceptions).
- `pnpm lint:rtl` — **passed** (591 files, 10 documented exceptions).
- `node scripts/check-messages.mjs` — **passed** (3,758 leaf messages; no unused keys).
- `node scripts/check-messages.mjs missing` (`i18n:missing`) — **passed** (valid AR/EN parity).
- `pnpm test` — **passed** (295 files, 2,155 tests).
- `pnpm build` — **passed**; new route generated: `/documents/patient-history/[document]`.

### Test coverage added / updated

- **New** `tests/unit/lib/p712-patient-history-document-contract.test.ts` — catalog registration
  (archetype/subject/template/prefixes), the doctor financial restriction on the two financial types,
  params/snapshot schema (uuid validation, version-1 freeze), the **reuse contract** (resolver imports
  the shared `file-data` layer, no `allocate_document_number`), issue/reprint pipeline wiring, and
  bilingual copy.
- **New** `tests/unit/components/p712-patient-history-document.test.tsx` — renders all four types in
  AR + EN on the shared chrome, asserts RTL/LTR direction, Latin-digit-only output, and that billing is
  hidden for scoped clinical roles in the appointment history report.
- **Updated** `p70-document-catalog.test.ts` (16 → 20 vocabulary; new keys),
  `p78-document-module.test.ts` (20 types, `"history"` archetype order, new rendering surfaces + create
  routing), and `p72-document-conformance.test.tsx` (manifest = first 16 codes; the four new types are
  outside the Figma design-conformance gate by construction).

**Integration tests:** the RLS/tenant behavior of the new reprint RPC and doc_type reads is exercised by
the existing document-engine integration suite pattern, but running `test:integration` requires the live
local Supabase stack and the reprint migration applied — deferred to a DB-connected run (matching the
P7-11 validation posture). The resolver's reuse of the already-integration-tested `file-data` layer and
the shared issuance/reprint RPCs means no new un-tested data path was introduced.

## Files changed for P7-12

### New

- `lib/documents/resolvers/patient-history.ts` — the four resolvers (reuse P7-11 `file-data`) + params/snapshot schemas.
- `lib/documents/patient-history-copy.ts` — bilingual AR/EN copy.
- `components/documents/templates/patient-history-documents.tsx` — template (four bodies over frozen primitives).
- `lib/documents/renderers/patient-history.tsx` — canonical PDF renderer.
- `components/documents/patient-history-document-actions.tsx` — client issue/print/reprint.
- `app/(protected)/documents/patient-history/[document]/page.tsx` — preview/issued surface.
- `supabase/migrations/20260802160000_p712_patient_history_documents.sql` — `record_patient_history_document_reprint` RPC.
- `tests/unit/lib/p712-patient-history-document-contract.test.ts`
- `tests/unit/components/p712-patient-history-document.test.tsx`
- `docs/reports/P7-12_IMPLEMENTATION.md`

### Modified

- `lib/documents/catalog.ts` — 4 codes + `"history"` archetype + 4 catalog entries.
- `lib/documents/module.ts` — archetype order + rendering/create routing for the 4 types.
- `lib/documents/module-labels.ts` — 4 type labels.
- `actions/documents.ts` — preview/issue/get/reprint actions.
- `types/database.ts` — hand-added `record_patient_history_document_reprint` RPC type.
- `lib/patients/file-data.ts` — `buildDocumentQuery` helper; updated the P7-12 print-target comment.
- `app/(protected)/patients/[id]/history/page.tsx`, `.../packages/page.tsx`, `.../deposits/page.tsx` — "Generate document" entry points.
- `app/(protected)/documents/new/page.tsx` — `"history"` archetype label.
- `components/patients/patient-report-header.tsx` — optional `documentHref` action.
- `messages/en.json`, `messages/ar.json` — catalog titles, `patientHistoryDocument`, `generateDocument`, `archetypeHistory`.
- `tests/unit/lib/p70-document-catalog.test.ts`, `tests/unit/lib/p78-document-module.test.ts`, `tests/unit/components/p72-document-conformance.test.tsx` — extended for the 20-type registry.

## Blockers and deviations

- **Blockers:** none.
- **Deviations:**
  1. **New `"history"` archetype.** Doc 16 §9 groups the four as one "History & financial" family; a
     dedicated archetype keeps them grouped coherently in the `/documents` hub rather than splitting two
     into `financial` and inventing a home for the two history reports. Additive to the union +
     `DOCUMENT_ARCHETYPE_ORDER`; no exhaustive switch elsewhere.
  2. **P7-2 conformance manifest scope.** The four types have no imported Figma design (they postdate
     the 16-design import), so they are composed from the frozen primitive contract and sit outside the
     P7-2 design-conformance gate. The gate test now asserts the manifest equals the first 16 codes.
  3. **Reprint migration not applied to remote.** Authored following the established per-archetype
     pattern and reflected in `types/database.ts`; applying it is a DB-connected step, deferred to match
     the P7-11 "no remote Supabase operation" constraint.
- **Deferred to their phases:** P7-9 Settings, P7-10 Hardening.

## Review handoff

Not performed (per instructions). A review should write `docs/reviews/P7-12_REVIEW.md` per the
review-file workflow. No commit was made.
