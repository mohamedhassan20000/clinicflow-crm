# P7-6 Clinical Documents — Implementation Report

**Status:** COMPLETE

**Branch:** `feat/p7-document-platform`

**Scope:** Prescription, Lab Request, and Sick Leave Certificate only

**Date:** 2026-08-02

## Outcome

P7-6 is implemented against the approved P7-6A persisted clinical-authoring records. The three
clinical document types are registered and now support server-resolved AR/EN preview, issuance,
immutable source snapshots, canonical PDF storage, QR verification, issued-document history, and
canonical reprint.

No P7-7 or later feature was implemented. No commit, push, branch switch, PR, or remote Supabase
schema operation was performed.

## Implemented functionality

### Catalog and source boundaries

- Registered `PRESCRIPTION`, `LAB_REQUEST`, and `SICK_LEAVE_CERTIFICATE` with the approved
  archetype, role scope, numbering prefixes (`RX`, `LAB`, `SL`), resolvers, renderers, and routes.
- Added a strict `{ documentType, recordId }` resolver contract. Resolvers query only finalized
  `prescriptions`, `lab_requests`, and `sick_leaves` plus their persisted line items and related
  tenant/patient/physician records. They do not accept browser-authored document content and do not
  synthesize clinical facts from medical notes.
- Preserved registered-patient and approved external-subject snapshots from P7-6A.

### Immutable clinical snapshots

- Added a versioned snapshot schema that freezes the source record ID, finalized clinical data,
  patient/external-subject identity, preparer identity, clinic branding/settings, responsible
  physician identity, professional title, specialty, department, professional licence, and optional
  signature asset.
- Added a reviewed service-role boundary for reading only the physician signature path already
  resolved through clinical RLS. The path is restricted to
  `staff/{clinicId}/{physicianId}/signature/*`; accepted images are size- and MIME-limited and are
  frozen as data URIs for canonical PDF rendering.
- A missing signature renders a clearly labelled manual-signature area and physician stamp/seal
  area on all three document types.

### AR/EN templates and rendering

- Added shared AR/EN clinical copy and production templates using only the frozen P7-1 primitives.
- Preserved the approved primitive hierarchy for each Figma variant:
  - Prescription: identity grid, medication table, validity/instruction callout, verification, signature/stamp.
  - Lab Request: identity grid, priority/laboratory fields, requested-test checklist, instructions/clinical context, verification, signature/stamp.
  - Sick Leave: identity grid, leave/certificate fields, certifying prose, restrictions, verification, signature/stamp.
- Every prescription render includes both mandatory validity statements exactly:
  - `لا تُعد هذه الوصفة الطبية معتمدة إلا بعد توقيع الطبيب أو ختمه أو كليهما.`
  - `This prescription is not considered valid unless signed, stamped, or both by the responsible physician.`
- Controlled medicines are detected from the persisted P7-6A medication snapshot and blocked before
  document reservation, numbering, PDF generation, or issuance.

### Preview, PDF, QR, verification, history, and reprint

- Added `/documents/clinical/[document]` for AR/EN draft preview and issued-document display.
- Preview, browser print, issued display, and generated PDF share the same React template and print
  stylesheet, preserving headers, footers, margins, spacing, page-break rules, and composition.
- Preview renders a real QR image clearly labelled as non-issued. Issued output uses the existing
  opaque verification token and canonical `https://clinicflow.fit/verify/{token}` behavior.
- Increased QR output resolution and quiet zone while preserving its encoded URL and verification
  semantics. The on-page QR was enlarged, given a white quiet-zone surface and stronger separation.
- Added verification labels for all three types on the public verification page.
- Added issued-document event history and canonical PDF reprint. Reprint returns the original stored
  PDF, increments `print_count`, and appends a `reprinted` event without mutating the issue snapshot.

### Visual refinements

- The document header renders only the tenant clinic's configured logo; it never substitutes a
  ClinicFlow logo. If no usable tenant logo exists, the established clinic-name initial fallback is
  used.
- Increased the clinic logo from 34 px to 48 px and increased spacing between the mark and clinic
  details from 8 px to 14 px.
- Added restrained signature-image sizing, blank-signature labelling, and QR spacing/alignment
  refinements without changing the approved Figma hierarchy.

## Migration

Added local migration:

- `supabase/migrations/20260802130000_p76_clinical_documents.sql`

It adds `record_clinical_document_reprint(uuid)`, restricted to the three P7-6 clinical document
types and to the existing P7-6A `can_access_clinical_record(...)` authorization boundary. The
migration was applied to the local Supabase instance for validation. It was **not** applied to the
remote Supabase project.

## Files changed for P7-6

### Application and document engine

- `actions/clinical-documents.ts`
- `app/(protected)/documents/clinical/[document]/page.tsx`
- `app/(public)/verify/[token]/page.tsx`
- `components/documents/clinical-document-actions.tsx`
- `components/documents/engine/styles.ts`
- `components/documents/primitives/signature-block.tsx`
- `components/documents/templates/clinical-documents.tsx`
- `lib/documents/assets.ts`
- `lib/documents/catalog.ts`
- `lib/documents/clinical-copy.ts`
- `lib/documents/renderers/clinical-document.tsx`
- `lib/documents/resolvers/clinical-document.ts`
- `lib/documents/verification-qr.ts`
- `lib/supabase/admin.ts`
- `messages/ar.json`
- `messages/en.json`
- `types/database.ts`

### Database and tests

- `supabase/migrations/20260802130000_p76_clinical_documents.sql`
- `tests/unit/components/p76-clinical-documents.test.tsx`
- `tests/unit/db/p76-clinical-document-migration.test.ts`
- `tests/unit/integration/p76-clinical-documents.test.ts`
- `tests/unit/integration/p76-clinical-pdf-render.test.tsx`
- `tests/unit/lib/p70-document-catalog.test.ts`
- `tests/unit/lib/p76-clinical-document-contract.test.ts`
- `docs/reports/P7-6_IMPLEMENTATION.md`

## Design verification

Figma MCP design context was inspected for all six approved P7-6 variants:

- Prescription: Arabic `12:367`, English `12:521`
- Sick Leave Certificate: Arabic `16:335`, English `14:187`
- Lab Request: Arabic `17:496`, English `17:736`

The implementation keeps their approved composition while treating all sample logos, patient data,
medicines, tests, signatures, stamps, and QR artwork as fixtures rather than production data.

## Validation results

- Branch verification: `feat/p7-document-platform`; passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with zero errors and 24 existing warnings outside P7-6.
- `pnpm lint:i18n`: passed; 383 files scanned, 41 documented exceptions.
- `pnpm lint:rtl`: passed; 559 files scanned, 10 documented exceptions.
- `pnpm i18n:missing`: passed; 3,596 base messages with valid locale parity.
- `pnpm test`: passed; 286 files, 2,098 tests.
- Focused P7-6 template/catalog/contract/migration tests: passed; 11 tests.
- Focused clinical PDF render test: passed; 1 test using headless Chromium.
- P7-6A + P7-6 local database integrations: passed; 2 files, 5 tests.
- Local migration application: passed; local database is up to date.
- `pnpm build`: passed; 75 routes generated, including `/documents/clinical/[document]` and
  `/verify/[token]`.
- `git diff --check`: passed.

The production build retains the existing Next.js middleware deprecation notice and the existing
Turbopack NFT trace warning from the shared PDF/font path. Neither warning originates in P7-6.

## Blockers and deviations

- Blockers: none.
- Functional deviations from the approved P7-6 scope: none.
- The Document Factory, contextual Patient File authoring/issuance links, invoice/delivery,
  settings expansion, hardening, and later history redesign remain deferred to their explicitly
  assigned phases.
