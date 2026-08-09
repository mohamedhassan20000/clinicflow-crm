# P7-6A Review — Clinical Authoring Foundations

**Reviewer:** Claude (independent review)
**Date:** 2026-08-02
**Branch:** `feat/p7-document-platform`
**Scope reviewed:** P7-6A — clinician credentials + private signature asset on `profiles`;
clinic-managed `drug_catalog` / `lab_test_catalog` + department join tables + `/settings/clinical`;
the clinical source records `prescriptions` (+`prescription_medications`), `lab_requests`
(+`lab_request_tests`), `sick_leaves`; the shared `lib/validations/clinical.ts`; the sole
business-logic owner `actions/clinical/*`; the shared `components/clinical/*` forms; finalization +
full audit; the `medical_notes.appointment_id` link; migrations
`20260802120000_p76a_clinical_authoring_foundations.sql` and
`20260802121000_p76a_clinical_trigger_fixes.sql`.
**Method:** Read the authoritative design (doc 16) and roadmap (doc 13 §P7-6A), the P7-6A
implementation report, and every P7-6A-changed file; read the reused patterns —
`validate_document_tenant_references()` and the P7-0 document RLS/actor scope
(`20260801120000_p70_document_foundations.sql`), the P5A clinic-assets lockdown
(`20260505210000_lock_down_profile_and_clinic_asset_policies.sql`), the existing
`patients_select_role_scoped` shape, `auth_role`/`auth_clinic_id`/`auth_department_id`/
`auth_supervised_doctor_ids`/`write_audit_log`/`set_updated_at`, `lib/rbac.ts`, the medical-note
composer/action, and page-permissions/settings-nav; verified the new DB objects exist in
`types/database.ts`; and independently ran `tsc` (clean) and the non-integration P7-6A unit + migration +
medical-note suites (11 passed).

Findings use stable IDs for the Claude→Codex handoff contract.

---

## Verdict summary

P7-6A faithfully implements the doc 16 clinical-authoring foundations and does not leak any P7-6 or
later scope. The two-layer boundary holds: the phase adds durable, human-authored clinical **source
records** only — no document catalog registration, resolver, template, renderer, issuance, numbering,
QR, verification, `/documents/new` dispatch, or Patient File redesign. Every clinical header
permanently separates `created_by` (enforced `= auth.uid()` at the RLS insert boundary and set in the
action) from a mandatory `responsible_doctor_id` (validated as an active, non-deleted clinic doctor by
the tenant-reference trigger), and both — together with subject identity, encounter link, clinic, and
creation time — are made immutable by the lifecycle trigger. Subject exclusivity (registered patient
XOR external snapshot) is enforced in both Zod and a DB `check`. External subjects are durable,
tenant-checked, and audited. The finalized/void lifecycle is DB-locked at the header and line-item
level; catalogs are clinic-read / admin-write with tenant-scoped department joins; signature assets
reuse the private `clinic-assets` bucket with correctly layered RLS (doctor-owns-own +
pre-existing admin/manager staff access). `validate_document_tenant_references()` was extended without
altering any existing `documents` check (the original body is preserved byte-for-byte behind a
`tg_table_name = 'documents'` early return). `medical_notes.appointment_id` is additive, validated
`NOT VALID` → `VALIDATE`, and backward-compatible (existing null-linked notes and callers unaffected).
The single shared owner pattern is respected: forms are thin callers that re-use the shared zod and
`actions/clinical/*`; snapshot authority (drug/test name + controlled flag) lives server-side.
Tests are meaningful and fail closed (cross-tenant reads return empty, doctor catalog write denied,
finalized line-items locked, cross-tenant `responsible_doctor_id` rejected, subject exclusivity, leave
interval).

One required fix (**C1**) — **RESOLVED** in the C1 re-review below: the tenant-reference re-validation
previously ran the doctor/patient liveness checks on **every** `UPDATE`, making a finalized record
un-voidable (and a draft un-finalizable) once the responsible doctor was deactivated or the patient was
soft-deleted. Migration `20260802122000_p76a_review_fix_c1.sql` scopes the liveness re-checks to `INSERT`
and actual identity reassignment while keeping every existence/tenant check on all writes. Verified fixed.
Four non-blocking observations (O2–O5) remain and were **not** in scope for this fix.

**Verdict: APPROVED.**

---

## Required verifications

### 1. Matches the approved architecture exactly — ✅ PASS (with C1)

Doc 16 §11 assigns P7-6A: credentials + signature asset; drug/lab catalogs + department scoping +
settings UI; the three clinical tables + line items + authorized-staff RLS; `actions/clinical/*` + zod
+ shared forms; finalization + audit; `medical_notes.appointment_id`. All are present and structured
as specified (§4.1–§4.6). The data model matches §4.3 field-for-field (status enum, `valid_until`,
priority enum, sick-leave required `appointment_id`, recipient/restrictions/return fields, `sort_order`
line items, `is_controlled_snapshot`). No deviation except the C1 lifecycle-scoping defect below.

### 2. Clinician credentials and private signature assets are secure — ✅ PASS

- `professional_license_no` / `specialty` / `professional_title` / `signature_path` added to
  `profiles` ([migration L5-9](../../supabase/migrations/20260802120000_p76a_clinical_authoring_foundations.sql#L5-L9)).
- `enforce_clinician_credential_update` blocks credentials on non-doctor profiles and denies
  non-self / non-admin credential edits (L466-494); `audit_clinician_credentials` writes a dedicated
  `profiles.clinician_credentials` audit row on any credential/signature change (L591-615).
- Signature files live under `staff/<clinic>/<doctor>/signature/*` in the private `clinic-assets`
  bucket. The new storage policies grant a doctor **select/insert/update/delete on their own** path
  only (L790-826); admin/manager staff-asset access is inherited from the pre-existing
  `clinic_assets_*_admin_manager` policies (RLS policies OR together), so admin-on-behalf upload/read
  through `uploadClinicianSignature`/`getClinicianSignatureUrl` works while the doctor-own policy
  covers self-service. No anon access is granted.
- The action enforces MIME allowlist (png/jpeg/webp), 2 MB cap, deterministic path, old-asset cleanup,
  and rolls back the storage object if the profile update fails
  ([credentials.ts L60-92](../../actions/clinical/credentials.ts#L60-L92)).

Observation **O4**: the credential **action** surface authorizes admin + doctor-self only, while
storage RLS additionally lets **manager** touch staff assets (pre-existing behavior). Not a P7-6A
regression, but the two authorization surfaces are not identical.

### 3. Drug/Lab catalogs and department scoping are correct — ✅ PASS

- `drug_catalog` / `lab_test_catalog` are clinic-scoped, `unique (id, clinic_id)`, name-length checked,
  with `is_controlled` / `is_active`; join tables are composite-PK, cascade on both sides
  (L30-69).
- RLS: clinic-wide select, admin-only write on catalogs and department joins; join-table writes require
  the parent catalog to be in the caller's clinic (L692-716). `validate_catalog_department_scope`
  rejects a department from a different clinic than the catalog (L423-445).
- Department scoping in authoring is enforced server-side in `hydrate*` (`CLINICAL_CATALOG_DEPARTMENT_SCOPE`
  when the responsible doctor's department is not in a scoped entry's set) and `CLINICAL_CATALOG_INACTIVE`
  for inactive entries ([_shared.ts L92-109, L145-157](../../actions/clinical/_shared.ts#L92-L109));
  the empty-join = "all departments" rule holds. This matches doc 16 §4.4 (autocomplete/UX scope, free
  text always allowed). See **O2** on the DB layer.

### 4. Prescription / Lab / Sick-leave / line-item models complete — ✅ PASS

All headers carry `clinic_id`, `created_by`, `responsible_doctor_id`, subject identity, optional
`appointment_id` (required + `on delete restrict` for sick leave, per §4.3), status, finalization
columns, timestamps, and `unique (id, clinic_id)`. Line items cascade-delete, snapshot the catalog id
(nullable, `on delete set null`) plus free-text name, and are ordered by `(parent, sort_order, id)`.
Zod requires ≥1 medication/test, caps at 100, and enforces the sick-leave interval + return-date rules
mirrored by DB `check`s. Both create/update actions insert header then children and roll back on child
failure.

### 5. `created_by` and `responsible_doctor_id` enforced correctly — ✅ PASS

- Insert RLS `with check (created_by = auth.uid() and status = 'draft' and auth_role() in <preparer set>
  and can_access_clinical_record(...))` (L720-724, and lab/sick equivalents).
- Actions set `created_by = user.id`, `status: 'draft'` and never trust client subject-of-record fields
  for those columns.
- `responsible_doctor_id` validated as `role = 'doctor' and is_active and not is_deleted and
  deleted_at is null` in the tenant trigger (L284-292).
- Lifecycle trigger `CLINICAL_IDENTITY_IMMUTABLE` freezes `created_by`, `responsible_doctor_id`,
  subject fields, `appointment_id`, `clinic_id`, `created_at` on every update (L330-342). The
  integration test asserts the preparer/physician split persists and survives finalization.

### 6. External-subject identity durable, audited, tenant-safe — ✅ PASS

DB `*_subject_check` enforces registered XOR external at the row level; `subject_dob <= current_date`;
Zod `clinicalSubjectSchema.superRefine` mirrors it and forbids external DOB/national-id on a registered
subject. External snapshots (`subject_full_name/dob/national_id`) are immutable post-create, fully
audited via `write_audit_log`, and never widen access (the external path yields no patient row, so a
doctor may only create/read an external record where they are the responsible physician via
`can_access_clinical_record`). Sick leave stays encounter-bound (`appointment_id` required in both DB
and zod), so external sick leave is structurally impossible — consistent with §4.3. External-subject UI
is capability-gated (`allowsExternalSubject`, default **false**), preserving the P7-8 boundary.

### 7. Finalized records lifecycle-locked correctly — ✅ PASS

`enforce_clinical_record_lifecycle` allows only `draft→{draft,finalized}` and
`finalized→{finalized,void}`, makes `void` terminal, and — once `status <> 'draft'` — rejects any
change other than `status`/`updated_at` (`FINALIZED_CLINICAL_RECORD_IMMUTABLE`, L344-355).
`enforce_clinical_line_item_draft` + the line-item RLS write policies (`parent.status = 'draft'`) lock
medications/tests once the parent leaves draft; the finalization `check` constraint keeps
`finalized_at`/`finalized_by` consistent with status. The action-layer `finalize`/`void` guards
(`.eq("status","draft")` / `.eq("status","finalized")`) fail closed to `recordLocked`.

### 8. RLS and role authorization match the approved preparer policy — ✅ PASS

Preparer set is exactly Admin/Manager/Receptionist/Doctor/Assistant (`CLINICAL_PREPARER_ROLES` and the
insert `with check`), matching doc 16 §3. Read scope is centralized in `can_access_clinical_record`,
which reproduces the `patients_select_role_scoped`/documents-select shape: admin/manager/reception
clinic-wide; doctor limited to own-attributed records or patients in their assignment/department;
assistant limited to supervised doctors or those doctors' patients (L640-680). Line-item and
catalog-join policies inherit the parent scope. Catalog reads are clinic-wide, writes admin-only.
`/settings/clinical` is `requireRole("admin")` and nav-gated by `clinicalAdminOnly`.

### 9. `medical_notes.appointment_id` remains backward-compatible — ✅ PASS

Column added nullable; FK added `NOT VALID` then `VALIDATE` (safe on existing rows); partial index only
where non-null; `validate_medical_note_appointment` fires only when `appointment_id` is set and checks
same-patient + same-clinic. The composer renders the hidden `appointment_id` field only when an id is
passed, and the patient action/zod treat it as `optional().nullable()` → existing callers send nothing
→ null. No existing note or caller path changes.

### 10. Shared actions/validation/components — no duplicated business logic — ✅ PASS

`lib/validations/clinical.ts` is the single contract; `actions/clinical/*` is the sole owner of
persistence, RLS-scoped reads, hydration/snapshotting, finalization, void, and audit; `_shared.ts`
centralizes the preparer-role gate, hydration, and finalize/void. The forms re-import the shared zod
and call the shared actions; server hydration authoritatively overrides `drug_name`/`test_name`/
`is_controlled_snapshot` from the catalog, so the client's display snapshot is never trusted.

### 11. No P7-6 or later scope leaked — ✅ PASS

Grep confirms no `DOCUMENT_CATALOG` registration of `PRESCRIPTION`/`LAB_REQUEST`/
`SICK_LEAVE_CERTIFICATE`, no resolver/template/renderer, no `/documents/new` clinical dispatch, no QR/
verification/numbering, and no Patient File redesign. `allowsExternalSubject` exists only as a
default-false prop (the reserved P7-8 capability), not a factory. `revalidatePath("/documents")` in the
actions is a cache hint, not a module dependency.

### 12. Tests meaningful and fail closed — ✅ PASS (see O3)

Integration test asserts tenant isolation (foreign clinic reads `[]`), doctor catalog-write denial,
preparer/physician persistence, finalized line-item lock, external-subject snapshot, appointment-linked
note, and cross-tenant `responsible_doctor_id` rejection — all negative paths assert an error or empty
result. Zod unit test covers subject XOR, required line items, and leave-interval invalidation. The
migration test is a structural string-guard (weaker, but complements the live integration test).
Independent run: `tsc` clean; 11 non-integration tests pass.

---

## Findings

### C1 — REQUIRED FIX · ✅ RESOLVED — Lifecycle updates re-validate doctor/patient scope, making finalize/void fail after deactivation

**Resolution (C1 re-review, 2026-08-02):** Fixed by `20260802122000_p76a_review_fix_c1.sql`. The trigger
now computes two guards at the top of the clinical branch — `v_validate_doctor_liveness` /
`v_validate_patient_liveness`, both defaulting to `true` and, only on `tg_op = 'UPDATE'`, set to
`new.<id> is distinct from old.<id>`. The doctor `is_active/not is_deleted/deleted_at is null` re-check
(L75-83) and the patient `not is_deleted` re-check (L92-97) are gated behind those guards, so they run on
INSERT and on genuine identity reassignment only. Every existence/tenant check remains ungated and fires
on all writes: preparer same-clinic (L59-64), responsible-doctor same-clinic + `role = 'doctor'` (L66-73),
patient same-clinic existence (L85-90), appointment same-clinic + patient match (L99-109), finalizer
same-clinic (L111-116). The `documents` branch is untouched (early `return new` at L51). Verified against
the five re-review criteria and a live regression (see the C1 re-review run below). **Confirmed fixed.**

---


`validate_document_tenant_references()` fires `before insert **or update**` on all three clinical
headers (L496-504) and, in the clinical branch, unconditionally requires `responsible_doctor_id` to be
an **active, non-deleted** doctor (L284-292) and `patient_id` to be a non-soft-deleted patient
(L294-299). Because `responsible_doctor_id`/`patient_id` are immutable, a `finalize` or `void` update
re-runs these checks against the *unchanged* ids.

Failure scenario: a draft prescription is authored for Dr. X and finalized; Dr. X later leaves the
clinic (`is_active = false`); an admin attempts to **void** that finalized prescription to issue a
corrected one (doc 16 §12 Q2: "correction = new record + void of old"). The update is rejected with
`CLINICAL_DOCTOR_SCOPE_VIOLATION`, so the record is permanently stuck as `finalized` and cannot be
voided. The symmetric case blocks **finalizing** an existing draft after the patient is soft-deleted or
the doctor is deactivated (`CLINICAL_PATIENT_SCOPE_VIOLATION` / `CLINICAL_DOCTOR_SCOPE_VIOLATION`). This
contradicts both the design and the P7-6A report ("Draft records may be finalized once and later
voided").

Suggested fix: apply the `responsible_doctor_id` active-doctor check and the `patient_id`
not-soft-deleted check on `INSERT`, and on `UPDATE` only when the underlying id column actually changes
(e.g. `tg_op = 'INSERT' or new.responsible_doctor_id is distinct from old.responsible_doctor_id`).
The clinic/existence tenant checks may remain on both; only the *active/not-deleted* liveness re-check
should be scoped away from status-only lifecycle transitions. (Confidence: CONFIRMED — trigger fires
`before update`, ids are frozen by the lifecycle trigger, and the liveness predicate is unconditional.)

### O2 — Observation · Catalog department scope enforced only in the application layer

`validate_clinical_catalog_reference` checks catalog↔parent **clinic** match but not department; the
department constraint lives only in `hydrate*`. A direct DB write (service role, or a future non-action
caller) with an out-of-department but in-clinic `drug_catalog_id` would pass all DB triggers/RLS. Per
doc 16 §4.4 department scope is an autocomplete/UX filter (free text always allowed), so this is
acceptable, but the app is the sole enforcer — worth a comment or a DB-level guard if that ever becomes
a hard requirement.

### O3 — Observation · Migration test is a structural string-match

`p76a-clinical-authoring-migration.test.ts` asserts substrings are present in the SQL file rather than
behavior; it would not catch a semantic regression (e.g. a policy that compiles but scopes wrongly).
The live integration test covers the important behaviors, so this is a minor redundancy note, not a
gap.

### O4 — Observation · Credential action vs storage-RLS authorization surfaces differ

See §2: the credential actions authorize admin + doctor-self; storage RLS additionally permits manager
on staff assets (pre-existing). No functional issue today; flagged for consistency.

### O5 — Observation · Draft subject/doctor are immutable even during draft editing

`CLINICAL_IDENTITY_IMMUTABLE` freezes `responsible_doctor_id`/`patient_id`/subject/`appointment_id` from
creation, so `updateDraft` succeeds only when those fields are unchanged; correcting a wrong doctor on a
draft requires delete-and-recreate (the `*_delete_own_draft` policy is the escape hatch). This is
defensible under "both are permanent" (doc 16 §3) but is stricter than a typical draft and the update
actions still send those columns (silently no-op unless changed). Consider either documenting the
constraint or relaxing identity mutability while `status = 'draft'`.

---

## Independent validation run

- `pnpm typecheck` (`tsc --noEmit`) — **clean**.
- `pnpm vitest run` on `p76a-clinical-validation`, `p76a-clinical-authoring-migration`,
  `medical-note-attachments` — **11 passed / 3 files**.
- Live-Supabase integration test (`p76a-clinical-authoring.test.ts`) not re-run here (requires a running
  local stack + secret keys); reported as 3 passed by the implementation and its assertions were read
  and judged meaningful/fail-closed.

---

## C1 focused re-review (2026-08-02)

Scope: **C1 fix only** — `20260802122000_p76a_review_fix_c1.sql`,
`tests/unit/integration/p76a-clinical-authoring.test.ts`, and `docs/reports/P7-6A_IMPLEMENTATION.md`. No
production code was modified during this re-review.

**Criteria — all PASS:**

1. **Doctor liveness + patient soft-delete run on INSERT and real identity changes** — ✅ The liveness
   guards default to `true`; only under `tg_op = 'UPDATE'` are they narrowed to `is distinct from old`.
   INSERT and identity reassignment therefore still run the full active/not-deleted predicates.
2. **Valid `draft → finalized → void` survives doctor deactivation / patient soft-delete** — ✅ The live
   regression finalizes and voids one prescription after `is_active = false` on the responsible doctor
   and another after the patient is soft-deleted; both reach terminal `void`.
3. **Tenant isolation + existence enforced on every write** — ✅ All same-clinic existence checks
   (preparer, doctor+role, patient, appointment+patient-match, finalizer) are ungated and fire on INSERT
   and UPDATE alike; the `documents` branch returns early unchanged.
4. **Invalid new inserts still fail** — ✅ Insert with a deactivated doctor raises
   `CLINICAL_DOCTOR_SCOPE_VIOLATION`; insert against a soft-deleted patient raises
   `CLINICAL_PATIENT_SCOPE_VIOLATION` (both asserted by the regression).
5. **No P7-6 or later scope leaked** — ✅ The change is confined to the trigger function body; the test
   adds a single lifecycle regression; the report documents only the C1 fix. No catalog registration,
   resolver, renderer, issuance, numbering, verification, or Patient File work introduced.

**Validation run (this re-review):**

- `npx tsc --noEmit` — **clean**.
- Focused integration suite `p76a-clinical-authoring.test.ts` against the local stack (migration
  `20260802122000` applied via `supabase migration up`) — **4 passed**, including the new
  deactivated-doctor / soft-deleted-patient lifecycle regression. (Before applying the C1 migration the
  new regression reproduced the original defect with `CLINICAL_DOCTOR_SCOPE_VIOLATION`, confirming the
  test is meaningful and the migration is what fixes it.)
- `p76a-clinical-validation` + `p76a-clinical-authoring-migration` — **8 passed**.

C1 is confirmed resolved. Observations O2–O5 remain open and non-blocking (outside this fix's scope).

---

**Verdict: APPROVED.**
