# P7-6A — Clinical Authoring Foundations Implementation

## Status

Implemented on 2026-08-02. This phase adds the upstream clinical authoring layer only. It does not add document templates, rendering, issuance, PDF generation, QR/verification, the Document Factory, Patient File redesign, or history/financial document types.

Required review fix C1 was applied on 2026-08-02. Clinical tenant-reference validation now keeps same-clinic existence and doctor-role checks active on every write, while responsible-doctor liveness and patient soft-delete checks run only on insert or when the corresponding identity field changes. Frozen records can therefore continue through `draft → finalized → void` after the responsible doctor is deactivated or the patient is soft-deleted, without weakening original insert-time validation or tenant isolation.

## Delivered

### Data model and migration safety

- Added clinician credential fields to `profiles`: `professional_license_no`, `specialty`, `professional_title`, and private `signature_path`.
- Added `medical_notes.appointment_id` with a validated additive foreign key, matching-patient integrity trigger, and index. Existing notes remain valid with a null appointment link.
- Added clinic-managed `drug_catalog` and `lab_test_catalog` tables and department join tables. An empty join set means the entry is available to every department.
- Added `prescriptions`, `prescription_medications`, `lab_requests`, `lab_request_tests`, and `sick_leaves`.
- Every clinical header permanently separates the authenticated preparer (`created_by`) from the mandatory active clinic physician (`responsible_doctor_id`).
- Registered subjects and external-subject snapshots are mutually exclusive at the database and Zod layers. Sick leave remains encounter-bound because `appointment_id` is required.
- Cross-tenant patients, physicians, appointments, catalog entries, and department relationships are rejected by database triggers.
- Draft records may be finalized once and later voided. Finalized/void records and their line items are database-locked.
- Added query indexes for clinic/patient/doctor/status access paths and ordered line items.
- Reused the private `clinic-assets` bucket for signature/stamp assets under `staff/<clinic>/<doctor>/signature/*`; doctors can manage only their own asset and administrators retain the established clinic staff-asset access.

### RLS and permissions

- Default preparers: Admin, Manager, Receptionist, Doctor, and Assistant.
- Admin/Manager/Receptionist reads are clinic-scoped.
- Doctor reads are limited to records attributed to the doctor or patients already visible through the existing assigned-doctor/department scope.
- Assistant reads are limited to responsible/supervised doctors and patients assigned to those doctors.
- Catalog reads are clinic-wide; catalog writes are Admin-only.
- Credential writes are self-or-Admin and non-doctor profiles cannot store clinician credentials.
- Catalog relationships and line-item access inherit the parent row's RLS scope.
- No anonymous clinical-table or clinical-asset access is granted.

### Audit and lifecycle

- Added full `audit_logs` triggers for clinical headers, medication/test line items, catalogs, catalog department relationships, and clinician credential changes.
- `created_by`, `responsible_doctor_id`, subject identity, encounter identity, clinic identity, and creation time are immutable.
- Finalization records `finalized_at` and `finalized_by`; void preserves the finalized source record.
- The existing `validate_document_tenant_references()` trigger boundary was extended to validate the new clinical header references while retaining all existing document checks.

### Shared application layer

- Added the single shared Zod contract in `lib/validations/clinical.ts`.
- Added centralized server actions under `actions/clinical/*` for draft create/update, finalization, void, catalog management, credential management, signature upload/removal, and scoped reads.
- Catalog-selected medication/test names and controlled status are server-hydrated snapshots. Free-text lines remain supported.
- Added shared `components/clinical/*` forms for prescriptions, lab requests, sick leave, subject selection, clinician credentials, and catalog settings.
- External-subject UI remains capability-gated and defaults to disabled, preserving the future P7-8 per-type policy boundary.
- Added `/settings/clinical` for Admin catalog management and integrated credentials into the doctor self-profile and Admin staff profile surface.
- Extended the existing medical-note action/composer contract with optional `appointment_id` without changing existing callers.
- Regenerated `types/database.ts` from the migrated local schema and retained nullable RPC compatibility used by existing application code.

## Validation

- Local Supabase migrations: applied successfully (`20260802120000`, `20260802121000`).
- TypeScript: `pnpm typecheck` — passed.
- Focused ESLint: passed with no errors; only pre-existing hook dependency warnings remain in previously existing profile/note components.
- i18n hardcoded-copy gate: passed.
- AR/EN message parity: passed (3,591 base leaf messages).
- RTL logical-property gate: passed.
- P7-6A unit/migration tests: 8 passed.
- P7-6A live local-Supabase integration baseline: 3 passed before C1.
- Repository unit suite (integration excluded by project script): 283 files / 2,090 tests passed.
- Production build: `pnpm build` — passed (75 static/dynamic routes generated). The build retained one existing Turbopack NFT trace warning from the prior document-rendering path and the existing Next.js middleware deprecation notice; neither originates in P7-6A.
- Database lint: completed against the migrated local database. No P7-6A function or trigger was reported; the linter retained existing diagnostics in AI, billing, WhatsApp, and FAQ functions outside this phase.
- Patch hygiene: `git diff --check` — passed.

### C1 focused validation

- TypeScript: `pnpm typecheck` — passed.
- Focused ESLint: `pnpm exec eslint tests/unit/integration/p76a-clinical-authoring.test.ts` — passed.
- Focused P7-6A migration/validation/medical-note suites: 3 files / 11 tests passed.
- Patch hygiene: `git diff --check` — passed.
- Added a live regression covering both deactivated-doctor and soft-deleted-patient records through `draft → finalized → void`, plus negative assertions that equivalent new inserts remain rejected.
- The new live regression could not be executed in this Codex run because the sandbox denied access to the local Docker-backed Supabase endpoint (`supabase status` and direct `127.0.0.1:54321` access were blocked). No test failure was observed; the focused non-live checks above passed.

## Files

### Added

- `actions/clinical/_shared.ts`
- `actions/clinical/catalogs.ts`
- `actions/clinical/credentials.ts`
- `actions/clinical/index.ts`
- `actions/clinical/lab-requests.ts`
- `actions/clinical/prescriptions.ts`
- `actions/clinical/sick-leaves.ts`
- `app/(protected)/settings/clinical/page.tsx`
- `components/clinical/catalog-settings.tsx`
- `components/clinical/clinical-subject-fields.tsx`
- `components/clinical/clinician-credentials-form.tsx`
- `components/clinical/index.ts`
- `components/clinical/lab-request-form.tsx`
- `components/clinical/prescription-form.tsx`
- `components/clinical/sick-leave-form.tsx`
- `components/clinical/types.ts`
- `lib/validations/clinical.ts`
- `supabase/migrations/20260802120000_p76a_clinical_authoring_foundations.sql`
- `supabase/migrations/20260802121000_p76a_clinical_trigger_fixes.sql`
- `supabase/migrations/20260802122000_p76a_review_fix_c1.sql`
- `tests/unit/db/p76a-clinical-authoring-migration.test.ts`
- `tests/unit/integration/p76a-clinical-authoring.test.ts`
- `tests/unit/lib/p76a-clinical-validation.test.ts`
- `docs/reports/P7-6A_IMPLEMENTATION.md`

### Modified

- `actions/patients.ts`
- `app/(protected)/profile/page.tsx`
- `app/(protected)/settings/layout.tsx`
- `components/patients/note-composer.tsx`
- `components/profile/profile-page.tsx`
- `components/settings/settings-nav.tsx`
- `components/settings/settings-page-header.tsx`
- `components/settings/staff-profile-sheet.tsx`
- `lib/validations/patient.ts`
- `messages/en.json`
- `messages/ar.json`
- `messages/action-errors/en.json`
- `messages/action-errors/ar.json`
- `tests/unit/components/medical-note-attachments.test.tsx`
- `types/database.ts`

## C1 changed files

- `supabase/migrations/20260802122000_p76a_review_fix_c1.sql`
- `tests/unit/integration/p76a-clinical-authoring.test.ts`
- `docs/reports/P7-6A_IMPLEMENTATION.md`

No P7-6 or later scope and no non-blocking review observation was implemented.

## Explicitly not implemented

- Document templates or catalog slice registration for the three clinical document types.
- PDF/browser renderer changes, signature rendering, QR, public verification, numbering, issuance, or reprint behavior.
- Document Factory UI or `/documents/new` dispatch.
- Patient File redesign or contextual clinical buttons.
- History/financial document types or any P7-6/P7-7/P7-8/P7-9/P7-10/P7-11/P7-12 functionality.
