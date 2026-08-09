# P7-11 Review — Patient File Redesign & Unified History

**Reviewer:** Claude (independent review)
**Date:** 2026-08-02
**Branch:** `feat/p7-document-platform`
**Scope reviewed:** P7-11 — the SHARED_REQUIREMENTS §15 / doc 16 §8 Patient File redesign: unified
appointment-history section (latest 5 + full-history page), packages/deposits sections + dedicated
pages, integrated Documents section, contextual clinical actions reusing the shared
`components/clinical/*` forms, and decomposition of the 868-line monolith into modular sections over a
single shared data layer (`lib/patients/file-data.ts`). Print entry points wired for P7-12 without
implementing generation.

**Method:** Read the authoritative plan (`AI_AGENT_PLAN.md`), the roadmap (doc 13 P7-11/P7-12), doc 16
(§5 shared owner, §8 redesign, §9 P7-12 types), the P7-11 implementation report, and the APPROVED P7-8
review. Read every P7-11 file: `lib/patients/file-data.ts`, the five `components/patients/file/*`
components, the recomposed `app/(protected)/patients/[id]/page.tsx`, the three new pages
(`history`, `packages`, `deposits`), and both P7-11 test files. Diffed the recomposed page against the
committed monolith (`git show HEAD:…`) to confirm business-logic preservation. Re-read the reused
infrastructure: `AppointmentPaymentRow`, `PatientPackagesSection`, `PatientDocumentsSection`,
`AddDepositDialog`, `SettleOutstandingDialog`, `PatientReportHeader`/`PrintButton`,
`listClinicalAuthoringOptions`, the shared clinical forms, and `lib/page-permissions.ts`. Independently
ran `tsc --noEmit`, the P7-11 unit/component suites, navigation + middleware-gating suites,
`check-messages`, `i18n:missing`, and a scope-leak grep.

---

## Verdict summary

P7-11 is a faithful, thin UI over existing actions and queries. The 868-line monolith is decomposed into
per-section server components composed by a slim orchestrator, and the billing/deposit computation is
extracted **verbatim** into a single shared owner (`lib/patients/file-data.ts`) — no new financial
schema, no duplicated business logic. The unified appointment card correctly groups details + status,
follow-up, billing summary, the appointment-linked medical note, and related clinical documents. All
role-based visibility, doctor financial restrictions, server-side authorization, and RLS behavior are
preserved: scoped clinical roles (doctor/assistant) never receive financial columns, settlements,
deposits, the billing strip, the deposits page (`notFound()`), or financial documents; the doctor
department/assignment gate is re-checked on every new page. Clinical actions are thin callers of the
shared forms + `actions/clinical/*`. Print is browser-only, with the P7-12 engine document types
captured as constants — no catalog entry, resolver, or reprint RPC added. No P7-9/P7-10/P7-12 scope
leaked. Tests are meaningful and fail closed; independent validation is green.

**No blocking findings.** Five non-blocking observations (O1–O5), most preserving pre-existing behavior.

**Verdict: APPROVED.**

---

## Required verifications

### 1. Patient File redesign matches the approved architecture (doc 16 §8) — ✅ PASS

The page is now a timeline-style workspace grouping information per appointment. The right column
composes: unified appointment-history section (latest 5) + contextual clinical actions → billing strip →
deposits → packages → documents → medical notes → activity timeline
([page L526-674]). Routes match the design: `/patients/[id]` (redesigned file),
`/patients/[id]/history`, `/patients/[id]/packages`, `/patients/[id]/deposits`. All resolve to the
`patients` page slug ([page-permissions L215](../../lib/page-permissions.ts#L215)); navigation/middleware
suites pass.

### 2. The monolith is decomposed without changing business logic — ✅ PASS

Diffed against `HEAD:app/(protected)/patients/[id]/page.tsx` (−360/+212). The billing and deposit
computations moved into `computeBillingTotals` / `computeDepositState` are **byte-for-byte identical** to
the monolith's inline reducers (billed = Σ`total_amount`; collected = Σ(`paid`+`insurance`+`secondary`+
`deposit`); outstanding = Σ`outstanding_amount`; balance = `max(0, (deposited − spent).toFixed(2))`).
The admin deleted/archived-patient fallback, role flags, `doctorCanAccessPatient` gate, medical-note +
attachment loading, packages/documents/notes sections are preserved. The old parallel appointments/
follow-ups lists are replaced by the unified card — a presentation change, not a logic change.

### 3. The shared data layer is the single owner with no duplicated logic — ✅ PASS

`lib/patients/file-data.ts` owns date-preset resolution, billing/deposit computation, unified-history
assembly, and RLS-scoped orchestration. All four surfaces (main page, `/history`, `/deposits`, and the
future P7-12 resolvers) consume it — the page no longer re-implements any of it. Query helpers take an
already-authenticated client, so every read flows through the caller's RLS scope
([file-data L15-19,283-287](../../lib/patients/file-data.ts#L283)).

### 4. Unified appointment history combines all six facets — ✅ PASS

`loadAppointmentHistory` joins appointments → follow-ups (`follow_ups.appointment_id`), appointment-linked
medical notes (`medical_notes.appointment_id`, the doc 16 §4.5 link), and related **issued** documents
(`documents.appointment_id`, `issued_at IS NOT NULL`), plus settlements for non-scoped roles
([file-data L316-413](../../lib/patients/file-data.ts#L316-L413)). `AppointmentHistoryCard` renders
details + **status** (`StatusBadge`), follow-up, the appointment's **medical note**, and **related
documents**; **billing summary** is the reused `AppointmentPaymentRow` for non-scoped roles
([card L72-199](../../components/patients/file/appointment-history-card.tsx#L72-L199)). All six facets
present.

### 5. Latest five appointments are correct — ✅ PASS

The main page loads with `limit: HISTORY_PREVIEW_LIMIT` (5), `order("scheduled_at", desc)`, and
`count: "exact"` so the section header shows the true `totalCount` while rendering 5 cards
([page L56,229-234](<../../app/(protected)/patients/[id]/page.tsx#L229>); [file-data L298-307](../../lib/patients/file-data.ts#L298)).
`viewAllHref` links to the full-history page.

### 6. Full-history filtering (custom / last week / month / year) is correct — ✅ PASS

`resolveHistoryRange` computes rolling presets from `now` (−7d / −1mo / −1yr), honours a valid `custom`
range, drops malformed dates, and defaults to unbounded `all`
([file-data L85-125](../../lib/patients/file-data.ts#L85-L125)) — pinned by unit tests (exact boundary
dates from a fixed `NOW`). The history page threads `range.from/to` into `loadAppointmentHistory`, which
applies `gte`/`lte` on `scheduled_at`; the `HistoryDateFilter` chips are URL-driven so the server
re-renders the scoped set ([history page L65-74](<../../app/(protected)/patients/[id]/history/page.tsx#L65>)).

### 7. Packages section redesign is correct — ✅ PASS

The main page shows recent/current packages (reusing `PatientPackagesSection`) with a "View all packages"
link; the dedicated `/packages` page adds status chips (all/active/inactive) + the shared date filter,
filtering in-app by `is_active` and `created_at` ([packages page L120-152](<../../app/(protected)/patients/[id]/packages/page.tsx#L120>)).
Package data reuses the existing component and queries — no new package schema. Session usage stays
trigger-driven on `used_sessions` (untouched).

### 8. Deposits section redesign is correct — ✅ PASS

`PatientDepositsSection` shows the **derived** balance + recent transactions with a link to the dedicated
`/deposits` page; the dedicated page adds the date filter. `loadPatientDeposits` derives the balance from
**all** deposits/spend (unfiltered) while the in-range `transactions` are the statement lines only
([file-data L443-499](../../lib/patients/file-data.ts#L443-L499)) — no ledger table, balance derived
(doc 16 §8). The section/page are never rendered for scoped clinical roles.

### 9. Doctor financial restrictions remain enforced — ✅ PASS

`isScopedClinical` (doctor/assistant): `loadAppointmentHistory` selects `APPOINTMENT_SELECT_SCOPED`
(no `total_amount`/payment columns), never queries `outstanding_settlements`, and filters related
documents to clinical types ([file-data L291-292,378,391](../../lib/patients/file-data.ts#L291)). The
page skips the billing strip, deposits section, and all deposit/settlement loads for these roles
([page L286-309,540,586](<../../app/(protected)/patients/[id]/page.tsx#L286>)). The `/deposits` page
`notFound()`s for doctor/assistant ([deposits page L42](<../../app/(protected)/patients/[id]/deposits/page.tsx#L42>)).
Role-scope isolation is asserted by the `loadAppointmentHistory` unit tests (scoped select omits
`total_amount`; `outstanding_settlements` never queried; INVOICE filtered out, PRESCRIPTION retained).

### 10. All authorization remains server-side — ✅ PASS

Every page calls `requireUser` and re-checks the doctor department/assignment gate; the deposits page
adds the financial-role gate. Clinical authoring reference data is loaded by `listClinicalAuthoringOptions`
(`requireClinicalRead` + RLS user client) and best-effort try/catch so a failure never breaks the page
([page L316-323](<../../app/(protected)/patients/[id]/page.tsx#L316>)). No new admin/service-role client
was introduced for these surfaces (the pre-existing deleted/archived admin fallback for the patient row
is unchanged).

### 11. RLS is preserved — ✅ PASS

All reads flow through the RLS user client (`createClient()`); the shared query helpers take that client.
The clinical actions gate through the unchanged `actions/clinical/*`. No policy, trigger, RPC, or
migration was added by P7-11 (no `supabase/migrations/*p711*`), so the P7-6A RLS surface is untouched.

### 12. Clinical actions reuse the existing shared clinical forms/actions — ✅ PASS

`PatientFileClinicalActions` is a thin client caller that mounts `PrescriptionForm` / `LabRequestForm` /
`SickLeaveForm` with the patient preselected, `allowsExternalSubject={false}` (registered patient), and
the patient's appointments supplied for optional linking; on a saved draft it hands `recordId` to the
existing preview surface `/documents/clinical/<kind>`
([clinical-actions L51-139](../../components/patients/file/patient-file-clinical-actions.tsx#L51-L139)).
No validation/persistence/issuance lives here — the sole owner stays `actions/clinical/*` +
`lib/validations/clinical.ts` (doc 16 §5). The page filters authoring `appointments` to the current
patient before passing them down.

### 13. Documents integration is correct — ✅ PASS

The existing `PatientDocumentsSection` is kept and integrated (rendered for admin/receptionist on active
patients, unchanged gate). Related clinical documents in the unified card deep-link to the P7-8 detail
route `/documents/[id]` ([card L181-183](../../components/patients/file/appointment-history-card.tsx#L181)),
whose access is enforced server-side downstream (P7-8 `getClinicDocumentDetail`).

### 14. Print entry points wired for P7-12 without implementing generation — ✅ PASS

The history/packages/deposits pages are print-styled (`PrintHeader` + `PatientReportHeader`'s
`PrintButton`, which calls `window.print()`) — browser print only. The four P7-12 engine targets are
captured as the `PATIENT_HISTORY_DOCUMENT_TYPES` constants
([file-data L44-49](../../lib/patients/file-data.ts#L44-L49)); a scope grep confirms **no** catalog
entry, resolver, template, or reprint RPC references them. This is the doc 13 "ship UI first, wire print
when P7-12 lands" reconciliation.

### 15. Billing totals correct; no historical financial data lost — ✅ PASS (documented deviation)

The recomposed main page computes `billed/collected/outstanding` over **all** completed appointments via
a dedicated amount-only query + `computeBillingTotals`
([page L292-306](<../../app/(protected)/patients/[id]/page.tsx#L292>)). The monolith computed them from
only the latest **3** appointments (a side effect of the shared `.limit(3)` query) — so this is a
**correctness fix**, not a regression: the account-wide totals were previously under-reported. The
formula is identical; the account balance derivation (all deposits − all spend) is unchanged. No schema
added. Verified the deviation matches the implementation report §Deviations #1.

### 16. No P7-12, P7-9, or P7-10 scope leaked — ✅ PASS

Scope grep across all P7-11 files: the P7-12 codes appear only as documented constants/comments in
`file-data.ts` (never registered in `lib/documents/catalog.ts`); no resolver/reprint/`allocate_document`/
`document_settings` work; no Documents-Settings (P7-9) or hardening (P7-10) surfaces. The report defers
all three.

### 17. Tests are meaningful and fail closed — ✅ PASS

- `p711-patient-file-data.test.ts`: `resolveHistoryRange` (exact preset boundaries, custom, malformed-
  drop, all-fallback); `computeBillingTotals` (completed-only, all channels); `computeDepositState`
  (non-negative floor); clinical-type classification; `assembleAppointmentHistory` grouping; and
  `loadAppointmentHistory` **role-scope isolation** — the scoped path asserts no `total_amount` column,
  no `outstanding_settlements` query, INVOICE filtered out, and empty settlements. These are the security-
  relevant fail-closed assertions.
- `p711-appointment-history-card.test.tsx`: scoped card shows details/note/follow-up/docs but **no money**
  (`queryByText(/250/)` absent), non-scoped card surfaces the billing total via the reused row, and the
  empty-extras case renders cleanly.

---

## Findings

No blocking findings.

### O1 — Observation · "Recorded by" renders without a separator

In the follow-up sub-block, `{t("recordedBy")}{f.recorded_by_name}` places the label
(`"Recorded by"`) directly against the name with no space (JSX collapses the inter-expression newline),
so it reads "Recorded byReception"
([card L142-144](../../components/patients/file/appointment-history-card.tsx#L142-L144)). Cosmetic i18n
polish; non-blocking.

### O2 — Observation · Date-range filtering uses UTC boundaries, not clinic timezone

Presets are computed from the server `now` and the query bounds use `${from}T00:00:00.000Z` /
`${to}T23:59:59.999Z` (UTC) against a timestamptz `scheduled_at`
([file-data L300-301](../../lib/patients/file-data.ts#L300-L301)). For clinics far from UTC this can
include/exclude appointments within a few hours of a range edge. Both the preset math and the query use
UTC consistently, so it is internally coherent; acceptable for a coarse date filter. Non-blocking.

### O3 — Observation · New sub-pages lack the soft-deleted/archived admin fallback

The main page keeps the admin fallback (`createClinicScopedAdminClient`) that lets admin/receptionist open
a trashed/archived patient's file; the new `/history`, `/packages`, `/deposits` pages fetch the patient
via the RLS user client only, so those deep views `notFound()` for a soft-deleted/archived patient even
for admin. The main file (latest 5 + billing) still works, so no data is lost — only the deep views are
unreachable for the trashed-patient edge case. Non-blocking.

### O4 — Observation · Package prices remain visible to scoped clinical roles on the new page

`PatientPackagesSection` renders `price_per_session` / `total_price`
([patient-packages-section L204-205](../../components/patients/patient-packages-section.tsx#L204)) and is
rendered unconditionally for all roles — exactly as the committed monolith did (verified in the `HEAD`
diff). The new `/packages` page mirrors that, so this is **preserved** pre-existing behavior, not a P7-11
regression; the founder "doctor financial restrictions" (billing/revenue/deposits) remain gated. Flagged
only for awareness.

### O5 — Observation · Scoped-role related-document links depend on P7-8 `documents` access

The unified card surfaces clinical documents to scoped roles and links to `/documents/[id]`. Whether a
doctor/assistant can open that detail page is governed by the P7-8 `documents` `pageRoles`; if a role
lacks access the link resolves to a fail-closed 404. Correct/safe, but the link is shown regardless of
that downstream access. Non-blocking.

---

## Independent validation run

- `pnpm exec tsc --noEmit` — **clean** (exit 0).
- `pnpm vitest run` on `p711-patient-file-data` + `p711-appointment-history-card` — **13 passed / 2 files**.
- `pnpm vitest run` on `dashboard-navigation` + `p1b-middleware-gating` — **31 passed / 2 files**.
- `node scripts/check-messages.mjs` — **3,751 leaf messages; no unused keys.**
- `node scripts/check-messages.mjs missing` (`i18n:missing`) — **valid AR/EN parity**; all new
  `patients.*` keys present in both catalogs (spot-checked 25 keys).
- Scope-leak grep (P7-9/P7-10/P7-12 codes, resolver/reprint/catalog/settings) across all P7-11 files —
  no engine registration; only documented constants.
- Byte-diff of extracted billing/deposit logic against the committed monolith — identical.

No production code was modified during this review. No commit was made.

---

**Verdict: APPROVED.**
