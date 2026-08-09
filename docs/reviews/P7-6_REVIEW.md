# P7-6 Review — Clinical Documents (Prescription / Lab Request / Sick Leave)

**Reviewer:** Claude (independent review)
**Date:** 2026-08-02
**Branch:** `feat/p7-document-platform`
**Scope reviewed:** P7-6 — registration of the three clinical document codes (`PRESCRIPTION`,
`LAB_REQUEST`, `SICK_LEAVE_CERTIFICATE`); the `{documentType, recordId}` resolver reading only
finalized P7-6A clinical records; the immutable versioned snapshot; AR/EN copy + template built on
the frozen P7-1 primitives; server-resolved preview, issuance, canonical PDF, QR, public
verification labels, issued-document history, and canonical reprint; the reprint RPC migration
`20260802130000_p76_clinical_documents.sql`; controlled-medicine block; blank signature/stamp
fallback; header/logo/QR/signature visual refinements.

**Method:** Read the authoritative design (doc 16), the roadmap (doc 13, P7-6/P7-6A), the frozen
P7-1 primitive contract (`P7-1_PRIMITIVE_CONTRACT.md`), the P7-2 conformance report, the approved
P7-6A implementation **and** its APPROVED review (incl. the C1 fix), the P7-6 implementation report,
and every P7-6-changed file: `actions/clinical-documents.ts`,
`lib/documents/resolvers/clinical-document.ts`, `lib/documents/renderers/clinical-document.tsx`,
`components/documents/templates/clinical-documents.tsx`, `lib/documents/clinical-copy.ts`,
`lib/documents/catalog.ts`, `lib/documents/assets.ts`, `lib/documents/verification-qr.ts`,
`lib/supabase/admin.ts` (`downloadClinicianSignatureAsset`), `components/documents/engine/styles.ts`,
`components/documents/primitives/signature-block.tsx`,
`components/documents/clinical-document-actions.tsx`,
`app/(protected)/documents/clinical/[document]/page.tsx`, `app/(public)/verify/[token]/page.tsx`,
and all P7-6 tests. Re-read the reused P7-0 `documents_select_scoped` RLS, the P7-0 issuance guard
(`lib/documents/issuance.ts`), and the P7-6A `can_access_clinical_record`. Inspected the approved
Figma variants for Prescription (AR `12:367`) and Lab Request (AR `17:496`) via Figma MCP.
Independently ran `tsc`, the four focused P7-6 unit/DB suites, and the headless-Chromium clinical PDF
render test.

Findings use stable IDs for the Claude→Codex handoff contract.

---

## Verdict summary

P7-6 faithfully unblocks the clinical batch against the persisted P7-6A source records and adds no
engine-core change — it is a pure set of slices (catalog entries + resolver + template + renderer +
copy + actions + reprint RPC + verify labels). The two-layer boundary holds end-to-end: the resolver
reads **only** finalized `prescriptions`/`lab_requests`/`sick_leaves` and their persisted line items
plus tenant/patient/physician/settings rows; it accepts no browser-authored content and never touches
`medical_notes` or appointments to synthesize clinical facts (the contract test explicitly asserts the
resolver string contains no `medical_notes`). The issued `params` payload carries only
`{version, documentType, recordId}` — no clinical content crosses the browser. The immutable snapshot
freezes the source record id, finalized clinical data, subject/external-subject identity, preparer
identity, clinic branding, and the responsible physician's credentials **and inlined signature data
URI**, so reprints and issued display stay faithful even if the profile later changes (issued display
parses the frozen `documents.snapshot`; reprint returns the stored PDF and re-resolves nothing).

The three types are registered correctly (RX/LAB/SL prefixes, `clinical` archetype,
Admin/Manager/Receptionist/Doctor/Assistant page roles, `/documents/clinical/*` routes). Controlled
medicines are detected from the persisted `is_controlled_snapshot` and blocked **before** reservation,
numbering, PDF, and issuance. Preview never consumes a number and renders a clearly labelled
non-issued preview QR; issued output uses the opaque verification token and canonical
`https://clinicflow.fit/verify/{token}`. Preview, browser print, issued display, and the Chromium PDF
share the same React template and `DOCUMENT_ENGINE_CSS`. The blank signature/stamp fallback renders on
all three types when no stored asset exists; both mandatory bilingual prescription validity statements
are present verbatim. Reprint is RLS/`can_access_clinical_record`-gated, increments `print_count`,
appends a `reprinted` event, and leaves the issue snapshot untouched (asserted by the live DB test).
Public verification exposes only the safe disclosure set and adds the three type labels; the page keeps
`noindex` + fail-closed rate limiting. No P7-7/P7-8/P7-11/P7-12 scope leaked (no `/documents/new`, no
Documents-module list, no Patient File redesign, no invoice/history/financial types).

Four non-blocking observations (O1–O4) remain; none is a correctness, security, or fidelity blocker.

**Verdict: APPROVED.**

---

## Required verifications

### 1. Only persisted P7-6A clinical records are used — ✅ PASS

`loadRecord` queries `prescriptions`/`lab_requests`/`sick_leaves` with `.eq("status","finalized")`
and rejects rows lacking `finalized_at`; line items come from `prescription_medications` /
`lab_request_tests`, ordered by `sort_order`. Subject identity is read from `patients` (registered) or
the frozen `subject_*` snapshot columns (external). Branding, settings, physician credentials, and
department are all read from persisted tenant tables via the RLS user client
([resolver L70-167](../../lib/documents/resolvers/clinical-document.ts#L70-L167)). Draft/void records
are unreachable for issue and preview.

### 2. No browser payload or medical-note synthesis — ✅ PASS

The action's issued `params` is `{version:1, documentType, recordId}` only
([actions L64-65](../../actions/clinical-documents.ts#L64-L65)); the full clinical content is resolved
server-side into the snapshot. The resolver imports nothing from notes/appointments for content; the
contract test asserts `resolver` does not contain `medical_notes`
([contract test L22](../../tests/unit/lib/p76-clinical-document-contract.test.ts#L22)). `appointment_id`
is snapshotted only to populate the `documents.appointment_id` link, not to derive content.

### 3. Registration of the three document types is correct — ✅ PASS

`DOCUMENT_CATALOG` registers `PRESCRIPTION` (RX), `LAB_REQUEST` (LAB), `SICK_LEAVE_CERTIFICATE` (SL),
each `archetype: "clinical"`, `pageRoles: SCOPED_OPERATIONAL_ROLES` (admin/manager/receptionist/
doctor/assistant), `subject: "patient"`, `verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE`, and a
`/documents/clinical/*` issuance trigger ([catalog L239-277](../../lib/documents/catalog.ts#L239-L277)).
The component test locks the prefixes, archetype, and role set.

### 4. Preview / issuance / snapshot / PDF / QR / verification / history / reprint follow the engine — ✅ PASS

- **Preview:** re-resolves live, renders `lifecycle="preview"` (DRAFT watermark, preview QR, no number),
  never issues ([page L49-62](../../app/(protected)/documents/clinical/[document]/page.tsx#L49-L62)).
- **Issuance:** re-resolves, blocks controlled meds, then calls `issueDocumentFoundation` with an
  idempotency key derived from the persisted record id
  ([actions L52-70](../../actions/clinical-documents.ts#L52-L70)); the P7-0 guard owns
  numbering/rollback and the renderer is passed as the render seam.
- **Immutable snapshot:** frozen into `documents.snapshot` at reserve; issued display parses the frozen
  snapshot ([actions L93](../../actions/clinical-documents.ts#L93)), reprint returns the stored PDF.
- **PDF:** `renderIssuedClinicalDocumentPdf` re-checks that the reservation type matches its snapshot,
  builds the same `ClinicalDocument` element through `renderDocumentPdf` (Chromium, JS off, requests
  aborted, fonts + QR inlined).
- **QR:** issued QR encodes the canonical `/verify/{token}` (opaque-token validated); preview QR
  encodes `/verify/preview` with a non-issued caption.
- **Verification:** `/verify/[token]` discloses only status/number/type/issueDate/clinicName, keeps
  `robots:{index:false}` + fail-closed rate limit, and adds the three clinical labels.
- **History:** issued display lists `document_events` with resolved actor names and `print_count`.
- **Reprint:** `record_clinical_document_reprint` is `security definer`, restricted to the three types
  and `can_access_clinical_record`, increments `print_count`, appends `reprinted`, mutates no snapshot;
  the live integration test asserts snapshot equality and event order `["issued","reprinted"]`.

### 5. Physician credentials and signature snapshots are immutable — ✅ PASS

Credentials (`fullName`, `professional_license_no`, `specialty`, `professional_title`, department) and
the signature (inlined as a base64 data URI) are frozen into the snapshot at issue
([resolver L151-154](../../lib/documents/resolvers/clinical-document.ts#L151-L154)). Issued display and
reprint consume the frozen snapshot / stored PDF, so later profile edits never alter an issued
document. The snapshot Zod schema is `version: z.literal(1)`, pinning the shape.

### 6. Blank signature/stamp fallback behaves correctly — ✅ PASS

The template always binds a `SignatureBlock` to the responsible physician and always passes a
`stampLabel`; `emptyLabel` is set to the localized "blank area for manual signature" only when
`signatureSrc` is null ([template L18-21](../../components/documents/templates/clinical-documents.tsx#L18-L21)).
All three bodies render `signature`. The component test asserts the blank label renders for every type;
the PDF test asserts the Arabic blank label in the rendered HTML. The stamp slot renders in both the
signed and unsigned cases (a manual stamp/seal area is always available).

### 7. Controlled medicines cannot be issued — ✅ PASS

`issueClinicalDocument` resolves the snapshot, then returns `controlledMedicineBlocked` if any
medication has `isControlled === true`, **before** `issueDocumentFoundation`
([actions L53-56](../../actions/clinical-documents.ts#L53-L56)). `isControlled` derives from the
P7-6A server-hydrated `is_controlled_snapshot` on the finalized, locked record, so it cannot be
downgraded by the client. Preview intentionally still renders (with the clinic-issued disclaimer), but
no number/PDF/issue is produced. No alternate issue path exists.

### 8. QR rendering and verification remain correct — ✅ PASS

`generateDocumentVerificationQrDataUrl` builds the canonical URL through `buildDocumentVerificationUrl`
(opaque-token regex enforced) at width 320 with a margin-4 quiet zone; the CSS `cf-doc-qr` renders it
on a white 96px surface with a divider border. Preview uses the distinct preview QR. The renderer and
both display paths encode the same token URL. Verification lookup is unchanged (P7-3 seam) and safe.

### 9. Header, footer, logo sizing, spacing, preview/PDF consistency — ✅ PASS

`DocumentHeader` renders only the tenant logo (data-URI-inlined from the clinic's own public bucket)
and falls back to the clinic-name initial — never a ClinicFlow logo. The clinic logo is 48px
([styles L159-162](../../components/documents/engine/styles.ts#L159-L162)) with 14px header gap
(L154). Signature image is height-restrained (`block-size:42px; inline-size:min(150px,100%)`), and the
QR spacing/quiet-zone refinements are in `cf-doc-verification`/`cf-doc-qr`. Preview, browser print, and
Chromium PDF all consume `DOCUMENT_ENGINE_CSS` and the same `ClinicalDocument` tree, so composition,
headers/footers, page-break rules, and Latin-digit formatting are identical across surfaces. Inspected
Figma Prescription `12:367` and Lab `17:496`: the implemented order (identity FieldGrid → SectionHeader
→ body → NotesCallout → VerificationBlock → SignatureBlock) matches the approved composition, with the
Stitch placeholder photo/QR correctly replaced by the generated QR per P7-2 cleanup. See **O1** on the
lab checklist grouping.

### 10. No P7-7 or later scope leaked — ✅ PASS

Grep across the P7-6 files finds no `/documents/new`, Documents-module list, Patient File redesign, or
`INVOICE`/`PACKAGE_HISTORY_REPORT`/`DEPOSIT_STATEMENT`/`APPOINTMENT_HISTORY_REPORT`/
`PATIENT_FINANCIAL_SUMMARY` work. The new route is only `/documents/clinical/[document]`. The catalog's
pre-existing non-clinical entries belong to prior phases (P7-0…P7-5), not P7-6. The reprint RPC
explicitly excludes `'INVOICE'` (asserted by the migration test).

### 11. Tests are meaningful and fail closed — ✅ PASS (see O4)

- **Contract test:** requires a UUID `recordId`, rejects a browser medications payload, pins snapshot
  `version === 1`, asserts the record-derived idempotency key, the controlled-medicine block, the
  `finalized`-only query, credential inlining, and the absence of `medical_notes`.
- **Component test:** asserts the exact primitive order per type, tenant-logo binding, real QR src, the
  blank-signature label, the verbatim bilingual validity note in Arabic preview, RTL direction, Latin
  digits (negative regex against Arabic-Indic glyphs), and the RX/LAB/SL prefixes + role set.
- **PDF render test:** headless Chromium round-trip producing a `%PDF-` artifact >10 KB with the tenant
  logo, real QR, Arabic validity note, and blank signature label in the HTML.
- **Migration test:** structural guard that reprint is limited to the three types, keeps
  `can_access_clinical_record`, is `security definer` with empty `search_path`, and contains no
  `delete`.
- **Live DB test:** proves reprint increments `print_count`, preserves the snapshot byte-for-byte, and
  orders events `["issued","reprinted"]`.

Negative paths return `errorCode`/`notFound`/empty rather than leaking. See **O4** on the two
string-match suites.

---

## Findings

### O1 — Observation · Lab checklist rendered as one flat group vs the design's category columns

The approved Lab Request design (`17:496`) groups requested tests into category panels (Hematology /
Biochemistry / Endocrinology). The template renders a single `ChecklistPanel` group of all
`lab_request_tests` ([template L71-74](../../components/documents/templates/clinical-documents.tsx#L71-L74)).
This is faithful to the persisted data model — P7-6A `lab_request_tests` carries no panel/category
field — so grouping cannot be reconstructed without synthesizing it, which the boundary forbids. The
per-test note is appended inline (`name — note`). Acceptable as data-honest; the category grouping is
sample categorization, not persisted structure. Flagged only so a future catalog-driven panel field
(if ever desired) is a conscious decision.

### O2 — Observation · Per-locale idempotency yields two issued documents per clinical record

The idempotency key is `clinical:<type>:<recordId>:<locale>`, so issuing the same finalized record in
both AR and EN produces two `documents` rows and consumes two numbers. This is the intended bilingual
behavior (each locale is a distinct immutable artifact), but a single clinical record can therefore
hold two issued documents. No regression to lifecycle/idempotency (each locale is idempotent on
retry). Worth a one-line note in the P7-8 module so history UIs group locales sensibly.

### O3 — Observation · Clinic logo inlining permits SVG (pre-existing P7-3 behavior)

`inlineClinicLogo` accepts `image/svg+xml` and inlines it as a data URI
([assets L5-9](../../lib/documents/assets.ts#L5-L9)). SVG can embed script, but the logo comes only from
the clinic's own public `clinic-assets/clinics/{clinicId}/` prefix, and the Chromium renderer disables
page JavaScript and aborts every non-`data:`/`about:` request, so no active content executes. The
clinician **signature** path is stricter (png/jpeg/webp only, 2 MB, path-prefix + `..` guarded). Not a
P7-6 regression; noted for completeness.

### O4 — Observation · Two P7-6 suites are structural string-matches

`p76-clinical-document-contract.test.ts` (second case) and `p76-clinical-document-migration.test.ts`
assert substrings in source/SQL files rather than behavior; they would not catch a semantically wrong
but string-matching change. The live DB integration test and the Chromium PDF test cover the important
behaviors, so this is redundancy, not a gap — consistent with the O3 note in the P7-6A review.

---

## Independent validation run

- `pnpm typecheck` (`tsc --noEmit`) — **clean**.
- `pnpm vitest run` on `p76-clinical-document-contract`, `p76-clinical-documents`,
  `p76-clinical-document-migration`, `p70-document-catalog` — **11 passed / 4 files**.
- `pnpm vitest run tests/unit/integration/p76-clinical-pdf-render.test.tsx` (headless Chromium) —
  **1 passed** (real `%PDF-` artifact, Arabic prescription, tenant logo, real QR, blank signature).
- Figma MCP inspection of Prescription `12:367` and Lab Request `17:496` — implemented hierarchy
  matches the approved composition; Stitch placeholder QR/photo correctly replaced by the generated QR.
- Live-Supabase reprint integration test (`p76-clinical-documents.test.ts`) not re-run here (requires a
  running local stack + secret keys); its assertions were read and judged meaningful and fail-closed
  (snapshot immutability + event order).

No production code was modified during this review. No commit was made.

---

**Verdict: APPROVED.**
