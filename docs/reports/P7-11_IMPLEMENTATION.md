# P7-11 Patient File Redesign & Unified History — Implementation Report

**Status:** COMPLETE

**Branch:** `feat/p7-document-platform`

**Scope:** Patient File redesign only (SHARED_REQUIREMENTS §15, doc 16 §8). Unified appointment
history, packages/deposits sections + dedicated pages, integrated Documents section, contextual
clinical actions reusing the shared authoring forms, and decomposition of the 868-line monolith into
modular server components. **No P7-12 document generation, no P7-9 Settings, no P7-10 hardening, no new
document engine features / types / clinical-authoring foundation, no new business rules.**

**Date:** 2026-08-02

## Outcome

P7-11 turns the Patient File into the primary clinical workspace: a modern, timeline-style page that
**groups related information per appointment** instead of scattering it across parallel lists. Each
appointment is now one unified card combining details + status, follow-up, invoice/billing, the
appointment's medical note (via the P7-6A `medical_notes.appointment_id` link), and related clinical
documents (via `documents.appointment_id`). The main page shows the **latest 5** appointments with a
**"View full history"** button; the full history page adds date filtering (custom range + last week /
month / year). Packages and Deposits gained recent-summary sections plus **dedicated pages with
filters**, and the existing Documents section is integrated into the new navigation. Contextual **New
Prescription / Lab Request / Sick Leave** buttons open the shared `components/clinical/*` forms with the
patient preselected.

The redesign is a **thin UI over existing actions and queries**. It introduces **no new financial
schema** — "invoice/billing" is derived from the existing appointment payment columns +
`outstanding_settlements` + `patient_deposits`, and the in-app billing computation is factored into a
single shared owner (`lib/patients/file-data.ts`) rather than duplicated. All role-based visibility,
doctor financial restrictions, server-side authorization, and RLS behavior are preserved: scoped
clinical roles (doctor / assistant) never receive financial columns, settlements, deposits, or
financial documents, and the doctor department/assignment access gate is enforced on every new page.

**No migration was required.** No commit, push, branch switch, PR, or remote Supabase operation was
performed; all existing P7 working-tree changes were preserved.

## Implemented functionality

### Shared data layer — `lib/patients/file-data.ts` (single owner, no duplicated logic)

- `resolveHistoryRange` — pure resolution of the date filter: rolling `last_week` / `last_month` /
  `last_year` presets (computed from `now`), a `custom` range, and an unbounded `all` default;
  malformed dates are dropped.
- `computeBillingTotals` / `computeDepositState` — the exact billing/deposit computation the monolith
  used, extracted as pure, unit-tested functions (reused by the page and available to the future P7-12
  resolvers — no re-implementation).
- `assembleAppointmentHistory` — pure per-appointment grouping of follow-ups / notes / documents.
- `loadAppointmentHistory` — RLS-scoped orchestration: appointments (role-appropriate column set) joined
  to their follow-ups, appointment-linked medical notes, and related **issued** documents, plus
  settlements. **Financial joins + settlements are skipped entirely for scoped clinical roles, and
  related documents are filtered to clinical types for those roles so no financial document leaks.**
- `loadPatientDeposits` — derived balance + deposit transactions (no ledger table; derived per doc 16
  §8). Never called for scoped clinical roles.
- `PATIENT_HISTORY_DOCUMENT_TYPES` — the P7-12 print targets (`APPOINTMENT_HISTORY_REPORT`,
  `PACKAGE_HISTORY_REPORT`, `DEPOSIT_STATEMENT`, `PATIENT_FINANCIAL_SUMMARY`) documented as constants so
  the print entry points are wired without implementing P7-12 generation (see "Print wiring" below).

### Modular server components — `components/patients/file/*`

- `appointment-history-card.tsx` (client) — one unified card. For non-scoped roles it **reuses the
  existing `AppointmentPaymentRow`** for the details + status + billing (collapsible invoice, settlements,
  send-invoice); for scoped roles it renders a lightweight header with no financial data. Below, it adds
  the appointment's follow-ups, medical note, and related-document links (to `/documents/[id]`).
- `appointment-history-section.tsx` (server) — the unified section: header, count, contextual clinical
  actions slot, "View full history" link, and the mapped cards. Synchronous (parent passes the translator)
  so the page tree fully resolves.
- `patient-deposits-section.tsx` (server) — balance + recent transactions + "View all deposits" link.
- `patient-file-clinical-actions.tsx` (client) — the contextual New Prescription / Lab Request / Sick
  Leave buttons; a **thin caller** that mounts the shared `components/clinical/*` forms with the patient
  preselected and, on a saved draft, hands the record id to the existing clinical preview surface.
- `history-date-filter.tsx` (client) — URL-driven preset chips + custom range for the history / packages
  / deposits pages.

The 868-line monolith (`app/(protected)/patients/[id]/page.tsx`) is recomposed as a slim orchestrator
that loads the shared context once and composes these sections + the existing profile card, billing
strip, packages section, documents section, medical-notes composer/list, and activity timeline.

### Routes

| Route | Purpose |
|-------|---------|
| `/patients/[id]` | Redesigned Patient File — unified history (latest 5) + sections |
| `/patients/[id]/history` | Full appointment history — presets + custom range, print |
| `/patients/[id]/packages` | All packages — status + date filters, print |
| `/patients/[id]/deposits` | Deposit balance + transactions — date filter, print (non-scoped only) |

### Contextual clinical actions (reuse, no duplicated business logic)

The three buttons mount the shared `PrescriptionForm` / `LabRequestForm` / `SickLeaveForm`
(`components/clinical/*`) — the **sole owner** of validation (`lib/validations/clinical.ts`),
persistence, RLS, finalization, and audit (`actions/clinical/*`, doc 16 §5). The Patient File is a thin,
context-aware caller: the patient is preselected and the patient's encounters are supplied for optional
linking; `allowsExternalSubject` is `false` (a registered patient). Authoring reference data is loaded by
the **existing** `listClinicalAuthoringOptions` loader (best-effort — a failure never breaks the page),
and its appointments are filtered to the current patient. `responsible_doctor_id` + `created_by` are
recorded by the shared action exactly as before.

### Print wiring (P7-11 UI; P7-12 generation deferred)

Per doc 13 P7-11 ("ship UI first, wire print when P7-12 lands"), the history / packages / deposits pages
are print-styled (`PrintHeader` + the existing `PatientReportHeader` `PrintButton`, browser print) and
their future engine document types are captured as the `PATIENT_HISTORY_DOCUMENT_TYPES` constants
(`APPOINTMENT_HISTORY_REPORT`, `PACKAGE_HISTORY_REPORT`, `DEPOSIT_STATEMENT`,
`PATIENT_FINANCIAL_SUMMARY`). **No catalog entry, resolver, template, or reprint RPC was added** — that
is P7-12. The print action currently produces the print-styled on-screen report; P7-12 swaps in
engine issuance behind the same entry points.

## Preserved guarantees

- **Role-based visibility & doctor financial restrictions:** `isScopedClinical` (doctor/assistant) never
  receives financial columns, settlements, deposits, the billing strip, the deposits section/page, or
  financial documents; the deposits page `notFound()`s for those roles. Verified by the
  `loadAppointmentHistory` role tests (scoped select omits `total_amount`, never queries
  `outstanding_settlements`, and filters related documents to clinical types).
- **Server-side authorization & RLS:** every page calls `requireUser` and re-checks the doctor
  department/assignment access gate; all reads flow through the RLS user client; the clinical actions gate
  through the unchanged `actions/clinical/*` preparer-role + RLS. No new admin/service-role client was
  introduced for these surfaces (the pre-existing deleted/archived admin fallback on the main page is
  unchanged).
- **No duplicated business logic / no new schema:** billing/deposit computation lives once in
  `lib/patients/file-data.ts`; clinical authoring stays in the shared forms + `actions/clinical/*`;
  packages reuse `PatientPackagesSection`; documents reuse `PatientDocumentsSection`; deposits reuse
  `AddDepositDialog`. Document templates are untouched.

## Files changed for P7-11

### New

- `lib/patients/file-data.ts` — shared unified-history + billing/deposit computation + date presets + P7-12 print-target constants.
- `components/patients/file/appointment-history-card.tsx` — unified per-appointment card (client).
- `components/patients/file/appointment-history-section.tsx` — unified history section (server).
- `components/patients/file/patient-deposits-section.tsx` — deposits balance + transactions (server).
- `components/patients/file/patient-file-clinical-actions.tsx` — contextual clinical action buttons (client, thin caller).
- `components/patients/file/history-date-filter.tsx` — preset + custom date filter (client).
- `app/(protected)/patients/[id]/history/page.tsx` — full appointment-history page.
- `app/(protected)/patients/[id]/packages/page.tsx` — dedicated packages page + filters.
- `app/(protected)/patients/[id]/deposits/page.tsx` — dedicated deposits page + filter.
- `tests/unit/lib/p711-patient-file-data.test.ts` — pure helpers + `loadAppointmentHistory` role-scope/isolation tests.
- `tests/unit/components/p711-appointment-history-card.test.tsx` — unified card rendering (scoped vs non-scoped, extras, empty).
- `docs/reports/P7-11_IMPLEMENTATION.md`

### Modified

- `app/(protected)/patients/[id]/page.tsx` — recomposed the monolith over the new modular sections; unified appointment history (latest 5) + "View full history"; deposits summary; "View all packages" link; contextual clinical actions; corrected billing totals to compute over all completed appointments (see Deviations).
- `messages/en.json`, `messages/ar.json` — new `patients.*` keys (appointment history, presets, deposits, packages, clinical actions); removed 5 now-unused `protected.*` keys.

## Validation results

- `pnpm exec tsc --noEmit` — **passed** (exit 0).
- `pnpm lint` — **passed** (0 errors, 25 pre-existing warnings).
- `pnpm lint:i18n` — **passed** (404 files, 41 documented exceptions; no new exceptions).
- `pnpm lint:rtl` — **passed** (585 files, 10 documented exceptions).
- `node scripts/check-messages.mjs` — **passed** (3,751 matching leaf messages; no unused keys).
- `pnpm i18n:missing` — **passed** (valid AR/EN parity).
- `pnpm test` — **passed** (293 files, 2,146 tests; 19 new P7-11 assertions).
- `pnpm build` — **passed**; new routes generated: `/patients/[id]/history`, `/patients/[id]/packages`, `/patients/[id]/deposits`.

## Blockers and deviations

- **Blockers:** none.
- **Deviations:**
  1. **Billing totals correctness.** The pre-redesign page computed the billing strip totals from only the
     latest 3 appointments (a side effect of the shared 3-row query). The redesign computes
     `billed/collected/outstanding` over **all completed appointments** via a dedicated amount-only query +
     the extracted `computeBillingTotals` — a correctness fix with no new schema and no change to the
     account-balance derivation. Doctor/assistant roles still receive no billing data.
  2. **Print action.** Produces the print-styled on-screen report now (browser print), with the P7-12
     engine document types captured as constants at the wired entry points — engine generation is P7-12,
     which this phase does not implement. This is the doc 13 "ship UI first" reconciliation of the scope's
     "print via the engine" vs. "do not implement P7-12" constraints.
  3. The older `/patients/[id]/appointments-report` and `/followups-report` pages are left intact (no
     longer linked from the main page, which now links to the unified `/history`); removing them was out
     of scope.
- **Deferred to their phases:** P7-9 Settings, P7-10 Hardening, and P7-12 history/financial document
  types.

## Review handoff

Not performed (per instructions). A review should write `docs/reviews/P7-11_REVIEW.md` per the review-file
workflow. No commit was made.
