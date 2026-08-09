# 02 · Document Catalog & Taxonomy

## Objective

Classify all **16** documents studied as one ecosystem, and give each a complete catalog
row. This is the authoritative list that the `DOCUMENT_CATALOG` registry (Layer 3) will
encode. Adding a document type = adding a row here + a template.

> Every document below shares the same chrome (header/body/footer + identity + QR +
> optional watermark). The **archetype** tells you which body primitives it reuses.

---

## 1. The five archetypes

Studying the designs together, the 16 documents collapse into **five body archetypes**.
This is the reuse map that keeps the primitive library small.

| Archetype | Body shape | Documents |
|-----------|-----------|-----------|
| **A · Analytical report** | KPI stat-card row + data table(s) + totals/grand-total + notes callout + optional chart bars | 01, 02, 08, 09, 10, 11, 12, 13 |
| **B · Roster / list report** | Section-grouped tables (per department), per-group count badges, signatures | 03, 14 |
| **C · Entity profile** | Identity hero card + field grid (+ schedule table for staff) + signatures | 04, 15 |
| **D · Clinical document** | Patient block + physician block + clinical body (Rx table / test checklist / certifying prose) + instructions callout + signature/stamp | 05, 06, 07 |
| **E · Financial transactional** | Bill-from / bill-to + status badge + totals cards + line-item table + payment breakdown + dual signatures | 16 |

Archetype A dominates (8 of 16), so the KPI row + data table + notes callout primitives pay
for themselves immediately.

---

## 2. Shared identity carried by **every** document

Per SHARED_REQUIREMENTS §3–§7 and confirmed in every design:

- **Header:** clinic logo, clinic name, clinic contact line (address / phone / license /
  email), document title, document number, issue date, optional issue time, period/date-range
  where relevant.
- **Footer:** system attribution ("ClinicFlow Medical Records System …"), page numbering
  (`Page 1 of N`), copyright, and often Terms / Privacy / Verify links.
- **Verification mark:** a QR block ("SCAN TO VERIFY").
- **Watermark:** optional, behind content (DRAFT for preview; clinic-name/custom when issued).
- **Signature zone(s):** one or more labelled signature lines; clinical/financial docs add a
  stamp/seal area.

Branding fields come **only** from Clinic Settings (SHARED_REQUIREMENTS §4). No document
hard-codes them.

---

## 3. Per-document catalog

Legend — **Subject:** the entity the document is about. **Trigger:** current intended
issuance surface. **Prefix:** proposed numbering prefix (per-clinic + per-type; see doc 06).
**Filters:** the *relevant* filters this type exposes in the Documents module (each type
shows only its own). **Discovery:** what its verification page may disclose is always the
safe set (status, number, type, issue date, clinic) — the "Verification" column notes any
type nuance.

### Archetype A — Analytical reports

| # | Code | Subject | Trigger | Prefix | Primary body primitives | Relevant filters |
|---|------|---------|---------|--------|------------------------|------------------|
| 01 | `REVENUE_REPORT` | Clinic revenue (period) | Revenue page | `REV` | StatCardRow, DataTable (transactions), TotalsSummary, breakdown chips, SignatureBlock | date range, doctor/dept, creator |
| 02 | `FOLLOW_UP_PAGE_REPORT` | Follow-ups (day/page) | Follow-ups page | `FU` | StatCardRow, DataTable (details), SignatureBlock | date/date range, doctor, creator |
| 08 | `CANCELLATION_REPORT` | Cancellations (period) | Reports page | `CR` | StatCardRow, DataTable (doctor perf), NotesCallout (reasons + audit trail), VerificationBlock | date range, doctor, creator |
| 09 | `NO_SHOW_REPORT` | No-shows (period) | Reports page | `NS` | StatCardRow, DataTable (doctor perf), NotesCallout (review/internal notes) | date range, doctor, creator |
| 10 | `SALES_REPORT` | Sales/collections (period) | Reports page | `SAL` | StatCardRow (grid), 2× DataTable (metrics, methods), NotesCallout | date range, creator |
| 11 | `FOLLOW_UP_ANALYTICS_REPORT` | Follow-up outcomes (period) | Reports page | `FUA` | StatCardRow, DataTable with share bars, NotesCallout, VerificationBlock | date range, doctor, creator |
| 12 | `DOCTOR_PERFORMANCE_REPORT` | Doctor performance (period) | Reports page | `DPF` | StatCardRow, wide DataTable, NotesCallout (departmental impact), SignatureBlock | date range, doctor, department, creator |
| 13 | `RECEPTIONIST_PERFORMANCE_REPORT` | Receptionist performance (period) | Reports page | `RPF` | StatCardRow, DataTable, SignatureBlock | date range, employee (receptionist), creator |

### Archetype B — Roster / list reports

| # | Code | Subject | Trigger | Prefix | Primary body primitives | Relevant filters |
|---|------|---------|---------|--------|------------------------|------------------|
| 03 | `PATIENT_LIST_REPORT` | Patients (grouped by dept) | Patients page | `PLR` | GroupedTables (per dept, count badge), SignatureBlock ×2, VerificationBlock | department, doctor, creator, search |
| 14 | `SYSTEM_MEMBERS_REPORT` | Staff roster (grouped by dept) | Settings / Staff list | `SMR` | GroupedTables (avatar + role + status), NotesCallout (closing remarks), VerificationBlock | department, role, creator |

### Archetype C — Entity profiles

| # | Code | Subject | Trigger | Prefix | Primary body primitives | Relevant filters |
|---|------|---------|---------|--------|------------------------|------------------|
| 04 | `PATIENT_FILE` | One patient | Patient profile | `PF` | IdentityHero, FieldGrid, SignatureBlock ×2, VerificationBlock. **+ optional attachments** | patient, creator, date |
| 15 | `STAFF_FILE` | One staff member | Staff profile | `STF` | IdentityHero (photo), FieldGrid, DataTable (weekly schedule), NotesCallout, SignatureBlock. **+ optional attachments** | employee, department, creator, date |

Documents 04 and 15 additionally support **optional inclusion of stored identity/personal
attachments** at print time (SHARED_REQUIREMENTS "Patient File & Staff File"). See doc 09 §5
and doc 11 §6.

### Archetype D — Clinical documents

| # | Code | Subject | Trigger | Prefix | Primary body primitives | Relevant filters |
|---|------|---------|---------|--------|------------------------|------------------|
| 05 | `PRESCRIPTION` | Patient visit | Visit workspace | `RX` | Patient block, Physician block, DataTable (Rx: medication/dosage/duration), NotesCallout (instructions), SignatureBlock | patient, doctor, date, date range |
| 06 | `SICK_LEAVE_CERTIFICATE` | Patient visit | Visit workspace | `SL` | Patient block, CertifyingProse, NotesCallout (diagnosis), VerificationBlock + seal + SignatureBlock | patient, doctor, date, date range |
| 07 | `LAB_REQUEST` | Patient visit | Visit workspace | `LAB` | Patient box, Physician box, ChecklistPanel (grouped tests), NotesCallout (instructions + clinical), VerificationBlock, SignatureBlock + stamp | patient, doctor, date, date range |

Clinical documents render from **durable, doctor-attributed, auditable clinical records** — the
prescription/lab/sick-leave authoring the redesigned visit workflow persists (SHARED_REQUIREMENTS §14).
That authoring is now scoped as **P7-6A — Clinical Authoring Foundations** (doc 16), which supplies the
records + clinician credentials + optional drug/lab catalogs. The platform provides render + issue + verify
from the record's snapshot; it never accepts clinical content from a browser payload or synthesizes it from
notes/appointments. Founder rendering rules (doc 16 §6): every clinical document snapshots the responsible
physician's credentials, always shows a signature/stamp area (a labelled blank when no stored asset exists),
and every prescription carries the mandatory bilingual validity note ("not valid unless signed/stamped by
the responsible physician").

### Archetype E — Financial transactional

| # | Code | Subject | Trigger | Prefix | Primary body primitives | Relevant filters |
|---|------|---------|---------|--------|------------------------|------------------|
| 16 | `INVOICE` | One appointment/billing | Patient profile, appointment billing, invoice history, WhatsApp/email delivery | `INV` | Bill-from/Bill-to blocks, StatusBadge, TotalsSummary cards, DataTable (line items), NotesCallout (billing notes), payment breakdown, VerificationBlock, SignatureBlock ×2 | patient, date, date range, status, creator |

### Patient history & financial documents (NEW — P7-12, doc 16 §9)

Patient-subject documents that print the redesigned Patient File's filtered history (doc 16 §8). Their
resolvers reuse the P7-11 unified queries and the existing billing computation — no new financial schema.

| # | Code | Subject | Trigger | Prefix | Archetype | Relevant filters |
|---|------|---------|---------|--------|-----------|------------------|
| 17 | `APPOINTMENT_HISTORY_REPORT` (**required**) | One patient's appointments | Patient File → full history page | `APH` | A (analytical) | patient, date range / last week·month·year, doctor (scoped) |
| 18 | `PACKAGE_HISTORY_REPORT` | One patient's packages | Patient File → packages page | `PKH` | A/B | patient, date range, status |
| 19 | `DEPOSIT_STATEMENT` | One patient's deposits | Patient File → deposits page | `DEP` | E (financial) | patient, date range |
| 20 | `PATIENT_FINANCIAL_SUMMARY` | One patient (deposits + charges + payments + outstanding + package balances) | Patient File → financial summary | `PFS` | E (financial) | patient, date range |

These are **additive slices** on the frozen engine (no core change). `PATIENT_FINANCIAL_SUMMARY` is a
distinct type (not an extension of Invoice/Revenue) and is patient-scoped only (doc 14 open question).

---

## 4. Catalog entry shape (Layer 3)

Each row above becomes one typed registry entry, e.g.:

```
type DocumentCatalogEntry = {
  code: DocumentTypeCode;                 // 'REVENUE_REPORT' | 'PRESCRIPTION' | ...
  archetype: 'analytical' | 'roster' | 'profile' | 'clinical' | 'financial';
  titleKey: string;                       // next-intl key (documents namespace)
  numberingPrefix: string;                // 'REV', 'RX', 'INV' ... (default; see doc 06/09)
  pageRoles: readonly UserRole[];         // data-authorization gate (mirrors surface guards)
  subject: 'clinic' | 'patient' | 'staff' | 'doctor' | 'appointment';
  filterSchema: DocumentFilterKey[];      // the relevant filters only
  resolver: DataResolverRef;              // reuses lib/reports/data.ts / RPCs where possible
  template: DocumentTemplateRef;          // Layer-2 component
  verificationDisclosure: VerificationField[]; // always the safe set (doc 07)
  supportsAttachments?: boolean;          // true for PATIENT_FILE, STAFF_FILE
  authoringForm?: ClinicalAuthoringRef;   // clinical types: the components/clinical/* form (doc 16 §5/§7)
  allowsExternalSubject?: boolean;        // default false; true → prepare for a non-registered subject (doc 16 §7)
  issuanceTrigger: { href: string; contextual: boolean };
};
```

For clinical types the `resolver` reads the persisted clinical record (Layer 1) rather than a report
resolver, and `authoringForm` names the shared structured form the module (P7-8) and Patient File (P7-11)
both launch. The `subject` union extends with `'external'` where `allowsExternalSubject` is set.

This mirrors the shape and intent of `ReportCatalogEntry` in `lib/reports/catalog.ts`, so
the team applies a familiar pattern and the two catalogs can share the report ids they
overlap on (documents 01, 02, 08–13 correspond to existing report ids).

---

## 5. Relationship to existing report pages

Eight analytical documents (01, 02, 08–13) are the **printable, issued** counterparts of
existing Reports pages (`app/(protected)/reports/*`) whose data already comes from
`lib/reports/data.ts` + RPCs under RLS. The document platform **reuses those resolvers** and
adds issue/number/verify/PDF around them — it does not re-query or re-authorize from scratch.
Note the catalog distinctions the intake README calls out: **10 Sales Report ≠ 01 Revenue
Report**, and **11 Follow-up Analytics ≠ 02 Follow-up Page Report** — four separate documents,
four catalog entries.

**Resolver-reuse is not uniform across the eight (verified against `REPORT_CATALOG`).** Six
analytical documents map 1:1 to an existing report id and reuse its resolver directly:

| Document | Existing `REPORT_CATALOG` id | Resolver |
|----------|------------------------------|----------|
| 01 Revenue Report | `revenue` | reuse |
| 02 Follow-up Page Report | `followups` | reuse |
| 08 Cancellation Report | `cancellations` | reuse |
| 09 No-show Report | `no_shows` | reuse |
| 12 Doctor Performance | `doctor_performance` | reuse |
| 13 Receptionist Performance | `receptionist_performance` | reuse |

The remaining two have **no existing resolver** — there is no `sales` id and no follow-up-analytics
id in `REPORT_CATALOG` today:

| Document | Existing resolver? | Status |
|----------|--------------------|--------|
| 10 Sales Report | ❌ none | **net-new data resolver / RPC** |
| 11 Follow-up Analytics Report | ❌ none | **net-new data resolver / RPC** |

So documents **10 and 11 are net-new data work** (a new RLS-scoped resolver, a data-honesty review,
and fixtures each), not thin template additions. The roadmap (doc 13, Phase **P7-4**) sizes them as
data pipelines, and doc 12 §2 lists them under net-new systems. This is the direct consequence of the
"Sales ≠ Revenue" / "Analytics ≠ Follow-up Page" distinction above.

---

## 6. This 16-document set is the committed Phase 7 scope (supersedes the P7A 8-document catalog)

The earlier **P7A requirements catalog** (`docs/documents/`) and `AI_AGENT_PLAN.md` §8 committed a
different, 8-document set (invoice, receipt, prescription, medical report, sick-leave, referral, lab
request, consent forms). **This 16-document design-intake set is now the authoritative, committed
Phase 7 document set and supersedes that 8-document list.** The two overlap on only four types
(invoice, prescription, sick-leave, lab request).

Disposition of the four P7A types not in this set:

| P7A type | Disposition in the committed 16-set |
|----------|-------------------------------------|
| Receipt | **Deferred** — not in the imported design set; may later fold into Invoice or ship as a future additive type. Not built in this Phase 7. |
| Medical report | **Deferred** — future clinical document (needs the §14 authoring forms); not in the imported set. |
| Referral | **Deferred** — future clinical document; not in the imported set. |
| Consent forms | **Deferred** — render-only lifecycle (P7A-M1); not in the imported set. Its distinct non-issued lifecycle is not modelled by this platform's issued-instance lifecycle (doc 05) and would need the P7A carve-out if revived. |

The 12 documents this set **adds** over P7A (revenue, follow-up page, patient list, patient file,
cancellation, no-show, sales, follow-up analytics, doctor performance, receptionist performance,
system members, staff file) are the analytical/roster/profile documents whose designs the founder
imported. `AI_AGENT_PLAN.md` §8 and `docs/documents/README.md` are updated to record this
supersession so there is a single authoritative catalog.
