# 08 · Documents Module

## Objective

Design the new Documents module inside ClinicFlow: where authorized users create, preview,
print, export, reprint, regenerate, and browse the history of documents — reusing existing
navigation, tables, filters, and authorization.

---

## 1. Routes

| Route | Purpose |
|-------|---------|
| `app/(protected)/documents/` | Documents home: issued-document **history list** + filters + "New document" |
| `app/(protected)/documents/new/` | Centralized create: pick a type → params → preview → issue |
| `app/(protected)/documents/[id]/` | One issued document: view, actions, its event history |
| `app/(public)/verify/[token]/` | Public verification page (doc 07) |

Contextual issuance also lives on the owning surfaces (Revenue page, patient profile, visit
workspace, billing, Reports pages, Staff settings) via catalog-driven deep links — the module is
the hub, not the only door.

---

## 2. Capabilities (per the requirement)

- **Create document** — choose type, fill its relevant params, preview.
- **Preview** — DRAFT-watermarked, no number consumed.
- **Print** — browser print of the issued view.
- **Export PDF** — download the stored canonical PDF.
- **Reprint** — re-serve the original stored PDF (same number).
- **Regenerate** — new numbered document from current data (policy pending, doc 14).
- **Document history** — the issued-document list, filterable.
- **Quick access to history** — from every originating surface, a link into the module filtered
  to that context (e.g. this patient's documents; this period's revenue documents).

---

## 3. The history list

Built on the components already in the codebase:

- **Table:** `@tanstack/react-table` (already a dependency; used across the app).
- **URL-driven filters:** `nuqs` (already used) so filter state is shareable/bookmarkable.
- **Columns:** document number, type, subject (patient/staff/doctor/clinic), issued by, issue
  date, status, print count, actions.
- **Row actions:** view · preview · print · export PDF · reprint · regenerate · void · open
  verification · view event history.

### Filters (combinable) and per-type relevance

The requirement lists: date, date range, patient, employee, doctor, creator, document number,
document type, search. **Each document type exposes only the filters relevant to it** — driven by
the catalog `filterSchema` (doc 02 §3):

| Filter | Applies to (examples) |
|--------|----------------------|
| Document type | always (the top-level switch) |
| Date / date range | all (issue date); period for analytical reports |
| Patient | 04 Patient File, 05/06/07 clinical, 16 Invoice, 03 patient list |
| Employee / doctor | 12/13 performance, 15 Staff File, clinical docs, revenue by doctor |
| Creator (issued by) | all |
| Document number | all (exact/prefix lookup) |
| Status | 16 Invoice, void/cancelled across types |
| Search | roster/list docs, patient/staff name |

When the user narrows to a single type, the filter bar shows only that type's relevant filters;
with no type selected, the shared filters (type, date, number, creator, search) are shown.

---

## 4. Create / issue flow (the "document factory")

```
/documents/new
  1. pick document type            (catalog: only types the user is authorized for)
  2a. report/history types:  fill the type's params  (catalog.filterSchema → typed form; react-hook-form + zod)
  2b. clinical types:        launch the shared structured authoring form (components/clinical/*)
                             → create/load a durable clinical record (doc 16 §5) BEFORE any issuance
  3. Preview                       (DRAFT watermark, PREVIEW number, no allocation)
  4. Issue                         (requireMutationRole → allocate number, snapshot, render+store PDF)
  5. Result                        (view / print / export / deliver)
```

**Scope expansion (doc 16 §7 — the central Document Factory).** For **clinical** types
(`PRESCRIPTION`, `LAB_REQUEST`, `SICK_LEAVE_CERTIFICATE`), step 2 is **not** a parameter form: it launches
the **same** `components/clinical/*` authoring form used by the Patient File, which persists a structured,
auditable clinical record (Layer 1) that the resolver then snapshots at issue (Layer 2). The engine never
accepts clinical content from a browser payload or synthesizes it from notes/appointments.

- **Subject selection.** The factory is the administrative workflow: authorized staff search/select any
  patient. A per-type **`allowsExternalSubject`** capability (default **false**) governs whether a document
  may be prepared for a **non-registered person** — captured via external-subject snapshot fields (no
  `patient_id`), fully audited (doc 16 §4.2, doc 14 open question).
- **Preparer vs physician.** Clinical authoring is open to any authorized staff role (Admin/Manager/
  Receptionist/Doctor/Assistant-when-enabled); each record permanently stores `created_by` (preparer) and a
  mandatory `responsible_doctor_id` (physician of record) — doc 16 §3.
- **No duplicated logic.** The Patient File (context-aware, patient/encounter preselected) and the factory
  (administrative) are **thin callers** of one owner, `actions/clinical/*`; validation, persistence, RLS,
  finalization, and audit live once (doc 16 §5).

Contextual issuance skips step 1–2 by arriving with params (or a preselected patient/encounter) pre-bound
from the surface (e.g. the Revenue page passes its current period/filters straight into the Revenue Report
preview; the Patient File passes the patient + current encounter into a clinical authoring form).

---

## 5. Patient File / Staff File — attachment selection

For `PATIENT_FILE` and `STAFF_FILE`, the issue flow adds an **attachment picker**: the user
chooses which stored personal documents to include (national ID, insurance, other for patients;
staff-file equivalents for staff). Selected items — already constrained to pdf/jpg/png/webp — are
merged after the profile page into one PDF (`pdf-lib`; doc 03 §9, doc 11 §6). Nothing is included
by default unless the user selects it. Attachment sources are the existing
`actions/patient-documents.ts` / `staff-files` records and the `patient-assets` bucket.

---

## 6. Authorization & visibility (reuse, not reinvention)

- **Data authorization:** each action calls `requireRole` / `requireMutationRole`
  (`lib/rbac.ts`) with the catalog entry's `pageRoles`, mirroring the guards on the owning
  surface. Document access never widens data access — a user who can't see clinic-wide revenue
  can't issue the Revenue Report.
- **Page visibility:** add a `documents` page slug to the existing page-permission model
  (`lib/page-permissions.ts`, `user_page_permissions`), so the primary admin can show/hide the
  module per employee exactly like Reports.
- **Per-type visibility (optional):** the report-visibility pattern
  (`actions/report-permissions.ts`, `user_report_permissions`) generalizes to per-document-type
  visibility if the founder wants finer control — same catalog-driven mechanism.
- RLS on the `documents` table enforces clinic scope and subject-scope at the data layer (doc 11).
- **Clinical authoring authorization (doc 16 §3).** Preparing a clinical record is open to the default
  authorized staff roles (Admin/Manager/Receptionist/Doctor/Assistant-when-enabled), not doctors only; the
  record records `created_by` + a mandatory `responsible_doctor_id`. Clinical **validity** is asserted by
  the responsible physician's signature/stamp on the issued document, not by an in-app doctor-only gate.
  The new clinical tables (`prescriptions`/`lab_requests`/`sick_leaves` + line items) carry their own
  clinic-scoped RLS mirroring `patients`/`medical_notes` (doc 16 §4).

---

## 7. Navigation

Add a **Documents** entry to the protected shell navigation (reusing the existing nav
config/`lib/navigation`), visible when the `documents` page is enabled for the user. History
quick-links from surfaces deep-link into `/documents?…filter…`.
