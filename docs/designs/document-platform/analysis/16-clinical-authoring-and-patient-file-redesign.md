# 16 · Clinical Authoring, Central Document Factory & Patient File Redesign

## Objective

Define the architecture that **unblocks P7-6** (clinical documents) and delivers the founder-requested
**central document factory** and **patient-file redesign**. It supplies the missing upstream dependency
the platform always assumed — durable, doctor-attributed, auditable clinical records — and specifies the
new sub-phases (**P7-6A, P7-11, P7-12**) plus the scope expansion of **P7-8**.

This is a **design proposal**. No migrations, forms, pages, or production code are created by it.

> **Boundary reaffirmed (SHARED_REQUIREMENTS §14/§15, doc 02 §3-D, doc 11).** The document engine must
> never synthesize clinical intent from an appointment, a medical note, or a browser payload. Clinical
> content becomes real only when a human authors and persists a structured clinical record; the engine
> then renders + issues + verifies **from that record's snapshot**.

---

## 1. Why this is the planned unblock, not a new direction

- P7-6 was **blocked** (`docs/reports/P7-6_IMPLEMENTATION.md`): no structured prescription / lab-request /
  sick-leave source record, and no clinician professional-licence source, exist in the repo.
- `SHARED_REQUIREMENTS` **§14** already reserves "future authoring forms inside a redesigned patient visit
  workflow," and **§15** already reserves a "future patient-file redesign" that keeps appointment details,
  medical notes, and clinical authoring as **"separate persisted and auditable records."**
- The central factory the founder wants is the already-planned **P7-8 Documents module**
  (`/documents`, `/documents/new`, `/documents/[id]`; doc 08). It needs its **scope expanded**, not a
  parallel module.

This document is the authoritative design for that reserved work.

---

## 2. Two-layer clinical model (the non-negotiable boundary)

```
Layer 1 — CLINICAL RECORD (source of truth)      Layer 2 — ISSUED DOCUMENT (immutable snapshot)
prescriptions / lab_requests / sick_leaves   ─▶  documents row + PDF (existing engine, doc 05/11)
  • prepared by authorized staff, structured       • snapshot frozen at issue from the record
  • status: draft → finalized (locked) → void      • number allocated at issue (never at preview)
  • responsible physician + preparer recorded       • verification token / QR / events
  • RLS + encounter link + full audit                • credentials + signature/stamp snapshotted
```

- The resolver reads the persisted clinical record (by id / `source_ref`) and snapshots it. It never reads
  a browser payload, note, or appointment to synthesize clinical content.
- The **clinical record is the clinical source of truth**; the PDF/document snapshot is a faithful,
  immutable copy — not the source of truth (doc 05 §4).
- Issue is idempotent on a key derived from the clinical record id (doc 05 §3.1); preview never consumes a
  number (doc 05 §1, SHARED_REQUIREMENTS §9).

---

## 3. Clinical responsibility & authorization (founder policy)

**Authoritative wording:** "The system allows any authorized clinic staff member to prepare the clinical
document. Clinical responsibility always belongs to the selected responsible physician. A clinical document
is not considered clinically valid until it has been signed, stamped, or both by that physician. The system
permanently records both the preparer (`created_by`) and the responsible physician (`responsible_doctor_id`)
for complete auditability."

- **Preparer vs physician of record.** Every clinical record separates `created_by` (the authenticated
  staff member who prepared it) from `responsible_doctor_id` (the physician the document is attributed to,
  selected during authoring; validated as an active clinician in the clinic). Both are permanent.
- **Default authorized preparers (closed decision):** **Admin, Manager, Receptionist, Doctor, Assistant
  (when enabled).** `responsible_doctor_id` is mandatory regardless of who prepared the record. Future
  clinics may restrict these roles via the existing permission model; the above is the default behavior.
- **Validity is signature/stamp-based, not an in-app doctor-only gate.** Preparation is broad; clinical
  validity is asserted by the responsible physician's signature/stamp on the issued document (§6).
- Authorization reuses `requireUser` / `requireMutationRole` / `lib/rbac.ts` and a `documents` page slug;
  it never widens data access beyond the preparer's RLS scope on the subject.

---

## 4. Data model (P7-6A)

All tables are **clinic-scoped**. Writes go only through server actions; RLS mirrors the existing
`patients`/`medical_notes` scoping. Extends `validate_document_tenant_references()` to cover the new subject
FKs and `responsible_doctor_id`.

### 4.1 Clinician credentials — `profiles` (alter existing)

| Field | Action |
|-------|--------|
| `professional_license_no text null` | add — shown on clinical documents |
| `specialty text null` | add — per-doctor specialty (distinct from `department_id`) |
| `professional_title text null` | add (optional) |
| `signature_path text null` | add (optional) — signature/stamp asset in a private bucket |

Edited in Staff settings (self/admin). Completeness surfaced in Documents Settings (doc 09, P7-9).

### 4.2 Subject identity (shared by all three clinical headers)

Exactly one identity path is required:
- `patient_id uuid null references patients(id)` — a registered clinic patient; **or**
- external-subject snapshot fields: `subject_full_name text`, `subject_dob date null`,
  `subject_national_id text null` — a non-registered person, allowed only where the type's
  `allowsExternalSubject` capability is true (doc 08 §4, doc 14 open question).

### 4.3 Clinical records

```
prescriptions (
  id, clinic_id, created_by, responsible_doctor_id,
  patient_id? / subject_* ,               -- exactly one identity path
  appointment_id? references appointments(id),   -- optional encounter link
  status text ['draft'|'finalized'|'void'], valid_until date null, notes text,
  finalized_at timestamptz null, finalized_by uuid null, timestamps
)
prescription_medications (
  id, prescription_id references prescriptions(id) on delete cascade,
  drug_catalog_id uuid null, drug_name text,      -- catalog or free text (snapshotted)
  dose text, frequency text, duration text, route text, quantity text, instructions text,
  is_controlled_snapshot bool, sort_order int
)

lab_requests (
  id, clinic_id, created_by, responsible_doctor_id, patient_id?/subject_*, appointment_id?,
  priority text ['routine'|'urgent'|'stat'], laboratory_name text null,
  clinical_context text, instructions text,        -- fasting / timing
  status, finalized_at?, finalized_by?, timestamps
)
lab_request_tests (
  id, lab_request_id references lab_requests(id) on delete cascade,
  lab_test_catalog_id uuid null, test_name text, notes text, sort_order int
)

sick_leaves (
  id, clinic_id, created_by, responsible_doctor_id, patient_id?/subject_*,
  appointment_id references appointments(id),       -- required; exceptions via legal profile
  leave_start_date date, leave_end_date date,
  recipient_organization text null, recipient_reference text null,
  restrictions text null, return_date date null,
  status, finalized_at?, finalized_by?, timestamps
)
```

### 4.4 Clinic-managed reference catalogs

```
drug_catalog        (id, clinic_id, name, form?, strength?, is_controlled bool, is_active)
drug_catalog_departments      (drug_catalog_id, department_id)     -- empty ⇒ all departments
lab_test_catalog    (id, clinic_id, name, is_active)
lab_test_catalog_departments  (lab_test_catalog_id, department_id) -- empty ⇒ all departments
```

- **Optional, never mandatory.** Free-text lines are always allowed. Catalogs drive **autocomplete** while
  authoring and the **controlled-medicine block**. Department-scoped entries filter the autocomplete to the
  responsible doctor's department (or all).
- Baseline carries a prominent "clinic-issued; not a controlled-substance-compliant prescription"
  disclaimer; medications flagged `is_controlled` are blocked from issuance until an approved compliance
  profile exists (prescription spec §2).
- Admin-managed from Settings (permission + department-scope representation confirmed in doc 14).

### 4.5 Medical-note ↔ appointment link (enables the unified view)

`medical_notes` += `appointment_id uuid null references appointments(id)`. Existing patient-scoped notes
keep working (null link); the redesigned Patient File uses the link to show the note under its appointment.

### 4.6 RLS summary

- Insert on the clinical tables allowed for the default authorized preparer roles; the row records
  `created_by = auth.uid()` and a validated `responsible_doctor_id`.
- Read scope mirrors `patients_select_role_scoped` (clinical-scoped roles limited to their
  patients/supervised doctors; admin/manager/reception per the confirmed matrix, doc 14 open decision #1).
- Catalogs readable clinic-wide, writable by admin.
- All identity/number/token/PDF writes remain in the existing SECURITY DEFINER RPCs — the clinical layer
  never forges document identity.

---

## 5. Single shared authoring owner (no duplicated business logic)

```
components/clinical/*  (shared structured forms + zod)   ← UI, reused by BOTH entry points
        │
        ├── Patient File (P7-11): patient + encounter preselected, doctor visit workflow
        └── Document Factory /documents/new (P7-8): admin selects any patient / external subject
        │
        ▼
actions/clinical/{prescriptions,lab-requests,sick-leaves,catalogs}.ts   ← SOLE business-logic owner
   createDraft · updateDraft · finalize · void   (requireUser + preparer-role gate + RLS)
        │
        ▼
issueDocumentFoundation (existing, lib/documents/issuance.ts) → PDF + documents row
```

- Both entry points are **thin callers**. Validation (`lib/validations/clinical.ts`), persistence, RLS,
  finalization, and audit live once in the actions layer.
- **Patient File** is context-aware: patient already selected, current encounter preselectable, optimized
  for the visit. **Document Factory** is administrative: search/select any patient (or an external subject
  where permitted), prepare documents outside the active visit.
- No parallel logic: the difference is entry-point context only. This is the same "the module is the hub,
  not the only door" pattern already established for contextual issuance (doc 08 §1).

---

## 6. Clinical document rendering rules (P7-6)

Registers the three already-declared codes `PRESCRIPTION` (RX), `LAB_REQUEST` (LAB),
`SICK_LEAVE_CERTIFICATE` (SL) as engine slices (catalog entry + resolver reading the persisted record +
template + renderer + copy + actions + reprint RPC). No engine-core change.

- **Credential snapshot.** Every issued clinical document snapshots `responsible_doctor_id` plus that
  clinician's credentials (name, `professional_license_no`, `specialty`, `professional_title`,
  signature/stamp asset) into the immutable snapshot, so reprints stay faithful even if the profile later
  changes.
- **Manual signature fallback (mandatory rendering rule — all three clinical types):** "If the responsible
  physician does not have a stored digital signature or stamp, every preview, print, PDF, and issued
  document must render a clearly labelled blank signature/stamp area so the physician can manually sign
  and/or stamp the printed document." Enforced by the `SignatureBlock` slot bound to the responsible
  physician (stored `signature_path` when present, otherwise the labelled blank sign/stamp box).
- **Prescription validity note (mandatory, bilingual, bottom of every render — preview/print/PDF/issued):**
  - Arabic: «لا تُعد هذه الوصفة الطبية معتمدة إلا بعد توقيع الطبيب أو ختمه أو كليهما.»
  - English: "This prescription is not considered valid unless signed, stamped, or both by the responsible
    physician."

---

## 7. Central Document Factory (P7-8, scope expanded)

`/documents/new`: pick document type →
- **clinical types** dispatch to the shared `components/clinical/*` authoring form (create/load a clinical
  record, then issue) — **not** a parameter form;
- **report / history / financial types** keep the parameter form (doc 08 §4).

Additions:
- **Administrative subject selection** open to authorized staff (patient search/select).
- **`allowsExternalSubject`** per-type capability (default **false**): governs whether a document may be
  prepared for a non-registered person, captured via the external-subject snapshot fields (no `patient_id`),
  fully audited. Confirmed per type in doc 14 (open decision #4).
- Preview never consumes a number (reaffirmed).

---

## 8. Patient File redesign (P7-11 — primary clinical workspace, §15)

Groups related information instead of scattering it, and becomes the primary clinical workspace.

- **Unified appointment-history section** — one card per appointment combining: details + status,
  appointment follow-up, invoice/billing, the appointment's medical note (via §4.5 link), and related
  clinical documents (`documents` where `appointment_id` matches). **Latest 5** on the main page +
  **"Full history"** button.
- **Full appointment-history page** — custom date range + last week / month / year presets; preserves
  doctor/assistant scope (`isScopedClinical`); **Print → `APPOINTMENT_HISTORY_REPORT`** through the engine.
- **Packages section** — recent/current on the page + dedicated all-packages page (sessions, usage,
  remaining balance, status, dates, filters); printable via `PACKAGE_HISTORY_REPORT`.
- **Deposits section** — current balance, transactions, related appointment usage + full deposits page;
  printable via `DEPOSIT_STATEMENT` / `PATIENT_FINANCIAL_SUMMARY`.
- **Documents section** — kept, integrated into the new navigation hierarchy.
- **Contextual clinical actions** — **New Prescription / New Lab Request / New Sick Leave** buttons open the
  shared authoring forms (§5) with patient (+ current encounter) preselected. They open **forms**, not
  direct document generation.
- Decompose the 868-line monolith (`app/(protected)/patients/[id]/page.tsx`) into per-section server
  components, preserving the existing role-gated conditional fetching and the doctor no-financials rule at
  both query and RLS layers.

**Data honesty for the redesign:** there is **no `invoices` table** — "invoice/billing" = appointment
payment columns + `outstanding_settlements` + `patient_deposits`, with account balance computed in-app;
package usage is trigger-driven on `patient_packages.used_sessions`; deposits have **no ledger table**
(balance derived). The new document resolvers reuse the existing billing computation (factored into a
shared resolver) rather than introducing new financial schema.

---

## 9. New document types (P7-12)

Engine slices reusing the P7-11 unified queries; all clinic-scoped, patient-subject, with the safe
verification disclosure.

| Code | Prefix | Subject | Source |
|------|--------|---------|--------|
| `APPOINTMENT_HISTORY_REPORT` (**required**) | `APH` | patient | filtered unified appointment history (§8) |
| `PACKAGE_HISTORY_REPORT` | `PKH` | patient | `patient_packages` (+ session usage) |
| `DEPOSIT_STATEMENT` | `DEP` | patient | `patient_deposits` + appointment `deposit_amount` usage |
| `PATIENT_FINANCIAL_SUMMARY` | `PFS` | patient | deposits + appointment charges/payments + outstanding + package balances, over a selected date range |

`PATIENT_FINANCIAL_SUMMARY` as a distinct type (vs extending Invoice/Revenue) and its patient-only scope
are confirmed in doc 14 (open decision #6).

---

## 10. Consistency with the approved platform

- **Roadmap:** consistent — §14/§15 reserved exactly this; P7-6 was blocked awaiting this data source.
- **Permissions:** reuse `requireUser`/`requireMutationRole`/`lib/rbac.ts` + a `documents` page slug;
  clinical authoring open to authorized staff (not doctor-only), always recording `created_by` +
  `responsible_doctor_id`.
- **RLS / tenant isolation:** new tables clinic + role scoped; insert by authorized staff; writes via server
  actions; tenant-reference trigger extended.
- **Lifecycle (doc 05):** two-layer separation preserves snapshot immutability; preview never consumes a
  number; idempotency key derives from the clinical record id.
- **Engine (doc 01/03/04):** pure slice additions; no core change; resolvers read persisted records only.
- **No duplicated logic:** single `actions/clinical/*` + shared forms + shared zod; both surfaces are thin
  callers.

---

## 11. Sub-phase ownership

| Phase | Owns |
|-------|------|
| **P7-6A — Clinical Authoring Foundations** | clinician credentials + signature asset; drug/lab catalogs + department scoping + settings UI; clinical tables + line items + authorized-staff RLS; `actions/clinical/*` + zod + shared `components/clinical/*` forms; finalization + audit; `medical_notes.appointment_id` |
| **P7-6 — Clinical documents (unblocked)** | register the 3 clinical codes; resolvers/templates/renderers/reprint RPCs/verify labels; validity note + signature fallback |
| **P7-8 — Documents module / Central Factory (expanded)** | clinical-authoring dispatch; admin subject select; `allowsExternalSubject` |
| **P7-11 — Patient File redesign & unified history** | unified appointment section; full history page; packages/deposits sections + pages; documents integration; contextual clinical buttons; monolith decomposition |
| **P7-12 — History & financial document types** | the 4 new document slices reusing P7-11 queries |

---

## 12. Open founder decisions (non-blocking; confirm before the dependent phase)

1. **Clinical read-visibility matrix** per role (preparer set is closed; this is who may *view* each clinical
   record/document + RLS scope). — before P7-6A.
2. **Amendment/versioning:** once finalized + issued, are amendments allowed? Proposed: finalized records
   immutable; correction = new record + void of old document (ties to the open regenerate policy, doc 14
   §4 Q1). — before P7-6.
3. **Sick-leave legal profile:** max duration / backdating / future-start caps; baseline clinic-issued only,
   fail-closed when unknown. — before P7-6.
4. **External-subject policy per type:** which types set `allowsExternalSubject = true`, and the minimum
   identity fields. — before P7-8 factory work.
5. **Catalog admin surface & permission** (primary-admin vs admin) and **department-scope representation**
   (join table vs nullable `department_id`). — before P7-6A.
6. **`PATIENT_FINANCIAL_SUMMARY`** distinct type vs extending Invoice/Revenue; confirm patient-scoped only.
   — before P7-12.
