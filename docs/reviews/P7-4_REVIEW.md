# P7-4 Review — Analytical document batch (archetype A, remaining 7)

**Reviewer:** Claude (independent review)
**Date:** 2026-08-01
**Branch:** `feat/p7-document-platform`
**Scope reviewed:** P7-4 — documents 02 (Follow-up Page), 08 (Cancellation), 09 (No-show),
10 (Sales), 11 (Follow-up Analytics), 12 (Doctor Performance), 13 (Receptionist Performance):
catalog entries, the shared versioned analytical snapshot contract, the reused report resolvers,
the two net-new RLS-scoped resolvers (Sales, Follow-up Analytics), the shared Layer-2 template,
the analytical renderer, the shared `/reports/[report]/document` draft/issued page, the issuance
path, the canonical reprint RPC, lifecycle history, extended public verification, the report-page
and report-index contextual triggers, and migration
`20260801140000_p74_analytical_document_batch.sql`.
**Method:** Read the analysis roadmap (doc 13), catalog/taxonomy (02), lifecycle (05), numbering
(06), verification (07), integration/reuse map (12), the P7-2 conformance manifest, the P7-3
review, and the P7-4 implementation report; read every P7-4-changed file plus the reused report
resolvers (`lib/reports/data.ts`) and the frozen P7-0 issuance / P7-1 PDF / P7-3 verification paths
this batch depends on; independently re-queried Figma via MCP for the Sales (AR `19:1718`) and
Follow-up Analytics (EN `20:2074`) nodes; verified DB columns against `types/database.ts`; and ran
`tsc`, the P7-4 unit suite, the P7-4 Supabase integration suite against the live local stack, the
P7-0…P7-3 document regression set, and the message-parity gate.

Findings use stable IDs for the Claude→Codex handoff contract.

---

## Verdict summary

The analytical batch is complete and matches the approved roadmap (doc 13 §P7-4). All seven
documents preview as DRAFT (no number), issue through the frozen P7-0 idempotent foundation, freeze
an immutable versioned snapshot, allocate per-clinic/per-type numbers, render server-side PDFs with
QR, reprint the canonical artifact, record actor-attributed history, and expose the five-field
public verification. The two net-new resolvers (Sales, Follow-up Analytics) are `SECURITY INVOKER`,
caller-clinic scoped, role-gated, and proven tenant-isolated + role-denied by live integration
tests. Existing report resolvers were reused for the other five. No engine or primitive-contract
change was made. No P7-5+ document type, Documents module, settings surface, or delivery flow
leaked. Tests are meaningful and fail closed. Independent Figma re-inspection confirms the AR/EN
node mapping is correct (no reversal like Revenue's) and the templates faithfully reproduce the
approved layouts.

The **P7-3-R1 required fix is cleared**: the Revenue AR/EN node reversal is corrected in the tested
P7-2 conformance manifest (`entry(1, … "8:262", "8:18" …)`), so the record P7-4 builds on is now
accurate.

No required fixes. Five non-blocking observations follow (three carried forward from P7-3 and now
propagated across the batch).

---

## Required verifications

### 1. Matches the approved roadmap — ✅ PASS

Doc 13 §P7-4 prescribes documents 02, 08, 09, 12, 13 as **reused-resolver** thin templates, and 10
Sales + 11 Follow-up Analytics as **net-new RLS-scoped data pipelines**, ordered resolver-reuse
first then the two builds. All eight items are present and correctly typed:

- `FOLLOW_UP_PAGE_REPORT`, `CANCELLATION_REPORT`, `NO_SHOW_REPORT`, `DOCTOR_PERFORMANCE_REPORT`,
  `RECEPTIONIST_PERFORMANCE_REPORT` reuse `get_followups_dashboard`, `getCancellationReportData`,
  `getNoShowReportData`, `getDoctorPerformanceData`, `getReceptionistPerformanceData`
  ([lib/documents/resolvers/analytical-report.ts:342-379](../../lib/documents/resolvers/analytical-report.ts#L342-L379)).
  Their catalog `resolver` refs are `{ kind: "report", reportId: … }`.
- `SALES_REPORT` and `FOLLOW_UP_ANALYTICS_REPORT` carry `{ kind: "document", resolverId: … }` and
  hit the two new RPCs (§4). Together with the approved P7-3 Revenue Report this makes **8/16
  analytical documents** complete.
- Frozen prefixes are exactly `FU`, `CR`, `NS`, `SAL`, `FUA`, `DPF`, `RPF`
  ([lib/documents/catalog.ts:121-211](../../lib/documents/catalog.ts#L121-L211); pinned by
  [tests/unit/lib/p74-analytical-document-contract.test.ts:22-31](../../tests/unit/lib/p74-analytical-document-contract.test.ts#L22-L31)).

### 2. The seven analytical documents are complete — ✅ PASS

Each has a catalog entry, a thin body in the shared template
([components/documents/templates/analytical-reports.tsx](../../components/documents/templates/analytical-reports.tsx)),
AR/EN copy ([lib/documents/analytical-copy.ts](../../lib/documents/analytical-copy.ts)), a
contextual preview trigger, and full draft→issue→reprint→verify wiring through one page. The five
report pages (`follow-ups`, `cancellations`, `no-shows`, `doctors`, `receptionists`) gained
filter-preserving "Preview document" buttons, and the two net-new surfaces (Sales, Follow-up
Analytics) appear as role-gated cards on the reports index
([app/(protected)/reports/page.tsx](<../../app/(protected)/reports/page.tsx>),
[components/reports/reports-index.tsx](../../components/reports/reports-index.tsx)).

### 3. Preview / issuance / snapshot / numbering / PDF / QR / history / reprint / public verification — ✅ PASS

- **Preview consumes no number.** `previewAnalyticalReportDocument` resolves the snapshot and
  renders `lifecycle="preview"` with `documentNumber: null`; no allocator or `documents` write is
  reached. The component test asserts the preview shows DRAFT/PREVIEW watermark and emits **no**
  `VerificationBlock`
  ([p74-analytical-documents.test.tsx:237-239](../../tests/unit/components/p74-analytical-documents.test.tsx#L237-L239)).
- **Snapshot frozen at issue.** `issueAnalyticalReportDocument` **re-resolves** with
  `inlineLogo: true` at issue time and passes it as immutable `snapshot` jsonb; a `version: 1`
  discriminated union preserves period, filters, branding, format, settings, and type-specific data
  ([actions/documents.ts:347-372](../../actions/documents.ts#L347-L372),
  [analytical-report.ts:186-209](../../lib/documents/resolvers/analytical-report.ts#L186-L209)).
- **Numbering** flows through the P7-0 `issueDocumentFoundation` → `reserve_document_issue` →
  `allocate_document_number`; the batch never touches the allocator directly (asserted by contract
  test: `not.toContain("allocate_document_number")`). Prefix/yearly-reset resolve override → global
  → catalog default.
- **PDF** renders through the frozen Chromium path (`renderIssuedAnalyticalReportPdf`), embedding QR
  and inlined logo as data URIs. The renderer re-parses the snapshot and hard-fails if the
  reservation type ≠ snapshot type
  ([renderers/analytical-report.tsx:13-15](../../lib/documents/renderers/analytical-report.tsx#L13-L15)).
- **QR** is resolved only when `snapshot.settings.qrEnabled` and encodes the opaque token via the
  frozen `generateDocumentVerificationQrDataUrl`, never the sequential number.
- **History** lists actor-attributed events in order via a scoped `profiles` read; `getIssued…`
  additionally pins `clinic_id` + `doc_type` + `id` and re-checks `snapshot.documentType`
  ([actions/documents.ts:419-443](../../actions/documents.ts#L419-L443)).
- **Reprint** re-serves the stored canonical PDF via `record_analytical_document_reprint`, keeping
  identity/snapshot/path immutable, incrementing `print_count`, appending a `reprinted` event, then
  minting a 5-min signed URL. Integration proves the returned path/number and `["issued",
  "reprinted"]`.
- **Public verification** is type-agnostic and still projects only the five allowed fields
  ([lib/documents/verification.ts](../../lib/documents/verification.ts)); the verify page adds the
  seven new type labels while retaining `robots: noindex`, IP rate-limiting (`failureMode: closed`),
  token-shape validation, and enumeration-safe collapse to `unavailable`
  ([app/(public)/verify/[token]/page.tsx](<../../app/(public)/verify/[token]/page.tsx>)).

### 4. Sales & Follow-up Analytics resolvers correctly scoped with RLS — ✅ PASS

- `get_document_sales_report` and `get_document_follow_up_analytics_report` are **`SECURITY
  INVOKER`** (table RLS applies), set `search_path = public, pg_temp`, hard-fail unauthenticated
  callers (`28000`), and role-gate: Sales → admin/manager/receptionist (`42501` otherwise),
  Follow-up Analytics → +doctor/assistant. Both filter every CTE by `auth_clinic_id()`; Follow-up
  Analytics also honours the optional `p_doctor_id`
  ([migration:9-229](../../supabase/migrations/20260801140000_p74_analytical_document_batch.sql#L9-L229)).
  These role gates match the catalog `pageRoles` (`OPERATIONAL_ROLES` / `SCOPED_OPERATIONAL_ROLES`)
  and the reprint RPC's per-type gate.
- Sales derives collection-period figures from `appointments` (`status='completed'`, `paid_at` in
  window) and `outstanding_settlements` (`settled_at` in window); Follow-up Analytics joins
  `follow_ups` to `appointments` with **appointment-scheduled** period semantics. All referenced
  columns exist in `types/database.ts`.
- **Live integration proof** (ran against the local stack): Sales returns honest per-clinic totals
  (collected = primary+secondary+insurance+deposit+settlement = 175), clinic B sees only its own
  data, a `doctor` caller is denied `42501`; Follow-up Analytics scopes to caller clinic + requested
  doctor; reprint succeeds for the own-clinic document and returns `P0002` cross-tenant
  ([tests/unit/integration/p74-analytical-document-batch.test.ts](../../tests/unit/integration/p74-analytical-document-batch.test.ts)).

### 5. Existing resolvers reused where appropriate — ✅ PASS

The five report-backed documents call the exact existing `lib/reports/data.ts` helpers (which wrap
`SECURITY INVOKER` report RPCs under RLS), applying only in-memory doctor/department narrowing that
mirrors the on-screen reports. No duplicate query logic or parallel data path was introduced.

### 6. Visual polish improves quality without redesigning Figma — ✅ PASS

The template composes **only** frozen Layer-1 primitives in the P7-2-approved order per document.
Wide performance tables and the Follow-up Analytics/Receptionist share bars are ordinary `DataTable`
content/cell renders (the manifest explicitly records share values as "table-cell content, not an
engine primitive"), so the P7-1 contract is untouched. Independent Figma re-inspection: node
`19:1718` renders Sales in Arabic (RTL) and node `20:2074` renders Follow-up Analytics in English
(LTR) — mapping correct, and the rendered primitive structure (SectionHeader → NotesCallout →
StatCardRow → DataTable → Verification → Signature for FUA; metric cards + payment table + notes for
Sales) matches the templates one-to-one.

### 7. No P7-5+ scope leaked — ✅ PASS

`DOCUMENT_CATALOG` registers only the analytical batch + P7-3 Revenue + the P7-0 Invoice skeleton;
roster/profile/clinical types remain type codes only, unregistered.
`lib/documents/{templates,renderers,resolvers}` and `components/documents/templates` contain only
`revenue-report` and `analytical-report(s)`. No `/documents` list/detail module, no `/documents/new`,
no `/settings/documents`, no delivery flow, and no new dependency were added. (The pre-existing
`documents/engine-harness` dev route is P7-1/P7-2, not the P7-8 module.)

### 8. Tests are meaningful — ✅ PASS

- **Contract** pins the seven codes/prefixes, the two `document`-kind resolvers, `version: 1`,
  rejects reversed ranges and unregistered types, and asserts the batch routes through
  `issueDocumentFoundation` / `record_analytical_document_reprint` and **not**
  `allocate_document_number`.
- **Component** renders all seven in EN preview (asserting exact direct-body primitive order + DRAFT
  watermark + absent verification) and in AR issued (asserting `dir="rtl"`, the document number, a
  real QR `<img src>`, and **no Arabic-Indic digits**).
- **Migration** (source assertions) confirms `SECURITY INVOKER` for both resolvers, the explicit
  source tables and period columns, zero-division guard, and that reprint is restricted to the seven
  types, clinic-scoped, increments the counter, appends history, and never `delete`s.
- **Integration** exercises the real RPCs on the live stack for totals, tenant isolation, role
  denial, doctor scope, and reprint history (see §4).

### 9. Security, RLS, idempotency, snapshot immutability, numbering — ✅ PASS

- **Idempotency & rollback** inherit the P7-0 guard: the key is namespaced
  (`analytical:<type>:<uuid>`), a retry returns the existing document, and render failure rolls back
  via the frozen coordinator.
- **Snapshot immutability**: written once at reservation; reprint re-serves the same bytes and never
  re-renders. `documents` has no authenticated write policy.
- **Reprint RPC** is `SECURITY DEFINER` with `search_path = ''`, fully-qualified `public.` refs,
  `owner to postgres`, `revoke … from public, anon`, a `FOR UPDATE` clinic+type+status-scoped lookup,
  and a per-type role gate consistent with `pageRoles`.
- **Defense in depth**: reports-index hides the Sales/FUA cards by role, and every action
  independently re-authorizes via `requireAnalyticalDocumentAccess` (report access or catalog
  `pageRoles`) before reading or writing.

---

## Independent validation run

| Check | Command | Result |
|---|---|---|
| TypeScript | `tsc --noEmit` (`pnpm typecheck`) | ✅ exit 0 |
| P7-4 unit suite | `vitest run` contract + component + migration + catalog | ✅ 4 files, 23 tests |
| P7-4 Supabase integration | `vitest run …/p74-analytical-document-batch.test.ts` (live local stack) | ✅ 1 file, 4 tests |
| P7-0…P7-3 document regression | `vitest run` 8 foundation/engine/conformance/revenue files | ✅ 8 files, 30 tests |
| Message parity | `node scripts/check-messages.mjs` | ✅ 3,487 leaves, no unused keys |
| Figma MCP re-inspection | `get_screenshot` Sales `19:1718` (AR) + FUA `20:2074` (EN) | ✅ mapping + layout confirmed |

(Full `pnpm lint` / `lint:rtl` / `lint:i18n` / `pnpm build` were reported green by the
implementation report; I did not re-run the full lint/build here — nothing in the reviewed diff
suggests a regression, and typecheck + the RTL/Latin-digit/i18n assertions in the test suite pass.)

---

## Non-blocking observations

- **P7-4-N1 (informational): idempotency key regenerated per page render — now batch-wide.** The
  `randomUUID()` minted in the document page is passed to the action, so a **refresh** yields a new
  key and re-issuing after refresh mints a second document + number for the same period. This is the
  same accepted pattern as **P7-3-N1**, now propagated across all seven types. Still consistent with
  doc 05's "regenerate = new issue" semantics; worth the founder confirming no natural-key backstop
  is wanted before more surfaces copy it.

- **P7-4-N2 (informational): reprint permitted on `void`/`cancelled`, and by doctor/assistant for
  the operational four.** `record_analytical_document_reprint` accepts `issued/void/cancelled` and
  increments `print_count` on retired documents (same as **P7-3-N2**). The per-type role gate lets
  doctor/assistant reprint Follow-up Page / Cancellation / No-show / Follow-up Analytics — this
  matches their `pageRoles`, so it is intentional, but re-serving a voided document's counter remains
  a minor semantic oddity to revisit in P7-10.

- **P7-4-N3 (figure-fidelity, defer to P7-10 QA): Sales payment-method table need not reconcile with
  Collected Revenue.** `paymentMethods` aggregates only primary + secondary + settlement amounts
  (grouped by their payment-method columns), whereas `collectedTotal` also includes `insuranceTotal`
  + `depositTotal` (which carry no payment-method dimension). A reader may expect the "Breakdown by
  payment method" table to sum to Collected; it will typically be short by insurance + deposits.
  This is a data-presentation nuance of a net-new report (analogous to **P7-3-N3**), not a
  correctness bug — flag it for the doc 13 §P7-10 AR/EN + figure-fidelity QA pass, and consider a
  one-line caption clarifying the table's scope.

- **P7-4-N4 (informational): `SALES_REPORT` archetype label mismatch.** The catalog tags
  `SALES_REPORT` as `archetype: "analytical"` while the tested P7-2 conformance manifest tags entry
  10 as `"financial"`. No behavior depends on it (Sales is delivered in the P7-4 analytical batch as
  the roadmap directs), but the two authoritative records disagree cosmetically — worth aligning so
  a later archetype-driven query isn't surprised.

- **P7-4-N5 (informational): Follow-up Page preview link carries only the date range.** Unlike the
  doctor/cancellation/no-show/receptionist triggers (which forward their filter), the Follow-up Page
  trigger forwards only `from`/`to`/`locale` because the on-screen Follow-ups report exposes no
  doctor filter. Consistent with that surface; noted only for completeness.

---

## Verdict

APPROVED
