# P7-8 Review — Documents Module / Central Document Factory

**Reviewer:** Claude (independent review)
**Date:** 2026-08-02
**Branch:** `feat/p7-document-platform`
**Scope reviewed:** P7-8 — the central hub over the already-built P7-0…P7-7 platform: the `/documents`
history list (filters, search, pagination, grouping, role-aware visibility), `/documents/new` create
hub, `/documents/new/clinical/[slug]` clinical-authoring dispatch, `/documents/[id]` detail page, the
`allowsExternalSubject` catalog capability (founder decision: `true` for `PRESCRIPTION`,
`LAB_REQUEST`, `SICK_LEAVE_CERTIFICATE`; `false` elsewhere), the `documents` page slug + nav, and the
reprint dispatch to existing per-archetype actions.

**Method:** Read the authoritative plan (`AI_AGENT_PLAN.md`), the roadmap (doc 13), doc 08 (Documents
Module), doc 16 (Clinical Authoring / Factory / Patient File), the P7-8 implementation report, and the
APPROVED P7-7 review. Read every P7-8 file: `actions/documents-module.ts`,
`actions/clinical/authoring.ts`, `lib/documents/module.ts`, the four `app/(protected)/documents/*`
pages, the four `components/documents/module/*` components, `lib/documents/catalog.ts` (external-subject
capability), `lib/page-permissions.ts`, and all three P7-8 test files. Re-read the reused infrastructure:
the frozen catalog, the clinical preview surface (`app/(protected)/documents/clinical/[document]/page.tsx`),
the shared clinical forms (`components/clinical/*`), the sole clinical owner (`actions/clinical/*`,
`lib/validations/clinical.ts`), the clinical DB foundations
(`supabase/migrations/20260802120000_p76a_clinical_authoring_foundations.sql`), and the middleware.
Independently ran `tsc --noEmit`, the P7-8 unit/integration/component suites, the dashboard-navigation
suite, and a scope-leak grep.

---

## Verdict summary

P7-8 is a faithful, catalog-driven hub that adds **no engine-core change, no new document type, and no
duplicated business logic**. Listing, detail, and reprint all read/dispatch through existing surfaces;
the clinical create flow is a thin caller of the shared `components/clinical/*` forms and the sole
`actions/clinical/*` owner. Authorization is enforced server-side (`requireUser` /
`requireClinicalRead` + catalog `pageRoles`), RLS on `documents` and the clinical tables is untouched,
inaccessible types fail closed without leaking existence, and no P7-9/10/11/12 scope leaked. Tests pass
and are meaningful.

**One required fix.** The founder decision to set `allowsExternalSubject = true` for
`SICK_LEAVE_CERTIFICATE` is **structurally undeliverable** as implemented: `sick_leaves.appointment_id`
is `NOT NULL` at the database layer *and* the tenant trigger requires the appointment's patient to equal
a **non-null** `patient_id` — while an external subject is precisely `patient_id = NULL`. The UI exposes
the "External subject" option for sick leave, but selecting it produces a guaranteed dead-end (schema
rejects the empty `appointment_id`; even if forced, the DB raises `CLINICAL_APPOINTMENT_PATIENT_MISMATCH`).
Prescription and Lab Request external-subject flows are correct (nullable `appointment_id`, form hides
the appointment field for external subjects). This is finding **F1** and drives the verdict.

Everything else verified as PASS. Five non-blocking observations (O1–O5).

**Verdict: APPROVED WITH REQUIRED FIXES.**

---

## Required verifications

### 1. Routes match the approved architecture (doc 08 §1, doc 16 §7) — ✅ PASS

`/documents` (history list), `/documents/new` (create hub), `/documents/new/clinical/[slug]` (clinical
dispatch — the doc 16 §7 scope expansion), and `/documents/[id]` (detail + timeline) all exist and match
doc 08 §1. `build` in the report confirms the four routes generate. Middleware protects `/documents`
([middleware L21](../../lib/supabase/middleware.ts#L21)); the `documents` page slug gates all of them via
`getPageSlugFromPath` ([page-permissions L199-224](../../lib/page-permissions.ts#L199-L224)), with the
roster-profile deep-links deliberately kept on their `patients`/`settings` source slugs (ordered before
the generic `/documents` prefix — correct).

### 2. Listing, filters, pagination, grouping, role-aware visibility, search, detail timeline — ✅ PASS

- **Data:** `listClinicDocuments` reads `documents` through the RLS user client, constrained to
  `clinic_id`, `issued_at IS NOT NULL`, and `doc_type IN (accessible types)`
  ([documents-module L227-249](../../actions/documents-module.ts#L227-L249)). A type the role may not
  access short-circuits to an empty, non-leaking result **before** any query
  ([L212-218](../../actions/documents-module.ts#L212-L218)) — asserted by the integration test.
- **Filters (URL-driven via `nuqs`):** type, status, patient, creator, date range, and document-number
  `ilike` search, each resetting `page`. Catalog-driven relevance via `documentFilterKeysFor`.
- **Pagination:** server-side `range(from,to)` with `count: "exact"`, a "Showing X–Y of N" footer, and
  Latin-digit date/number rendering.
- **Grouping:** rows grouped by type in the fixed archetype order (financial → clinical → analytical →
  roster → profile) via `groupDocumentTypesByArchetype`.
- **Names:** resolved in one batched lookup per page (patients + profiles + appointment→patient), never
  per-row and never by parsing a snapshot; names never widen access (rows already passed `documents` RLS)
  ([resolveRowLabels L122-174](../../actions/documents-module.ts#L122-L174)).
- **Timeline:** the detail page lists `document_events` with resolved actor names + a system fallback.

### 3. All 16 implemented document types are integrated — ✅ PASS

`REGISTERED_DOCUMENT_TYPE_CODES` derives from `DOCUMENT_CATALOG` (16 entries); the helper test asserts
`toHaveLength(16)` and that every code maps to a rendering surface and a create href. Archetype grouping
round-trips the full set. No type is hardcoded outside the catalog.

### 4. Preview / issuance / PDF / QR / verification / history / download / reprint reused, not duplicated — ✅ PASS

The module issues nothing and re-renders no template. "View document" deep-links to the archetype's
existing issued-document surface via `renderedDocumentHref`; Download/Reprint dispatches to the existing
per-archetype canonical reprint actions (`reprintRevenueReportDocument`, `reprintInvoiceDocument`,
`reprintAnalyticalReportDocument`, `reprintRosterProfileDocument`, `reprintClinicalDocument`) through
`reprintClinicDocumentFromModule` ([L422-466](../../actions/documents-module.ts#L422-L466)); verification
opens the unchanged public `/verify/[token]`; history reads `document_events`. The out-of-scope guard
runs (via the access-checked `getClinicDocumentDetail`) **before** any reprint action is reached
([L431-435](../../actions/documents-module.ts#L431-L435)).

### 5. Clinical types dispatch to the shared forms and actions — ✅ PASS

`createDocumentHref` routes the three clinical codes to `/documents/new/clinical/<slug>`
([module L129-141](../../lib/documents/module.ts#L129-L141)). The dispatch page gates on
`requireClinicalRead` + `catalog.pageRoles` and mounts `ClinicalAuthoringLauncher`, a thin client caller
that renders the shared `PrescriptionForm`/`LabRequestForm`/`SickLeaveForm` and, on a saved draft, hands
the `recordId` to the existing preview surface `/documents/clinical/<slug>?recordId=…`
([launcher L37-75](../../components/documents/module/clinical-authoring-launcher.tsx#L37-L75)). No
validation/persistence/issuance lives in the launcher; `listClinicalAuthoringOptions` supplies
RLS-scoped doctors/patients/appointments/catalogs.

### 6. External-subject support enabled only for Prescription, Lab Request, Sick Leave — ✅ PASS (catalog) / ⚠️ see F1 (sick-leave usability)

`allowsExternalSubject` is `true` for exactly `PRESCRIPTION`, `LAB_REQUEST`, `SICK_LEAVE_CERTIFICATE`
and absent/`false` for the other 13 ([catalog L257,271,285](../../lib/documents/catalog.ts#L257)) — the
helper test enumerates all 16 and pins this. The dispatch page threads
`catalog.allowsExternalSubject ?? false` into the launcher, which threads it to each form; every
non-clinical type never receives the capability. The flag is set correctly per the founder decision — but
for sick leave the capability cannot be exercised (F1).

### 7. External-subject identity is durable, audited, tenant-safe, never browser-only content — ✅ PASS

The external identity path (`subject_full_name` / `subject_dob` / `subject_national_id`, `patient_id`
NULL) is persisted to the durable, audited clinical tables via `actions/clinical/*`, never held as
browser-only document content — the engine snapshots from the persisted record (doc 16 §2). Tenant safety
is enforced in depth: the `exactly-one-of` rule in `clinicalSubjectSchema`
([validations/clinical L13-37](../../lib/validations/clinical.ts#L13-L37)); a DB `CHECK`
(`patient_id XOR subject_full_name`) on all three tables
([migration L90-91,144-145,194-195](../../supabase/migrations/20260802120000_p76a_clinical_authoring_foundations.sql#L90));
a `subject_dob <= current_date` check; and the `validate_document_tenant_references` trigger validating
`patient_id`, `appointment_id`, and `responsible_doctor_id` are all same-clinic
([migration L294-311](../../supabase/migrations/20260802120000_p76a_clinical_authoring_foundations.sql#L294)).
Writes go only through server actions recording `created_by = auth.uid()`.

### 8. Registered-patient behavior unchanged — ✅ PASS

The registered-patient path is untouched by P7-8 (P7-8 only threaded the existing `allowsExternalSubject`
prop into `SickLeaveForm` and set catalog flags). With a `patient_id`, the subject fields render the
patient/appointment selectors exactly as before; validation and persistence are the pre-existing P7-6A
behavior.

### 9. Sick Leave requiring `appointment_id` for an external subject — REQUIRED FIX (see F1)

**Assessment of the three options posed:** it is **not** "correct and intentional," and **not** merely a
"non-blocking limitation" — it is a **required fix** because the UI advertises and reaches a capability
that is guaranteed to fail. Detail in **F1** below.

### 10. Authorization enforced server-side; RLS intact — ✅ PASS

Every action calls `requireUser` / `requireClinicalRead` (which resolves to `requireRole` over the
preparer set) before any read. `getAccessibleDocumentTypeCodes(user.role)` re-filters by catalog
`pageRoles` on top of RLS. The clinical dispatch page independently re-checks `catalog.pageRoles`. No new
`admin`/service-role client is used in the module (all reads via the RLS `createClient()`).

### 11. Inaccessible types and cross-tenant records fail closed without leaking existence — ✅ PASS

- List: an out-of-scope `type` returns empty without querying (integration test).
- Detail: `getClinicDocumentDetail` is `clinic_id`-scoped, then re-checks role accessibility and returns
  `documentNotFound` (→ `notFound()`) for a type the role cannot see "even if an RLS subject-scope let
  the row through" ([L355-359](../../actions/documents-module.ts#L355-L359)). A cross-tenant id
  `maybeSingle()`s to null → `documentNotFound`. Both collapse to a generic 404 — no existence leak.
- Reprint: resolves through the access-checked detail first, so an out-of-scope id never reaches an
  archetype reprint action.

### 12. No P7-9/10/11/12 scope leaked — ✅ PASS

Grep across the P7-8 files finds no `APPOINTMENT_HISTORY_REPORT` / `PACKAGE_HISTORY_REPORT` /
`DEPOSIT_STATEMENT` / `PATIENT_FINANCIAL_SUMMARY` / `regenerate`, no Patient-File redesign, and no
Documents-Settings work. The report explicitly defers P7-9…P7-12.

### 13. Tests are meaningful and fail closed — ✅ PASS (see O5)

- **Helpers** (`p78-document-module.test.ts`): 16-type registration, role accessibility mirrors
  `pageRoles`, archetype grouping order, rendered/create href routing, filter-key derivation, and the
  external-subject three-clinical-types decision enumerated over all 16 types.
- **List action** (`p78-document-module-actions.test.ts`): out-of-scope type ⇒ empty **without querying**,
  clinic-scope + issued-only + accessible-type filter shaping, single-type narrowing, row normalization.
- **Table** (`p78-documents-table.test.tsx`): rendering/grouping.
- All negative paths return `errorCode`/`notFound` rather than throwing or leaking.

---

## Findings

### F1 — Required fix · External-subject Sick Leave is structurally undeliverable

The founder decision sets `SICK_LEAVE_CERTIFICATE.allowsExternalSubject = true`, and P7-8 threads that
flag into `SickLeaveForm` → `ClinicalSubjectFields`, so the UI shows a "Registered patient / External
subject" switch for sick leave. But an external-subject sick leave can never be saved:

1. **Schema.** `sickLeaveDraftSchema` overrides the header to `appointment_id: uuid` (mandatory)
   ([validations/clinical L107-110](../../lib/validations/clinical.ts#L107-L110)).
2. **Form.** `ClinicalSubjectFields` renders the appointment selector only `!isExternal`
   ([clinical-subject-fields L95](../../components/clinical/clinical-subject-fields.tsx#L95)); switching
   to "external" sets `appointment_id: null` ([L63](../../components/clinical/clinical-subject-fields.tsx#L63)).
   So an external sick leave submits `appointment_id = ""`, the schema rejects it, and the user gets a
   generic `validationError` toast **with no visible field to fix** — a dead end.
3. **Database (dispositive).** `sick_leaves.appointment_id` is `NOT NULL`
   ([migration L180](../../supabase/migrations/20260802120000_p76a_clinical_authoring_foundations.sql#L180)),
   and the tenant trigger requires, whenever `appointment_id` is set, that
   `patient_id` be non-null and equal the appointment's patient — otherwise
   `CLINICAL_APPOINTMENT_PATIENT_MISMATCH`
   ([migration L301-311](../../supabase/migrations/20260802120000_p76a_clinical_authoring_foundations.sql#L301-L311)).
   Appointments belong to registered patients, so an external subject (`patient_id NULL`) can never
   satisfy the mandatory appointment link.

This is consistent with doc 16 §4.3 ("`appointment_id` … required; **exceptions via legal profile**") and
open decision #3 (sick-leave legal profile) — which is **not yet implemented**. The correct reading is
that external-subject sick leave depends on that unbuilt legal-profile exception. Enabling the catalog
flag ahead of it exposes a broken user-facing path.

**Required fix (choose one):**
- (a) Set `SICK_LEAVE_CERTIFICATE.allowsExternalSubject = false` until the legal-profile exception
  (open decision #3) makes `appointment_id` optional for external subjects — keeping the catalog honest;
  **or**
- (b) Deliver the external path end-to-end: relax the `NOT NULL` + trigger to permit
  `patient_id NULL ∧ appointment_id NULL` for sick leave, make the schema conditionally optional, and
  surface a "no appointment" affordance for external subjects (as prescription/lab already do).

Prescription and Lab Request are unaffected — their `appointment_id` is nullable and their external path
works — so this is isolated to sick leave.

### O2 — Observation · Filter bar under-exposes the "creator (issued by)" and "employee/doctor" filters

Doc 08 §3 lists **creator (issued by)** as always-applicable and **employee/doctor** as a distinct
subject filter. In the bar, the single staff `Select` is bound to `creatorId` (issued_by) but is only
rendered when `showEmployee` (`employee`/`doctor` in the schema) is true
([filter-bar L67,188-210](../../components/documents/module/documents-filter-bar.tsx#L67)). So: (a) with
no type selected, `documentFilterKeysFor(null)` includes `creator` but not `employee`/`doctor`, so the
creator filter is hidden despite doc 08 marking it always-on; and (b) the subject employee/doctor filter
(`listClinicDocuments` supports it via the `doctor_id/staff_id` OR-clause and the unused `employeeId`
input) is never surfaced. The list action is correct; only the UI wiring is incomplete. Non-blocking.

### O3 — Observation · `employeeId` list input is dead from the page

`listInputSchema` accepts `employeeId` and applies a `doctor_id.eq/staff_id.eq` OR-filter
([documents-module L239-241](../../actions/documents-module.ts#L239-L241)), but `app/(protected)/documents/page.tsx`
`SearchParams`/`toInput` never read or pass it, and the filter bar never sets it (O2). It is reachable
only by a direct action caller. Harmless, but either wire it (O2) or drop it. Non-blocking.

### O4 — Observation · Detail requires a truthy `page_count`

`getClinicDocumentDetail` treats a missing/zero `page_count` as `documentNotFound`
([documents-module L346-353](../../actions/documents-module.ts#L346-L353)). This is fine for the
current engine (every issued document stores `page_count`), but it couples the detail page's existence to
a rendering-metadata column; a future type that issues without a page count would 404 in the hub rather
than show metadata. Cosmetic/defensive note only.

### O5 — Observation · Two list-action assertions are structural

The integration test's "no query on out-of-scope type" and filter-shaping cases assert the recorded
filter tuples rather than a live result set. The behavioral coverage (row normalization, subject
derivation, single-type narrowing) exercises the real path, so this is redundancy, not a gap —
consistent with the P7-7 O4 note.

---

## Independent validation run

- `pnpm exec tsc --noEmit` — **clean** (exit 0).
- `pnpm vitest run` on `p78-document-module` (helpers), `p78-document-module-actions` (list authz),
  `p78-documents-table` (UI), and `dashboard-navigation` (slug/nav) — **32 passed / 4 files**.
- Scope-leak grep (P7-9…P7-12 codes + `regenerate`) across the P7-8 files — **no matches**.
- DB-level confirmation of F1 by reading the P7-6A migration constraints and tenant trigger.

No production code was modified during this review. No commit was made.

---

## Re-review — F1 fix (focused, 2026-08-02)

Focused final re-review of **F1 only** (the sole required fix). Re-read the fix migration
(`20260802150000_p78_sick_leave_external_subject.sql`), `lib/validations/clinical.ts`,
`components/clinical/sick-leave-form.tsx`, `components/clinical/clinical-subject-fields.tsx`,
`actions/clinical/sick-leaves.ts`, `types/database.ts`, the P7-6A tenant trigger, and
`tests/unit/lib/p76a-clinical-validation.test.ts`. Ran the focused suites and `tsc`.

**F1 — RESOLVED (option (b), external path delivered end-to-end).**

- **Registered patients still require `appointment_id`** — enforced in depth: `sickLeaveDraftSchema`
  `superRefine` raises `validation.appointmentRequiredForPatient` when `patient_id` is set and
  `appointment_id` is null ([clinical L122-128](../../lib/validations/clinical.ts#L122-L128)); the new DB
  `CHECK (patient_id is null or appointment_id is not null)` mirrors it at the database
  ([migration L16-19](../../supabase/migrations/20260802150000_p78_sick_leave_external_subject.sql#L16-L19)).
  Test line 55 pins the rejection. ✅
- **External subjects may create Sick Leave without an appointment** — schema now inherits
  `appointment_id: optionalUuid` (the mandatory `uuid` override is gone); the DROP NOT NULL migration
  lets it persist; `createSickLeaveDraft` spreads `parsed.data` unchanged. Test line 67. ✅
- **External subjects with an appointment are rejected** — schema raises
  `validation.appointmentRequiresPatient` ([clinical L129-135](../../lib/validations/clinical.ts#L129-L135)),
  and the unchanged tenant trigger independently raises `CLINICAL_APPOINTMENT_PATIENT_MISMATCH`
  (patient_id null with a set appointment). Test lines 71-73. ✅
- **Exactly-one identity rule holds** — `clinicalSubjectSchema` / `validateSubject` untouched; the DB
  `sick_leaves_subject_check` (patient_id XOR subject_full_name) is unchanged (migration touches only
  `appointment_id`). Test line 69. ✅
- **RLS, tenant isolation, responsible-doctor validation, lifecycle locking, audit, server-side
  persistence — unchanged.** The migration alters only `sick_leaves.appointment_id` nullability plus one
  additive CHECK; no policy, no trigger, no RPC changed. The action still gates on
  `requireClinicalMutation`, stamps `clinic_id`/`created_by`/`status='draft'`, and updates only rows
  `.eq("status","draft")` (lifecycle lock). ✅
- **Tenant/reference trigger still fails closed** — `validate_document_tenant_references` is byte-for-byte
  unchanged; it skips the appointment block only when `appointment_id IS NULL` and otherwise still enforces
  same-clinic + `patient_id`⇄appointment match. ✅
- **Rendering/issuance with `appointmentId = null`** — the clinical resolver already types `appointmentId`
  as `.nullable()` ([sick-leaves L40](../../actions/clinical/sick-leaves.ts#L40)); no rendering path
  dereferences it unguarded. ✅
- **Prescription & Lab Request untouched** — both schemas retain `...clinicalHeaderFields` +
  `.superRefine(validateSubject)` with no appointment coupling; no diff. ✅
- **`types/database.ts`** — `sick_leaves.appointment_id` is `string | null` (Row) and `string | null`
  optional (Insert/Update), matching the relaxed column. ✅
- **No P7-9/10/11/12 scope leaked** — scope-leak grep across the four F1 files: no matches. ✅

**Re-review validation run:**
- `pnpm exec tsc --noEmit` — clean (exit 0).
- `pnpm vitest run p76a-clinical-validation p76-clinical-document-contract p78-document-module` —
  **25 passed / 4 files**.
- Scope-leak grep on the F1 files — no matches.

O2–O5 remain open as previously classified (non-blocking). No production code was modified during this
re-review. No commit was made.

**F1 is fully resolved; the required fix is delivered and verified.**

---

**Verdict: APPROVED.**
