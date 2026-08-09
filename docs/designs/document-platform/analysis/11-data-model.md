# 11 · Data Model

## Objective

Propose the persistence layer for the document platform: the tables, their key columns,
authorization, storage, and the one branding migration. This is a **design proposal** — no
migrations are created by this task.

All **document** tables are **clinic-scoped** and **type-agnostic** (`doc_type` is data, not schema), so new
document types need no new document tables (correction #6). **Exception — clinical source records (§8).**
The clinical document types (prescription/lab/sick-leave) are not analytical reports over existing data;
their content is authored by a human and must persist as **durable, auditable source records** before any
document is issued. Those records are a separate, upstream data layer (P7-6A, doc 16 §4) — not part of the
type-agnostic document tables. The history/financial types (P7-12) remain schema-free — they resolve over
existing data and add **no** new tables.

---

## 1. Tables at a glance

| Table | Purpose | New? |
|-------|---------|------|
| `documents` | One row per **issued** document (immutable identity + snapshot + PDF pointer) | new |
| `document_events` | Append-only lifecycle events (doc 10) | new |
| `document_counters` | Atomic per-(clinic,type,period) sequence (doc 06) | new |
| `document_settings` | Per-clinic / per-type settings (doc 09) | new |
| `clinics` | +email, +website, +license/registration columns | **alter (existing)** |
| `activity_events` | Reused for security-relevant document actions | existing |

Storage: a new private bucket (e.g. `clinic-documents`) for canonical PDFs, following the
`patient-assets` bucket + signed-URL pattern already in `actions/patient-documents.ts`.

---

## 2. `documents`

```
documents (
  id                 uuid pk default gen_random_uuid(),
  clinic_id          uuid not null references clinics(id),
  doc_type           text not null,               -- catalog code
  document_number    text not null,               -- FULL visible number, immutable (doc 06)
  verification_token text not null,               -- opaque; QR payload (doc 07)
  status             text not null default 'issued', -- issued | void | cancelled
  locale             text not null,               -- 'ar' | 'en' (render language)
  -- subject references (nullable; exactly which are set depends on doc_type)
  patient_id         uuid null,
  staff_id           uuid null,
  doctor_id          uuid null,
  appointment_id     uuid null,
  invoice_id         uuid null,
  -- immutability payload
  params             jsonb not null,              -- the inputs (period, filters, subject id)
  snapshot           jsonb not null,              -- fully-resolved data at issue time (doc 05 §4)
  watermark_snapshot text null,                   -- effective watermark text at issue
  pdf_storage_path   text null,                   -- canonical PDF in the documents bucket
  page_count         int null,
  print_count        int not null default 0,
  regenerated_from   uuid null references documents(id), -- successor link (doc 10)
  issued_by          uuid not null references profiles(id),
  issued_at          timestamptz not null default now(),
  voided_by          uuid null references profiles(id),
  voided_at          timestamptz null,
  unique (clinic_id, doc_type, document_number),  -- collision backstop (doc 06 §3/§5)
  unique (verification_token)
)
```

Notes:
- `snapshot` is what makes reprint faithful and regenerate distinct (doc 05).
- Subject-reference columns power the module's per-type filters (doc 08 §3) and RLS subject-scope.
- No `preview` rows are ever written — previews are transient (doc 05 §1).

---

## 3. `document_counters` and `document_settings`

See doc 06 §3 (`document_counters`) and doc 09 §2 (`document_settings`) for their shapes. Both
are keyed to allow a clinic-wide default plus per-type specialization, and both are advanced/read
only through server-side actions/RPCs.

---

## 4. Authorization (RLS)

Following the codebase's clinic-scoped RLS + `activity_events` precedents:

- **`documents`**: `select` scoped to `clinic_id = caller's clinic` **and** the caller's role +
  subject scope (a doctor/assistant only sees documents for their authorized patients/doctors,
  mirroring the report/entity RLS already in place). `insert`/`update` only via the document
  server actions under `requireMutationRole` + the definer RPCs; clients cannot forge numbers,
  tokens, actors, or timestamps.
- **`document_events`**: append-only; no client `update`/`delete`; read scope mirrors `documents`.
- **`document_counters`**: no direct client access; advanced only by `allocate_document_number`
  (SECURITY DEFINER).
- **Public verification**: a separate minimal read path (definer RPC / narrow public view)
  returns only the five safe fields by `verification_token` (doc 07 §3) — the anonymous role never
  touches `documents` directly.

---

## 5. Clinic branding migration (the one required alter)

The `clinics` table today has `name, phone, logo_url, address`. The document header/footer and
the designs require the full **P7C branding model** (`AI_AGENT_PLAN.md` §8 / P7C), not just a
contact line. The Arabic invoice design is titled **فاتورة ضريبية (Tax Invoice)** and shows an
insurance line, so tax/VAT identity is a hard requirement, not optional polish:

| Field | Status | Action |
|-------|--------|--------|
| name, phone, logo_url, address | ✅ exists | reuse |
| **email** | ❌ missing | add `email text null` |
| **website** | ❌ missing | add `website text null` (optional; omitted from header if unset) |
| **license / registration no.** | ❌ missing | add `license_no text null` (shown as "License #…") |
| **tax / VAT registration** | ❌ missing | add `tax_id text null` (a.k.a. VAT/TRN); **required to render a compliant "Tax Invoice"** — omitted only if the clinic is genuinely non-registered |
| **custom document footer** | ❌ missing | add `document_footer text null` (per-clinic footer line; falls back to the default system attribution) |
| **extensible metadata bag** | ❌ missing | add `branding_metadata jsonb not null default '{}'` (additive future branding fields — social links, secondary phone, etc. — with **no further schema change**) |

Notes:
- **RLS.** `tax_id` and `license_no` must not leak cross-tenant; add/confirm the branding columns on
  top of the §3.2 `fix_clinics_cross_tenant_policies` hardening (`AI_AGENT_PLAN.md` §8 / P7C). Treat
  that hardening as a prerequisite for these columns if it is not already in place.
- **Tax lines vs tax identity.** These columns cover the clinic's **tax identity** on the document.
  Whether the invoice also itemizes a computed VAT **line/amount** depends on the billing model and is
  a founder decision (doc 14 open question); at minimum the tax identity must be present so the "Tax
  Invoice" title is not misleading.
- **Graceful degradation.** Every field above is optional at render time except where a document
  type's design requires it; missing optional fields are omitted from the layout (doc 03 §6, the P7C
  "graceful optional-field degradation" rule).

These are edited in the existing Clinic Settings page; Documents Settings surfaces completeness
(doc 09 §1.5). This is the **only** schema change tied to existing tables; everything else is new,
additive tables.

---

## 6. Attachments (Patient/Staff File)

No new attachment storage is introduced. The Patient File / Staff File merge reads the **existing**
sources:
- Patients: `patient_documents` (national_id / insurance / other) in the `patient-assets` bucket,
  via `actions/patient-documents.ts` (signed URLs, MIME-limited to pdf/jpg/png/webp).
- Staff: the existing staff-file records/bucket.

At issue, selected attachments are fetched (signed URL / server read) and merged after the profile
page with `pdf-lib` into the single canonical PDF stored on the `documents` row. The merged PDF is
the artifact; source attachments are untouched.

---

## 7. Storage & retention

- Canonical PDFs live in a private `clinic-documents` bucket, pathed
  `documents/<clinic_id>/<doc_type>/<document_id>.pdf`, retrieved via short-TTL signed URLs (same
  pattern as patient documents).
- Snapshots (`jsonb`) live on the row. PDFs + snapshots + events are **retained after void/cancel**
  (§11) — retired, never deleted.

---

## 8. Clinical source records & authoring layer (NEW — P7-6A)

The clinical documents render from durable, doctor-attributed records, not from the document tables.
Authoritative design: **doc 16**. These are additive tables; they do not alter the document engine.

### 8.1 Clinician credentials — `clinics`-adjacent alter of `profiles` (existing table)

| Field | Action |
|-------|--------|
| `professional_license_no text null` | add — shown on clinical documents |
| `specialty text null` | add — per-doctor specialty (distinct from `department_id`) |
| `professional_title text null` | add (optional) |
| `signature_path text null` | add (optional) — signature/stamp asset in a private bucket |

Only clinic-level `license_no`/`tax_id` existed before (§5); per-doctor credentials are new. Edited in Staff
settings (self/admin); completeness surfaced in Documents Settings (doc 09).

### 8.2 Clinical records (new tables)

| Table | Purpose |
|-------|---------|
| `prescriptions` | Rx header: `created_by`, `responsible_doctor_id`, `patient_id?`/external-subject, `appointment_id?`, `status[draft|finalized|void]`, `valid_until?`, `notes`, `finalized_at?/finalized_by?` |
| `prescription_medications` | Rx line items: `drug_catalog_id?`, `drug_name`, dose/frequency/duration/route/quantity/instructions, `is_controlled_snapshot`, `sort_order` |
| `lab_requests` | Lab header: same identity/actor cols + `priority[routine|urgent|stat]`, `laboratory_name?`, `clinical_context`, `instructions` |
| `lab_request_tests` | Lab line items: `lab_test_catalog_id?`, `test_name`, `notes`, `sort_order` |
| `sick_leaves` | Sick-leave: same identity/actor cols + `appointment_id` (required), `leave_start_date`, `leave_end_date`, `recipient_organization?`, `recipient_reference?`, `restrictions?`, `return_date?` |

**Subject identity (all three headers).** Exactly one of: `patient_id` (registered patient) **or**
external-subject snapshot fields (`subject_full_name`, `subject_dob?`, `subject_national_id?`) when the
type's `allowsExternalSubject` capability is true (doc 08 §4, doc 16 §4.2).

**Preparer vs physician.** `created_by` (authenticated preparer) and `responsible_doctor_id` (physician of
record, mandatory) are permanent for auditability (doc 16 §3).

### 8.3 Clinic-managed reference catalogs (new tables)

| Table | Purpose |
|-------|---------|
| `drug_catalog` | `clinic_id`, `name`, `form?`, `strength?`, `is_controlled`, `is_active` |
| `drug_catalog_departments` | `(drug_catalog_id, department_id)` — empty ⇒ all departments |
| `lab_test_catalog` | `clinic_id`, `name`, `is_active` |
| `lab_test_catalog_departments` | `(lab_test_catalog_id, department_id)` — empty ⇒ all departments |

Optional (free text always allowed); drive autocomplete + the controlled-medicine block (doc 16 §4.4).

### 8.4 Medical-note ↔ appointment link (alter existing `medical_notes`)

`medical_notes` += `appointment_id uuid null references appointments(id)`. Existing patient-scoped notes are
unaffected (null link); the redesigned Patient File (P7-11) shows the note under its appointment.

### 8.5 RLS & tenant isolation

- Insert on the clinical tables allowed for the default authorized preparer roles (Admin/Manager/
  Receptionist/Doctor/Assistant-when-enabled); the row records `created_by = auth.uid()` and a validated
  `responsible_doctor_id`. Read scope mirrors `patients_select_role_scoped` (doc 16 §4.6; exact
  read-visibility matrix is a founder decision, doc 14).
- Catalogs readable clinic-wide, writable by admin.
- All document identity/number/token/PDF writes remain in the existing SECURITY DEFINER RPCs; the clinical
  layer never forges document identity. Extend `validate_document_tenant_references()` for the new subject
  FKs and `responsible_doctor_id`.

### 8.6 History/financial documents add no schema (P7-12)

`APPOINTMENT_HISTORY_REPORT`, `PACKAGE_HISTORY_REPORT`, `DEPOSIT_STATEMENT`, `PATIENT_FINANCIAL_SUMMARY`
resolve over existing data (appointments + inline billing + `outstanding_settlements` + `patient_deposits`
+ `patient_packages`). There is **no `invoices` table** and **no deposit ledger** — the resolvers reuse the
existing in-app billing computation; no new financial schema is introduced (doc 16 §8).
