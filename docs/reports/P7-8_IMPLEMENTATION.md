# P7-8 Documents Module / Central Document Factory — Implementation Report

**Status:** COMPLETE

**Branch:** `feat/p7-document-platform`

**Scope:** The central hub / document factory only — `/documents` history list + filters,
`/documents/new` create hub (including clinical-authoring dispatch), and `/documents/[id]` detail.
No new document engine or clinical-authoring foundation functionality.

**Date:** 2026-08-02

## Outcome

P7-8 delivers the Central Document Factory as the single hub over the already-built P7-0…P7-7
document platform. It adds **no engine-core change, no new document type, no new clinical-authoring
foundation, and no duplicated business logic**: every list, detail, preview, PDF, QR, verification,
history, and reprint capability is served by reusing the existing per-archetype resolvers, renderers,
issuance guard, reprint RPCs, and rendering surfaces. The module is catalog-driven — a document type
participates in the hub by its `DOCUMENT_CATALOG` entry alone.

All authorization stays server-side (`requireUser` + catalog `pageRoles` + the existing `documents`
page slug); RLS on `documents` and the clinical tables continues to enforce clinic and subject scope.
No migration was required. No commit, push, branch switch, PR, or remote Supabase operation was
performed; all existing P7 working-tree changes were preserved.

## Implemented functionality

### Routes

| Route | Purpose |
|-------|---------|
| `/documents` | Issued-document **history list** — filters, search, pagination, grouped by type, role-aware |
| `/documents/new` | Central create hub — pick a type (role-aware, grouped by archetype) |
| `/documents/new/clinical/[slug]` | Clinical-authoring dispatch (the doc 16 §7 scope expansion) |
| `/documents/[id]` | One issued document — metadata, actions, event timeline |

The contextual per-surface issuance built in P7-3…P7-7 is untouched; the module is the hub, not the
only door.

### History list (`/documents`)

- **Data:** a new `listClinicDocuments` server action (`actions/documents-module.ts`) reads the
  `documents` table through the RLS user client, constrained to the clinic, issued-only rows, and the
  **role-accessible document types** (`getAccessibleDocumentTypeCodes`). A type filter the caller may
  not access returns an empty, non-leaking result rather than widening visibility.
- **Filters (combinable, URL-driven via `nuqs`):** document type, status (issued/void/cancelled),
  patient, employee/creator, date range (issue date), and document-number search. The filter bar is
  **catalog-driven** — `documentFilterKeysFor` shows only the filters relevant to the selected type
  (patient/employee appear per the type's `filterSchema`), and the shared filters otherwise.
- **Table (`@tanstack/react-table`):** rows are **grouped by document type** in the fixed archetype
  order (financial → clinical → analytical → roster → profile), each group a labelled section.
  Columns: number, subject, issued by, issue date, status badge, and a View action linking to the
  detail page. Latin digits are enforced in the date/number rendering.
- **Pagination:** server-side range pagination with a "Showing X–Y of N" footer and prev/next driving
  the `page` URL param.
- **Subject / creator names** are resolved in one batched lookup per page (patients, profiles,
  appointment→patient), never per row and never by parsing snapshots; the names never widen access
  because the rows already passed the `documents` RLS.

### Create hub (`/documents/new`)

- Role-aware, grouped-by-archetype grid of the document types the user may issue. Report/analytical
  and roster types deep-link into their **existing** param+preview+issue surfaces
  (`createDocumentHref`); subject-bound types (patient/staff file, invoice) route to their contextual
  source surface where the subject is naturally selected; clinical types dispatch to the shared
  authoring flow.

### Clinical-authoring dispatch (`/documents/new/clinical/[slug]`) — doc 16 §7 scope expansion

- For `PRESCRIPTION`, `LAB_REQUEST`, and `SICK_LEAVE_CERTIFICATE`, the factory launches the **shared
  `components/clinical/*` authoring form** — the same form the Patient File will use — not a parameter
  form. The launcher is a **thin caller**: validation, persistence, RLS, finalization, and audit stay
  in the sole owner `actions/clinical/*` (doc 16 §5). On a saved draft it hands the record id straight
  to the existing clinical document preview surface (`/documents/clinical/[slug]?recordId=…`), which
  performs the actual issuance.
- **Administrative subject selection:** the shared `ClinicalSubjectFields` provides patient
  search/select over the clinic's patients (a new `listClinicalAuthoringOptions` loader supplies
  doctors, patients, encounters, and the drug/lab autocomplete catalogs, all RLS-scoped).
- **External-subject support (founder decision, doc 14 open decision #4 — confirmed):** the per-type
  `allowsExternalSubject` catalog capability is **`true` for the three clinical types**
  (`PRESCRIPTION`, `LAB_REQUEST`, `SICK_LEAVE_CERTIFICATE`) and **`false` for every other document
  type**. Activation reused the already-implemented capability only — the shared
  `ClinicalSubjectFields` external-identity path, the exactly-one-of (registered patient **or**
  external subject) validation in `lib/validations/clinical.ts`, and the durable, audited persistence
  of `subject_full_name`/`subject_dob`/`subject_national_id` (no `patient_id`) in `actions/clinical/*`.
  The registered-patient flow is unchanged. No schema and no business logic were added: the only
  wiring was threading the existing `allowsExternalSubject` prop into `SickLeaveForm` (the one clinical
  form that had not yet exposed it) and setting the three catalog flags.
- Preparer-role gating (Admin/Manager/Receptionist/Doctor/Assistant-when-enabled) mirrors the clinical
  actions' own write gate; the responsible physician and preparer are recorded by the shared action.

### Detail page (`/documents/[id]`)

- A new access-checked `getClinicDocumentDetail` action returns normalized metadata (number, type,
  status, subject, issued-by, issue date, print count, page count), the event timeline, the
  verification token, and the `renderedDocumentHref` to the type's existing rendering surface. It
  fails closed for a type the role cannot access even if an RLS subject-scope let a row through.
- Actions reuse existing infrastructure with **no duplicated logic**:
  - **View document** → the archetype's existing issued-document surface (full template + PDF + QR).
  - **Download PDF / Reprint** → `reprintClinicDocumentFromModule`, which **dispatches to the
    archetype's already-built canonical reprint action** (each an append-only RPC that re-serves the
    stored PDF, bumps `print_count`, records a `reprinted` event). The out-of-scope guard runs before
    any reprint action is reached.
  - **Open verification** → the public `/verify/[token]` page (unchanged disclosure boundary).
  - **Print** → browser print of the metadata view.
- A history timeline lists `document_events` with resolved actor names.

### Navigation & page visibility

- Added a `documents` page slug to the single page catalog (`lib/page-permissions.ts`), default-visible
  to all five authorized roles (each sees only the types its role allows and the rows RLS scopes to
  it), so the primary admin can show/hide the module per employee exactly like Reports. The sidebar
  gains a Documents entry (derived automatically from the catalog) with a `FileText` icon.
- `getPageSlugFromPath` maps the hub, create flow, detail page, and clinical-authoring surfaces to the
  `documents` slug, while the roster-profile contextual deep-links **keep their existing source-page
  slugs** (they are reached from Patients/Settings). `/documents` is already in the middleware
  protected prefixes.

## Reuse boundary (no duplicated business logic)

- **Issuance / snapshot / PDF / QR / numbering / idempotency** — unchanged; the module never issues,
  it lists and links.
- **Reprint** — dispatched to the existing per-archetype reprint actions/RPCs; the module owns none.
- **Clinical authoring** — the shared `components/clinical/*` forms + `actions/clinical/*` remain the
  sole owner; the factory is a thin caller.
- **Rendering surfaces** — the detail page links to the existing P7-3…P7-7 surfaces rather than
  re-rendering any template. No document template was redesigned.

## Migration

None. The list/detail/reprint dispatch all read existing tables and call existing RPCs. Database types
were not modified.

## Files changed for P7-8

### New

- `lib/documents/module.ts` — pure factory helpers (role accessibility, archetype grouping, rendered/
  create href maps, filter-key derivation, status constants).
- `lib/documents/module-labels.ts` — server-only, single source of the 16 document-type labels.
- `actions/documents-module.ts` — `listClinicDocuments`, `getDocumentFilterOptions`,
  `getClinicDocumentDetail`, `reprintClinicDocumentFromModule` (archetype dispatch).
- `actions/clinical/authoring.ts` — `listClinicalAuthoringOptions` (doctors/patients/encounters/
  catalogs for the shared authoring forms).
- `app/(protected)/documents/page.tsx` — the history-list page.
- `app/(protected)/documents/new/page.tsx` — the create hub.
- `app/(protected)/documents/new/clinical/[slug]/page.tsx` — the clinical-authoring dispatch page.
- `app/(protected)/documents/[id]/page.tsx` — the detail page.
- `components/documents/module/documents-filter-bar.tsx` — URL-driven (`nuqs`) filter bar.
- `components/documents/module/documents-table.tsx` — grouped-by-type TanStack table + pagination.
- `components/documents/module/clinical-authoring-launcher.tsx` — thin shared-form launcher.
- `components/documents/module/document-detail-actions.tsx` — view/download/verify/print actions.
- `tests/unit/lib/p78-document-module.test.ts` — helper unit tests.
- `tests/unit/components/p78-documents-table.test.tsx` — table UI tests.
- `tests/unit/integration/p78-document-module-actions.test.ts` — list-action authorization tests.
- `docs/reports/P7-8_IMPLEMENTATION.md`

### Modified

- `lib/documents/catalog.ts` — added the per-type `allowsExternalSubject` capability; set `true` for
  `PRESCRIPTION`, `LAB_REQUEST`, and `SICK_LEAVE_CERTIFICATE` (founder decision), `false` elsewhere.
- `components/clinical/sick-leave-form.tsx` — threaded the existing `allowsExternalSubject` prop into
  `ClinicalSubjectFields` so the flag surfaces the external-identity fields (activation-only wiring;
  the prescription and lab forms already exposed it).
- `components/documents/module/clinical-authoring-launcher.tsx` — pass the capability to `SickLeaveForm`.
- `lib/page-permissions.ts` — added the `documents` page slug + path mapping.
- `components/layout/sidebar.tsx` — Documents nav icon.
- `messages/en.json`, `messages/ar.json` — `documents.catalog.*` type labels, `documents.module.*`
  module copy, and `nav.tenant.documents`.
- `tests/unit/lib/dashboard-navigation.test.ts` — updated path-mapping expectations + new nav/slug
  assertions for the module.
- `tests/unit/lib/p78-document-module.test.ts` — external-subject assertion updated to the confirmed
  three-clinical-types decision.

## Validation results

- `pnpm typecheck` (`tsc --noEmit`): **passed**.
- `pnpm lint`: **passed** — 0 errors, 25 warnings (24 pre-existing + 1 React-Compiler
  "incompatible library" note on the read-only TanStack table, consistent with existing table usages).
- `pnpm lint:i18n` (hardcoded strings): **passed** — 396 files scanned, 41 documented exceptions.
- `pnpm lint:rtl` (logical properties): **passed** — 576 files scanned, 10 documented exceptions.
- `pnpm i18n:missing` (AR/EN parity): **passed** — 3,731 base leaf messages, valid locale parity.
- `check-messages` (unused): **passed** — no unreferenced keys.
- `pnpm test`: **passed** — 291 files, 2,132 tests (24 new P7-8 tests).
- `pnpm build`: **passed** — routes generated: `/documents`, `/documents/new`,
  `/documents/new/clinical/[slug]`, `/documents/[id]`.

## Blockers and deviations

- Blockers: none.
- Deviations: none. `allowsExternalSubject` is now `true` for the three clinical types per the founder
  decision (doc 14 open decision #4 confirmed) and `false` for every other type; the registered-patient
  flow is unchanged and no schema or business logic was added. The detail page reuses the existing rendering
  surfaces for the full visual document (via "View document") rather than re-rendering templates
  inline — this is the no-duplicated-logic choice, and preview/PDF/verification/history/reprint all
  flow through the unchanged engine. See "Review fix F1" below for the follow-up that made the
  sick-leave external-subject path actually deliverable. P7-9 Settings, P7-10 Hardening, P7-11 Patient File redesign, and
  P7-12 history/financial document types remain deferred to their assigned phases.

---

## Review fix F1 — External-subject Sick Leave delivered end-to-end

**Date:** 2026-08-02 · **Source:** `docs/reviews/P7-8_REVIEW.md` finding F1 (only F1; O2–O5 left as-is).

F1 offered two remedies; this implements **option (b)** (deliver the external path) because the founder
decision requires `SICK_LEAVE_CERTIFICATE.allowsExternalSubject = true` to stay `true`.

### Required behavior delivered
- Catalog flag `SICK_LEAVE_CERTIFICATE.allowsExternalSubject = true` unchanged.
- **Registered patient** (`patient_id` present) ⇒ `appointment_id` still required.
- **External subject** (`patient_id` null with a valid persisted external identity) ⇒ `appointment_id`
  may be null.
- Exactly-one-of identity (registered patient **xor** external subject) preserved.
- Preserved unchanged: clinic scoping, `created_by`, `responsible_doctor_id`, role authorization, tenant
  isolation, lifecycle locking, audit history, server-side persistence. Prescription and Lab Request
  behavior untouched. No browser-only clinical content.

### Changes
1. **Migration / schema constraint** —
   `supabase/migrations/20260802150000_p78_sick_leave_external_subject.sql` (new): drops `NOT NULL` on
   `sick_leaves.appointment_id` and adds `check (patient_id is null or appointment_id is not null)`.
2. **Tenant / reference trigger** — no change required. `validate_document_tenant_references` already
   skips the appointment block when `appointment_id` is null (external path now reaches it cleanly) and
   still raises `CLINICAL_APPOINTMENT_PATIENT_MISMATCH` for a mismatched appointment. The only blocker
   was the removed `NOT NULL`.
3. **Shared validation** (`lib/validations/clinical.ts`) — `sickLeaveDraftSchema` no longer forces
   `appointment_id: uuid`; it inherits `optionalUuid` and adds `superRefine` rules: registered patient
   without appointment ⇒ `validation.appointmentRequiredForPatient`; external subject with an appointment
   ⇒ `validation.appointmentRequiresPatient`. Prescription/lab schemas unchanged.
4. **Form wiring** (`components/clinical/sick-leave-form.tsx`) — `appointment_id` is kept as `null`
   (was coerced to `""`) so the external path submits a genuine null; `appointmentRequired` is retained
   and only affects the registered-patient branch. Server actions needed no change.
5. **Database types** (`types/database.ts`) — `sick_leaves.appointment_id` widened to `string | null`
   (Row) and optional `string | null` (Insert/Update).
6. **Focused regression tests** (`tests/unit/lib/p76a-clinical-validation.test.ts`) — registered-without-
   appointment rejected; external-without-appointment accepted; external missing identity rejected;
   external + appointment rejected.

### Validation run (F1)
- `pnpm exec tsc --noEmit` — clean.
- `pnpm vitest run p76a-clinical-validation p76-clinical-document-contract p78-document-module` —
  4 files / 25 tests passed.
- `node scripts/check-messages.mjs` — clean (3731 leaves, no unused keys).

No commit was made.
