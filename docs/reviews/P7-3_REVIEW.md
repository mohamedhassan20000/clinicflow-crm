# P7-3 Review — Revenue Report vertical slice

**Reviewer:** Claude (independent review)
**Date:** 2026-08-01
**Branch:** `feat/p7-document-platform`
**Scope reviewed:** P7-3 — Revenue Report (doc 01) end-to-end: resolver, snapshot schema,
Layer-2 template, preview trigger, draft/issued document page, issuance path, canonical reprint,
lifecycle history, public verification page + RPC, logo inlining, and the three narrow
production-boundary fixes to the reused P7-1 renderer. Migration
`20260801130000_p73_revenue_document_slice.sql`.
**Method:** Read the analysis roadmap (doc 13), lifecycle (05), numbering (06), verification (07),
the P7-2 review, and the P7-3 implementation report; read every P7-3-changed file plus the P7-0
foundation (`reserve/complete/fail_document_issue`, RLS, storage policy) and the frozen P7-1 PDF
path it depends on; independently re-queried Figma via MCP for both Revenue Report nodes; ran
`tsc`, the P7-3 unit suite, the P7-3 Supabase integration suite against the local stack, and the
message-parity gate.

Findings use stable IDs for the Claude→Codex handoff contract.

---

## Verdict summary

The vertical slice is complete and matches the approved roadmap (doc 13 §P7-3). Preview, issuance,
immutable snapshot, PDF, per-clinic/per-type numbering, QR verification, reprint, history, and the
public verification page all behave correctly, and the security posture (RLS, definer boundaries,
idempotency, snapshot immutability, rate limiting, SSRF-safe logo inlining) is sound. No P7-4+
document type, module, or settings surface leaked. Tests are meaningful and fail closed.

One **required fix** stands: the reported Figma AR/EN reversal is a **real design-source
inconsistency**, and it is presently recorded backwards in an *authoritative, tested* artifact — the
P7-2 conformance manifest — as well as in the Revenue Report reference files. P7-3's own
implementation is correct; the record that P7-4+ will trust is not. Four non-blocking observations
follow.

---

## Required verifications

### 1. Matches the approved roadmap — ✅ PASS

Doc 13 §P7-3 prescribes: catalog entry → reused resolver (`lib/reports/data.ts`, `revenue`) →
Layer-2 template → preview (DRAFT, no number) → issue (allocate + idempotent snapshot + PDF store) →
reprint → verification page → history → an `actions/documents.ts` module. Every item is present:

- Resolver reuses `getRevenueSummaryData` for aggregates and adds an RLS-scoped, paginated
  transaction-detail read; branding, format, and effective settings are frozen into a
  `version: 1` snapshot ([lib/documents/resolvers/revenue-report.ts:169-267](../../lib/documents/resolvers/revenue-report.ts#L169-L267)).
- Template composes only the frozen primitive sequence
  `StatCardRow → SectionHeader → DataTable → TotalsSummary → NotesCallout → VerificationBlock → SignatureBlock`,
  matching the P7-2 manifest primitive order for entry 1
  ([components/documents/templates/revenue-report.tsx:177-228](../../components/documents/templates/revenue-report.tsx#L177-L228)).
- Preview is DRAFT with no allocated number; the identity `documentNumber` is `null` unless issued,
  and the watermark is forced on for preview by the engine
  ([templates/revenue-report.tsx:161-170](../../components/documents/templates/revenue-report.tsx#L161-L170)).
- Issue delegates to the P7-0 `issueDocumentFoundation`; the slice never touches
  `allocate_document_number` directly (asserted by test).
- Actions module exposes preview / issue / getIssued / reprint
  ([actions/documents.ts](../../actions/documents.ts)); the `/reports/revenue` header gains a
  filter-preserving preview trigger.

### 2. Revenue Report vertical slice is complete — ✅ PASS

Draft preview, AR/EN locale switch, issue, issued view with QR + history, canonical reprint, and
public verification are all wired through one page
([app/(protected)/reports/revenue/document/page.tsx](<../../app/(protected)/reports/revenue/document/page.tsx>))
and one public route ([app/(public)/verify/[token]/page.tsx](<../../app/(public)/verify/[token]/page.tsx>)).
Preview and issued snapshots share the same template; the issued view resolves QR only when
`snapshot.settings.qrEnabled`.

### 3. Preview / issuance / snapshot / PDF / numbering / QR / reprint / history / public verification — ✅ PASS

- **Preview consumes no number** (doc 06 §4): `previewRevenueReportDocument` resolves the snapshot
  and renders with `lifecycle="preview"`; no allocator or `documents` write is reached.
- **Snapshot frozen at issue** (doc 05 §4): `issueRevenueReportDocument` **re-resolves** the
  snapshot at issue time (with `inlineLogo: true`) rather than trusting a client-supplied preview,
  and passes it to the reservation as immutable `snapshot` jsonb
  ([actions/documents.ts:94-120](../../actions/documents.ts#L94-L120)).
- **PDF** is rendered server-side through the frozen Chromium path; only `data:`/`about:` requests
  are permitted, JS is disabled, print media emulated, and `document.fonts.ready` awaited — so QR
  and logo (both data URIs) embed and no network asset can leak
  ([lib/documents/pdf/render.ts:65-116](../../lib/documents/pdf/render.ts#L65-L116)).
- **Numbering** is per-clinic/per-type via `allocate_document_number` inside `reserve_document_issue`
  under a per-`(clinic, idempotency_key)` advisory lock, with the full visible number frozen on the
  row and `unique (clinic_id, doc_type, document_number)` as the backstop (P7-0 migration).
- **QR** encodes `https://clinicflow.fit/verify/<token>` with an opaque 32-hex token — never the
  sequential number ([lib/documents/verification-qr.ts:4-24](../../lib/documents/verification-qr.ts#L4-L24)),
  satisfying doc 07 §2.
- **Reprint** re-serves the stored canonical PDF via `record_revenue_document_reprint`, keeping
  identity/snapshot/path immutable, incrementing `print_count`, and appending a `reprinted` event
  (integration-tested; snapshot asserted unchanged).
- **History** lists actor-attributed lifecycle events in order, resolving actor names through a
  scoped `profiles` read ([actions/documents.ts:172-209](../../actions/documents.ts#L172-L209)).
- **Public verification** returns exactly the five allowed fields (doc 07 §7); the definer RPC
  projects only status/number/type/issue-date/clinic-name and never the snapshot.

### 4. Security, RLS, idempotency, snapshot immutability, rate limiting — ✅ PASS

- **RLS read boundary.** `getIssuedRevenueDocument` reads through the RLS client and additionally
  pins `clinic_id`; the P7-0 `documents_select_scoped` policy exposes only
  `issued/void/cancelled` rows and never `rendering`/`failed` reservations. The issue path does not
  set `doctor_id`/`patient_id` on Revenue Report rows, so only admin/manager/receptionist see them
  — consistent with the reprint role gate.
- **Definer boundaries.** `verify_document_token` (anon+authenticated, `search_path=''`, 5-field
  projection) and `record_revenue_document_reprint` (authenticated only, `revoke … from anon`,
  role-gated to admin/manager/receptionist, caller-clinic + `REVENUE_REPORT` scoped, `FOR UPDATE`)
  are correctly locked down (P7-3 migration).
- **Idempotency & rollback.** The reservation guard returns the existing document on a retry and
  never re-allocates; the coordinator marks `failed` before deleting a stored artifact and refuses
  to delete when completion may already have committed
  ([lib/documents/issuance.ts:80-136](../../lib/documents/issuance.ts#L80-L136)). Idempotency
  conflict (same key, different inputs) raises `23505`.
- **Snapshot immutability.** No authenticated write policy exists on `documents`; the snapshot is
  written once at reservation and never re-rendered on reprint.
- **Rate limiting.** The verify page throttles 30/60s per client IP with `failureMode: "closed"`,
  and validates the token shape (`^[0-9a-f]{32}$`) before any query
  ([verify/[token]/page.tsx:28-45](<../../app/(public)/verify/[token]/page.tsx#L28-L45>),
  [lib/documents/verification.ts:24](../../lib/documents/verification.ts#L24)). Unknown, malformed,
  and non-terminal statuses all collapse to `unavailable` (enumeration-safe).
- **Logo inlining is SSRF-safe.** `inlineClinicLogo` accepts only `https` on the trusted Supabase
  origin under the clinic's own `clinic-assets/clinics/<clinicId>/` prefix, enforces a MIME
  allowlist, a 5 MiB cap, and a 5 s timeout; anything else degrades to the engine identity mark
  ([lib/documents/assets.ts:16-61](../../lib/documents/assets.ts#L16-L61)).

### 5. No P7-4+ scope leaked — ✅ PASS

`lib/documents/{templates,renderers,resolvers}` contain only `revenue-report`; `DOCUMENT_CATALOG`
registers only the pre-existing `REVENUE_REPORT` + `INVOICE` (P7-0) skeleton. No Documents module
(`/documents` list/detail), no `/settings/documents`, no second document type, and no new
dependency were added. Confirmed by directory listing and catalog grep.

### 6. Tests are meaningful — ✅ PASS

- The public-verification unit test proves malformed/uppercase tokens are rejected **without**
  querying, that only the five approved fields survive (a planted `snapshot` field is stripped), and
  that misses/errors/unknown statuses collapse to `unavailable`
  ([tests/unit/lib/p73-public-document-verification.test.ts](../../tests/unit/lib/p73-public-document-verification.test.ts)).
- The integration test exercises the **real** RPCs on the local stack: an `anon` client verifies by
  opaque token and receives exactly the five-field projection, a wrong token returns `[]`, and a
  reprint returns the immutable canonical path, increments `print_count`, leaves the snapshot
  byte-identical, and yields `["issued","reprinted"]`
  ([tests/unit/integration/p73-revenue-document-slice.test.ts](../../tests/unit/integration/p73-revenue-document-slice.test.ts)).
- The contract test pins `version: 1`, rejects reversed date ranges, and asserts the action routes
  through `issueDocumentFoundation` and **not** `allocate_document_number`.

---

## Independent validation run

| Check | Command | Result |
|---|---|---|
| TypeScript | `tsc --noEmit` (`pnpm typecheck`) | ✅ exit 0 |
| P7-3 unit suite | `vitest run` lib+components+db P7-3 files | ✅ 4 files, 10 tests pass |
| P7-3 Supabase integration | `vitest run …/p73-revenue-document-slice.test.ts` (local stack, migration applied) | ✅ 1 file, 2 tests pass |
| Message parity | `node scripts/check-messages.mjs` | ✅ 3,344 leaves, no unused keys |
| Figma MCP re-inspection | `get_screenshot` ×2 (`8:18`, `8:262`) | ✅ resolves; reversal confirmed (see P7-3-R1) |

---

## Required fix

### P7-3-R1 — Figma AR/EN reversal is a **real design-source inconsistency**, recorded backwards in the tested conformance manifest — REQUIRED (documentation/manifest only)

I re-queried both Revenue Report nodes independently via Figma MCP (file `nUzeFkN6Yn7m7knTzwmDHq`):

- **Node `8:18` renders English** — "REVENUE REPORT", LTR, Latin script.
- **Node `8:262` renders Arabic** — "تقرير الإيرادات", RTL.

This is **not an implementation mistake**. P7-3 followed the *actual* node content, and the shipped
AR/EN template copy is correct. The inconsistency is in the **source records**, which are reversed:

- `docs/designs/document-platform/01-revenue-report/ar/…/FIGMA_REFERENCE.md` points at node **8-18**
  (which is English); the `en/` reference points at **8-262** (which is Arabic).
- The approved, imported, **test-asserted** P7-2 conformance manifest carries the same reversal:
  `entry(1, "REVENUE_REPORT", …, arNode="8:18", enNode="8:262")`
  ([components/documents/harness/p72-conformance-manifest.ts:114](../../components/documents/harness/p72-conformance-manifest.ts#L114)).

Because the primitive map is locale-symmetric, this does **not** change the P7-2 gate outcome and
does not affect P7-3 runtime behavior — which is why it was invisible in the P7-2 review (the
Revenue nodes were among the 28 not independently re-queried there). But it leaves an authoritative
artifact that P7-4…P7-7 will trust factually wrong: anyone pulling `arNode`/`enNode` for a future
document, or cross-checking Revenue against Figma, is pointed at the wrong-locale frame.

The P7-3 report chose not to rewrite the "already-approved P7-2 records." That is the wrong call for
a record that is imported and tested: **correct the AR↔EN node-id mapping** in the two Revenue
Report `FIGMA_REFERENCE.md` files and in the P7-2 conformance manifest (swap `8:18`/`8:262`), and
add a one-line note in the P7-2 conformance doc recording the source-frame mislabeling so the
correction is auditable. No production runtime code changes. (If the founder prefers to keep P7-2
frozen verbatim, the minimum acceptable alternative is an explicit, committed erratum in the
conformance doc naming the reversal — silence in a tested record is not acceptable.)

---

## Non-blocking observations

- **P7-3-N1 (informational): idempotency key is regenerated per page render.** `randomUUID()` is
  minted in `RevenueDocumentPage` and passed to the action
  ([document/page.tsx:92,144](<../../app/(protected)/reports/revenue/document/page.tsx#L92>)). This
  correctly de-dupes a double-click within one render, but a page **refresh** yields a new key, so
  issuing again after a refresh mints a second document + number for the same period. This is
  consistent with doc 05's "client-supplied token" option and its "regenerate = new issue"
  semantics, so it is acceptable — but there is no natural-key (`clinic, type, params_hash, locale`)
  backstop against accidental re-issue. Worth confirming the founder wants no such guard before the
  pattern is copied across P7-4+.

- **P7-3-N2 (informational): reprint is permitted on `void`/`cancelled` documents.** Both the action
  and `record_revenue_document_reprint` accept `issued/void/cancelled`, and the issued view renders a
  reprint button for a voided document, incrementing its `print_count`. Doc 05 retains the PDF for
  void for audit, so re-serving is defensible, but incrementing the print counter on a retired
  document (and offering the button) is a minor semantic oddity to reconsider in P7-10.

- **P7-3-N3 (informational): totals row vs. visible transaction sum.** The `DataTable` "TOTAL
  AGGREGATES" row is fed from `snapshot.summary` (the `get_revenue_summary` RPC), while the visible
  line rows come from the separate transaction-detail query. Both run under the same RLS client and
  the same `status='completed'` + `paid_at` window, so they are consistent in scope; however
  `grossTotal`/settlements are aggregate concepts that need not equal the arithmetic sum of the
  visible `Total` column. This mirrors the existing on-screen revenue report and is not introduced
  by P7-3, but it is exactly the AR/EN + Latin-digit + figure-fidelity check doc 13 §P7-10 reserves —
  flag it for that QA pass.

- **P7-3-N4 (informational): primitive order vs. Figma placement.** The Figma frame places
  "Breakdown by method" above the transaction table and the three context cards (scope / accounting
  basis / auditor signature) directly under the header, whereas the template emits `TotalsSummary`
  (methods) after the `DataTable` and folds the context cards into a `NotesCallout`. This conforms to
  the P7-2-approved primitive order and set, so it is a faithful engine reproduction rather than a
  deviation; noted only so the ordering choice is on record.

---

## Verdict

APPROVED WITH REQUIRED FIXES
