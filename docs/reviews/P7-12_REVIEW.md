# P7-12 Review — History & Financial Document Types

**Reviewer:** Claude (independent review)
**Date:** 2026-08-03
**Branch:** `feat/p7-document-platform`
**Scope reviewed:** P7-12 — the four approved patient history/financial document types (roadmap doc 13
P7-12, design doc 16 §9): `APPOINTMENT_HISTORY_REPORT` (required), `PACKAGE_HISTORY_REPORT`,
`DEPOSIT_STATEMENT`, `PATIENT_FINANCIAL_SUMMARY`, implemented as engine slices resolved entirely from the
shared P7-11 patient-file data layer.

**Method:** Read the authoritative plan (`AI_AGENT_PLAN.md`), the roadmap (doc 13 P7-11/P7-12), doc 16
(§8 redesign, §9 the four types), the P7-12 implementation report, and the APPROVED P7-11 review. Read
every P7-12 file: the resolver (`lib/documents/resolvers/patient-history.ts`), copy
(`lib/documents/patient-history-copy.ts`), template
(`components/documents/templates/patient-history-documents.tsx`), renderer
(`lib/documents/renderers/patient-history.tsx`), the client actions component, the preview/issued page,
the reprint migration, `catalog.ts`, `module.ts`, `module-labels.ts`, the P7-12 actions in
`actions/documents.ts`, and the two new + three updated test files. Re-read the reused P7-11 data layer
(`lib/patients/file-data.ts`) and the reused engine infrastructure: `issueDocumentFoundation`, the
`reserve_document_issue` RPC + `ReserveDocumentIssueInput`, the P7-0 `documents` schema/constraints/RLS,
and the tenant-reference trigger. Independently ran `tsc`, `eslint`, the P7-12 + adjacent suites,
`check-messages`, and a **live local-Supabase functional test** of the reprint RPC's role gating.

---

## Verdict summary

P7-12 is a faithful, thin document-engine extension. The four types are registered purely by catalog
entry + resolver + copy + template + renderer + actions + reprint RPC, and reuse **every** existing engine
capability (idempotent `issueDocumentFoundation`, immutable snapshots, atomic numbering, QR/verification,
Chromium PDF, document history/events, the per-archetype reprint transaction, branding, watermark, Latin
digits) with **no engine-core change**. The four resolvers introduce **no new financial schema and no
duplicated business logic**: every read flows through the single shared P7-11 owner
(`loadAppointmentHistory`, `loadPatientDeposits`, `computeBillingTotals`, `resolveHistoryRange`) and is
frozen into a version-1 snapshot at issue time.

The doctor/assistant financial restriction is enforced in depth and **verified live** against the local
schema: the two financial statements (`DEPOSIT_STATEMENT`, `PATIENT_FINANCIAL_SUMMARY`) use
`OPERATIONAL_ROLES` (admin/manager/receptionist) at the catalog, the action gate `notFound()`s disallowed
roles, and the reprint RPC raises `42501` for a doctor — I reproduced all three. The two history reports
include scoped clinical roles but suppress financial columns/totals and clinical-only related documents
through the reused `isScopedClinical` flag. RLS, tenant isolation, the doctor department/assignment gate,
immutable snapshots, numbering, QR, verification, history, and canonical reprint are all preserved.

The new `history` archetype is additive and justified (doc 16 §9 frames the four as one "History &
financial" family); it touches only the `DocumentArchetype` union + `DOCUMENT_ARCHETYPE_ORDER`, no
exhaustive switch. The absence of imported Figma frames is handled correctly — the four types are composed
from the frozen P7-1 primitive contract and the P7-2 conformance manifest is asserted to equal the first
16 (imported) codes. No P7-9 (Settings) or P7-10 (Hardening) scope leaked (the resolver's
`document_settings` access is the P7-0 settings **read** for numbering/watermark resolution, not P7-9
CRUD).

**No blocking findings.** Seven non-blocking observations (O1–O7), most preserving pre-existing P7-11
behavior or inherent to the "no ledger, derived balance" data-honesty constraint.

**Verdict: APPROVED.**

---

## Required verifications

### 1. Exactly the four approved types — ✅ PASS

`DOCUMENT_TYPE_CODES` grows 16 → 20 with exactly `APPOINTMENT_HISTORY_REPORT`, `PACKAGE_HISTORY_REPORT`,
`DEPOSIT_STATEMENT`, `PATIENT_FINANCIAL_SUMMARY` ([catalog L20-24](../../lib/documents/catalog.ts#L20-L24)),
each a `DOCUMENT_CATALOG` entry with `subject: "patient"`, `template: "PatientHistoryDocument"`, prefixes
`APH`/`PKH`/`DEP`/`PFS`, yearly reset, 4-digit padding
([catalog L338-389](../../lib/documents/catalog.ts#L338-L389)). The contract test asserts exactly these
four codes/prefixes and no external subject ([p712 contract test L15-31](../../tests/unit/lib/p712-patient-history-document-contract.test.ts#L15-L31)).

### 2. Thin engine slices, no duplicated business logic — ✅ PASS

One parameterized resolver dispatches on `documentType`, each branch a thin caller of the shared layer
([resolver L489-525](../../lib/documents/resolvers/patient-history.ts#L489-L525)). The contract test reads
the resolver source and asserts it imports `@/lib/patients/file-data`, calls `loadAppointmentHistory` /
`loadPatientDeposits` / `computeBillingTotals` / `resolveHistoryRange`, threads `isScopedClinical: scoped`,
and never contains `allocate_document_number`
([contract test L72-88](../../tests/unit/lib/p712-patient-history-document-contract.test.ts#L72-L88)).
Issuance reuses `issueDocumentFoundation`; reprint reuses the shared signed-URL pattern; the renderer
reuses `renderDocumentPdf` + `generateDocumentVerificationQrDataUrl`.

### 3. Resolvers reuse `lib/patients/file-data.ts` — ✅ PASS

Appointment history → `loadAppointmentHistory` (unified query) + `computeBillingTotals` for account-wide
totals; deposit statement + financial summary → `loadPatientDeposits`; financial summary + appointment
history → `computeBillingTotals`; all four → `resolveHistoryRange`. No patient/billing/package/deposit
computation is re-implemented in the resolver — package history is the only direct table read
(`patient_packages`, session arithmetic only) and it reuses the same trigger-driven `used_sessions` and
`price_per_session` columns as P7-11 with no new schema ([resolver L333-388](../../lib/documents/resolvers/patient-history.ts#L333-L388)).

### 4. Appointment History respects the date range + includes approved facets — ✅ PASS

`loadAppointmentHistoryData` passes `range.from/to` into `loadAppointmentHistory`, which applies
`gte`/`lte` on `scheduled_at` ([file-data L318-319](../../lib/patients/file-data.ts#L318-L319)). Each row
carries details+status (`StatusBadge`), follow-up outcomes, the appointment's medical note, related issued
documents, and per-row billing (outstanding) for non-scoped roles; account-wide billed/collected/
outstanding render in `TotalsSummary`
([template L139-201](../../components/documents/templates/patient-history-documents.tsx#L139-L201)). Scoped
clinical roles get `billing: null`, `financialVisible: false`, and clinical-only related documents
([resolver L261-330](../../lib/documents/resolvers/patient-history.ts#L261-L330)). See **O1** re
account-wide vs period-scoped totals.

### 5. Package History computes sessions/dates/status correctly — ✅ PASS

Per package: `purchasedSessions = total_sessions`, `usedSessions = used_sessions`,
`remainingSessions = max(0, purchased − used)`, `pricePerSession`, `isActive`, `createdAt`; plus summed
session totals ([resolver L356-388](../../lib/documents/resolvers/patient-history.ts#L356-L388)). Ordered
active-first then newest; date-range filtered by `created_at`. The rendering test confirms the derived
remaining (5 purchased − 2 used → 3) surfaces correctly.

### 6. Deposit Statement — transactions, usage, balance, running balance — ✅ PASS (see O2)

Reuses `loadPatientDeposits` (range-filtered statement lines + all-time derived balance). Lines are ordered
oldest→newest with a running balance that closes on the current derived `accountBalance`; opening balance is
derived as `accountBalance − Σ(in-range deposits)`; usage is shown in aggregate (`totalSpent`) and current
balance in the stat row ([resolver L390-432](../../lib/documents/resolvers/patient-history.ts#L390-L432)).
The running-balance construction closes correctly; its semantics carry a caveat (**O2**).

### 7. Patient Financial Summary combines all sources — ✅ PASS (see O7)

`computeBillingTotals` (appointment charges/payments/outstanding, date-range-filtered by `scheduled_at`) +
`loadPatientDeposits` (all-time balance + total deposited) + package balance
(`Σ remaining × price_per_session`) + active package count
([resolver L434-487](../../lib/documents/resolvers/patient-history.ts#L434-L487)). Charges are
range-scoped; balances are point-in-time — intentional and documented (**O7**).

### 8. Doctor/assistant financial restrictions at catalog, query, action, reprint — ✅ PASS (verified live)

- **Catalog:** `DEPOSIT_STATEMENT`/`PATIENT_FINANCIAL_SUMMARY` → `OPERATIONAL_ROLES`;
  history reports → `SCOPED_OPERATIONAL_ROLES` ([catalog L364-389](../../lib/documents/catalog.ts#L364-L389)).
- **Query:** `loadAppointmentHistoryData` threads `isScopedClinical`, drops the billing column + totals and
  filters related documents to clinical types for scoped roles.
- **Action:** `requirePatientHistoryDocumentAccess` → `requireUser` + `pageRoles.includes(role)` →
  `notFound()` ([actions L952-959](../../actions/documents.ts#L952-L959)), on preview/issue/get/reprint.
- **Reprint RPC:** `record_patient_history_document_reprint` re-checks the role against the same matrix and
  raises `42501` ([migration L52-67](../../supabase/migrations/20260802160000_p712_patient_history_documents.sql#L52-L67)).

**Live functional test (local Supabase, rolled back):** seeded a clinic + receptionist + doctor + two
issued documents, then invoked the RPC under each role's JWT claims:
- receptionist → `DEPOSIT_STATEMENT` reprint **succeeded**, `print_count` bumped to 1;
- doctor → `APPOINTMENT_HISTORY_REPORT` reprint **succeeded**;
- doctor → `DEPOSIT_STATEMENT` reprint **raised `DOCUMENT_REPRINT_NOT_AUTHORIZED` (42501)**.

The deposits entry-point page also `notFound()`s doctor/assistant, so the financial statement link is never
even surfaced to them ([deposits page L41-42](<../../app/(protected)/patients/[id]/deposits/page.tsx#L41-L42>)).

### 9. RLS, scope, tenant isolation, snapshots, numbering, QR, verification, history, reprint — ✅ PASS

- All resolver reads use the caller's RLS-scoped `createClient()`; the doctor department/assignment gate is
  re-checked in `loadPatientHeader` (throws "Patient not found" on a foreign patient)
  ([resolver L217-242](../../lib/documents/resolvers/patient-history.ts#L217-L242)).
- The `documents_select_scoped` RLS policy scopes doctor/assistant reads to their patients via `patient_id`
  (verified against the live schema), and the P7-12 rows carry `patient_id`
  ([foundations L407-438](../../supabase/migrations/20260801120000_p70_document_foundations.sql#L407-L438)).
- Issuance is doc-type-agnostic: `documents.doc_type` is a regex format check (`^[A-Z][A-Z0-9_]{1,63}$`,
  verified live), so the four codes issue with no schema change; `reserve_document_issue` re-validates
  tenant references and the tenant trigger validates `patient_id ∈ clinic`. Preview never allocates a
  number (no numbering call on the preview path); the snapshot is frozen at version 1.
- The reprint RPC is `security definer`, `search_path=''`, `for update`, tenant-scoped
  (`clinic_id = auth_clinic_id()`), restricted to the four `doc_type`s and `issued/void/cancelled`,
  appends a `reprinted` event, bumps `print_count`, and returns the canonical PDF path — identical to the
  established per-archetype pattern. The migration **compiles cleanly against the live local schema**
  (CREATE/ALTER/REVOKE/GRANT/COMMENT in a rolled-back transaction).

### 10. P7-11 entry points pass patient + date range correctly — ✅ PASS

`buildDocumentQuery(patientId, range)` serialises the patient + active preset/from/to; the history,
packages, and deposits pages wire it into `documentHref` for `appointment-history`, `package-history`, and
`deposit-statement` respectively ([file-data L132-143](../../lib/patients/file-data.ts#L132-L143); history
page L94, packages page L173, deposits page L98). The preview page reads `patientId/preset/from/to` from
the query and passes them through `previewPatientHistoryDocument`. See **O5** re the financial-summary
entry point.

### 11. New `history` archetype justified; frozen engine contract unchanged — ✅ PASS

The archetype is added only to the `DocumentArchetype` union
([catalog L28-34](../../lib/documents/catalog.ts#L28-L34)) and `DOCUMENT_ARCHETYPE_ORDER`
([module L24-31](../../lib/documents/module.ts#L24-L31)); grouping/filter/routing derive from the catalog,
so the four types participate in the hub by registration alone. No primitive was added, no `<DocumentPage>`
change, no renderer-core change — the template composes only frozen P7-1 primitives.

### 12. Absence of imported Figma frames handled without bypassing visual checks — ✅ PASS

The four types postdate the 16-design import, so they carry no Figma frame; they are engine-composed from
the frozen primitive contract, inheriting the shared chrome/typography/RTL/QR by construction. The P7-2
conformance test asserts the manifest equals the first 16 catalog codes, explicitly documenting that the
four P7-12 types are outside the design-conformance gate (test passes). The component test still exercises
real visual-quality invariants: renders all four types in AR + EN, asserts `dir=rtl/ltr`, Latin-digit-only
output, and billing suppression for scoped roles.

### 13. No P7-9 / P7-10 / unrelated scope leaked — ✅ PASS

The resolver's only `document_settings` touch is a **read** for per-type numbering/watermark resolution
(override → global → catalog default) — the P7-0 settings read path, not the P7-9 CRUD surface. No
`/settings/documents` page, no hardening-only suites, no unrelated types. All changed files map to the
P7-12 slice.

### 14. Tests are meaningful and fail closed — ✅ PASS

- **Contract test:** catalog registration (archetype/subject/template/prefixes/no-external-subject), the
  doctor financial restriction (`not.toContain("doctor"/"assistant")` on the two financial types), uuid
  validation + non-type rejection, version-1 freeze (`version:2` rejected), the reuse contract (source
  imports the shared layer, no `allocate_document_number`), issue/reprint wiring, bilingual copy.
- **Component test:** all four types render on the shared chrome in AR + EN; `dir` asserted; Latin-digit
  regex `not.toMatch(/[٠-٩۰-۹]/)`; a dedicated scoped-role case asserts no currency (`₺|TRY`) leaks when
  `financialVisible=false`.
- These are security-relevant, fail-closed assertions (money absent for scoped roles; foreign type
  rejected). The reprint RPC's fail-closed behavior is additionally proven by the live test above.

---

## Findings

No blocking findings.

### O1 — Observation · Appointment-history billing totals are account-wide, not period-scoped

The entries table is filtered to the selected date range, but `billingTotals` is computed over **all**
completed appointments regardless of the report's period
([resolver L302-322](../../lib/documents/resolvers/patient-history.ts#L302-L322)). In a formal document
whose identity block shows a period, an "all-time" billed/collected/outstanding summary under a
period-filtered table can read as inconsistent. This mirrors the P7-11 main-page design (P7-11 review §15,
where account-wide totals were a deliberate correctness fix) and is defensible as the patient's overall
financial position, but a period-scoped report would benefit from labelling the totals as account-wide
(or scoping them to the period). Non-blocking.

### O2 — Observation · Deposit-statement running balance is a deposits-only accumulation onto a derived opening

Statement lines are deposit additions only; spend/usage is not interleaved as chronological rows (there is
no ledger table — doc 16 §8). The opening balance is a derived plug (`accountBalance − Σ in-range deposits`)
so the running balance closes exactly on the current derived balance, but the running column does not dip
for spend that occurred between deposits, and when the account balance floors at 0 (total spent > total
deposited) the opening balance can render negative. This is an inherent limitation of the "no ledger,
derived balance" model, internally consistent and closing correctly; flagged for awareness. Non-blocking.

### O3 — Observation · 500-row truncation in appointment history is not surfaced

`loadAppointmentHistoryData` caps entries at `MAX_HISTORY_ROWS = 500` while the section header shows the
true `totalCount` ([resolver L202,251-259](../../lib/documents/resolvers/patient-history.ts#L202-L259)). A
patient with >500 in-range appointments would render a document whose header count exceeds its rows with no
"truncated" indicator. Edge case; a reasonable page cap. Non-blocking.

### O4 — Observation · `PACKAGE_HISTORY_REPORT` declares a `status` filter it does not consume

The catalog `filterSchema` for `PACKAGE_HISTORY_REPORT` includes `status`
([catalog L358](../../lib/documents/catalog.ts#L358)), but the resolver params schema has no status field
and the resolver returns all packages (rendering status as a column). The `/documents/new` filter bar may
show a status control that does nothing for this type. Cosmetic filter/param mismatch. Non-blocking.

### O5 — Observation · `PATIENT_FINANCIAL_SUMMARY` has no contextual entry from the patient file

Doc 16 §8 lists deposits as printable via `DEPOSIT_STATEMENT` **and** `PATIENT_FINANCIAL_SUMMARY`, but only
`deposit-statement` is wired from the deposits page; the financial summary is reachable only via
`/documents/new → /patients`. The required type (`APPOINTMENT_HISTORY_REPORT`) is wired. Non-blocking.

### O6 — Observation · Package price/session is visible to scoped clinical roles in an issued document

`PACKAGE_HISTORY_REPORT` uses `SCOPED_OPERATIONAL_ROLES` and the template renders `pricePerSession`
([template L223,234](../../components/documents/templates/patient-history-documents.tsx#L223-L234)), so a
doctor/assistant can issue a document exposing package pricing. This preserves the pre-existing P7-11
behavior (P7-11 review O4 — package prices were already visible to all roles) and sits outside the founder
financial restriction (billing/revenue/deposits), which remains gated; flagged for awareness since it is
now baked into an issued, verifiable document. Non-blocking.

### O7 — Observation · Financial summary mixes range-scoped charges with all-time balances

`appointmentCharges`/`payments`/`outstanding` are filtered by `scheduled_at`, while `depositsBalance`,
`totalDeposited`, and `packageBalance` are all-time point-in-time values
([resolver L434-487](../../lib/documents/resolvers/patient-history.ts#L434-L487)). Intentional (balances
are inherently point-in-time) and matches doc 16 §9, but a period-headed summary would benefit from
labelling which figures are point-in-time. Non-blocking.

---

## Independent validation run

- `pnpm exec tsc --noEmit` — **clean** (exit 0).
- `pnpm exec eslint` on the P7-12 resolver/renderer/template/page/actions — **clean** (exit 0).
- `pnpm vitest run` on `p712-patient-history-document-contract`, `p712-patient-history-document`,
  `p70-document-catalog`, `p78-document-module`, `p72-document-conformance`, `p711-patient-file-data` —
  **41 passed / 6 files**.
- `node scripts/check-messages.mjs` — **3,758 leaf messages; no unused keys.**
- **Live local Supabase — migration compile:** the P7-12 reprint migration applies cleanly against the
  running local schema in a rolled-back transaction (all dependencies — `documents`, `document_events`,
  `auth_role()`, `auth_clinic_id()`, `user_role` — resolve).
- **Live local Supabase — reprint role gating (functional, rolled back):** receptionist reprints
  `DEPOSIT_STATEMENT` (success, `print_count → 1`); doctor reprints `APPOINTMENT_HISTORY_REPORT` (success);
  doctor reprints `DEPOSIT_STATEMENT` → **`DOCUMENT_REPRINT_NOT_AUTHORIZED` (42501)**. Confirms the
  doctor financial restriction at the DB layer plus tenant/doc-type scoping.
- Verified `documents.doc_type` is a regex format check (not an enum) against the live schema — the four
  new codes issue with no schema change; the tenant-reference trigger validates `patient_id ∈ clinic`.
- Scope-leak review across the P7-12 files — no P7-9 (settings CRUD) / P7-10 (hardening) surfaces; the
  `document_settings` access is the P7-0 settings read.

**Migration application to remote:** not performed and not required for this review (consistent with the
P7-11 "no remote Supabase operation" posture); the migration was validated locally as above. Applying
`20260802160000` (and the other pending P7 migrations) to the remote remains a DB-connected deploy step.

No production code was modified during this review. No commit was made.

---

**Verdict: APPROVED.**
