# P7-5 Implementation — Roster and profile document batch

**Date:** 2026-08-01  
**Branch:** `feat/p7-document-platform`  
**Scope:** P7-5 only — documents 03, 04, 14, and 15  
**Status:** Complete; not committed

## Outcome

P7-5 implements the approved Patient List, Patient File, System Members, and Staff File batch on
the existing P7-0 through P7-4 Document Platform. All four documents are previewable and issuable
in Arabic and English, use immutable issue-time snapshots, inherit document settings and
numbering, expose opaque-token QR verification, retain lifecycle history, and reprint the stored
canonical PDF.

Patient File and Staff File additionally support optional issue-time selection of their existing
stored documents. Selected PDF, JPEG, PNG, and WebP sources are appended to the generated profile
with `pdf-lib`; WebP is normalized through the existing server image stack. The merged bytes are
stored as the canonical document artifact, so later deletion or replacement of a source attachment
cannot change a reprint.

No document-engine or frozen primitive-contract change was required. No P7-6+ clinical,
financial, Documents-module, settings, delivery, or hardening scope was implemented.

## Implemented functionality

- Registered exactly the four P7-5 catalog entries with approved roster/profile archetypes,
  prefixes `PL`, `PF`, `SM`, and `SF`, owning-surface roles, filters, subjects, resolvers,
  templates, verification disclosure, and contextual triggers.
- Added a versioned discriminated snapshot contract for:
  - active Patient List rows grouped by department, with doctor and search filtering and enforced
    doctor department scope;
  - Patient File identity, registration, demographic, department, doctor, insurance, status, and
    optional inlined avatar data;
  - active System Members grouped by department with role, joined date, and status;
  - Staff File identity/employment fields, optional inlined photo, and weekly schedule totals.
- Added four thin template variants using only the frozen primitive hierarchy:
  - Patient List: `GroupedTables → StatusBadge → VerificationBlock → SignatureBlock`;
  - Patient File: `IdentityHero → SectionHeader → FieldGrid → StatusBadge → VerificationBlock → SignatureBlock`;
  - System Members: `FieldGrid → GroupedTables → StatusBadge → NotesCallout → VerificationBlock`;
  - Staff File: `SectionHeader → IdentityHero → FieldGrid → StatusBadge → DataTable → TotalsSummary → NotesCallout → SignatureBlock → VerificationBlock`.
- Added contextual entry points on the Patient List, Patient detail, System Staff settings, and
  staff-row menu. The shared contextual route supports draft/issued presentation, locale switching,
  draft print, issue, canonical reprint, and actor-attributed history without adding a central
  Documents module.
- Reused `issueDocumentFoundation` for idempotent reservation, immutable number and settings
  snapshots, QR token, Chromium render, canonical storage, completion, and failure handling.
- Extended the public verification presentation for all four types while preserving the existing
  five-field disclosure boundary.
- Added the P7-5 canonical reprint transaction with clinic, document-type, lifecycle-status, and
  role checks; atomic print-count increment; and `reprinted` history event.

## Optional attachment merge boundary

- Attachments are opt-in and default to none.
- Patient sources reuse active `patient_documents` metadata and the `patient-assets` bucket.
- Staff sources reuse contract, certificate, and other files below the existing clinic/staff
  `clinic-assets` path. Existing Word files remain stored and usable elsewhere but are not offered
  for merge because they are outside the approved PDF/JPEG/PNG/WebP source set.
- Selection is revalidated at issue time against the current tenant, subject/path, active metadata,
  MIME type, and recorded size.
- Limits are 10 selected sources, 25 MiB combined source bytes, 10 MiB per existing source file,
  and 100 pages in the final merged PDF.
- PDF pages are copied without re-rendering. JPEG is embedded directly; PNG and WebP are normalized
  and fitted inside an A4 page with consistent margins.
- The merged artifact is finalized through the existing lifecycle and stored once in
  `clinic-documents`; reprints never read the original sources.

## Figma evidence and conformance

The implementation was checked directly through Figma MCP against approved file
`nUzeFkN6Yn7m7knTzwmDHq` at all eight P7-5 locale nodes:

| Document | Arabic | English |
|---|---:|---:|
| 03 Patient List | `11:1121` | `11:814` |
| 04 Patient File | `12:19` | `12:192` |
| 14 System Members | `22:3305` | `22:3081` |
| 15 Staff File | `23:3517` | `23:3734` |

The approved hierarchy, department grouping, identity treatment, field layout, schedule table,
weekly total, signatures, QR placement, and bilingual mirroring are preserved. Production polish
is limited to the shared engine's spacing, alignment, margins, padding, subtle borders/opacity,
table density, image fitting, and QR presentation. No document was redesigned.

## Database changes

Migration `20260801150000_p75_roster_profile_document_batch.sql` adds only
`record_roster_profile_document_reprint(uuid)`. It is `SECURITY DEFINER` with an empty search path,
authenticates the caller, restricts the row to the caller clinic and four P7-5 document types,
applies admin/manager scope to staff documents and scoped operational roles to patient documents,
requires an issued/void/cancelled canonical artifact, increments `print_count`, and appends history.

The migration was applied successfully to the local Supabase stack. No remote database was
changed. Supabase database lint reports no P7-5 function finding; it retains unrelated existing
errors in `search_patient_clinic_faq` and `activate_whatsapp_provider` plus existing warnings.

## Files changed for P7-5

### Product, lifecycle, and surfaces

- `actions/documents.ts`
- `app/(protected)/documents/roster-profile/[document]/page.tsx`
- `app/(protected)/patients/page.tsx`
- `app/(protected)/patients/[id]/page.tsx`
- `app/(protected)/settings/staff/page.tsx`
- `app/(public)/verify/[token]/page.tsx`
- `components/documents/document-trigger-label.tsx`
- `components/documents/roster-profile-document-actions.tsx`
- `components/documents/templates/roster-profile-documents.tsx`
- `components/settings/staff-table.tsx`
- `lib/documents/catalog.ts`
- `lib/documents/pdf/merge-attachments.ts`
- `lib/documents/renderers/roster-profile.tsx`
- `lib/documents/resolvers/roster-profile.ts`
- `lib/documents/roster-profile-copy.ts`
- `messages/en.json`
- `messages/ar.json`
- `package.json`
- `pnpm-lock.yaml`
- `types/database.ts`

### Database, tests, and report

- `supabase/migrations/20260801150000_p75_roster_profile_document_batch.sql`
- `tests/unit/components/p75-roster-profile-documents.test.tsx`
- `tests/unit/db/p75-roster-profile-document-batch-migration.test.ts`
- `tests/unit/lib/p70-document-catalog.test.ts`
- `tests/unit/lib/p75-pdf-attachment-merge.test.ts`
- `docs/reports/P7-5_IMPLEMENTATION.md`

## Validation results

| Validation | Result |
|---|---|
| Branch/worktree preflight | Pass — correct branch; existing dirty P7 work preserved |
| Figma MCP inspection | Pass — all 8 approved AR/EN P7-5 nodes read directly |
| TypeScript (`pnpm typecheck`) | Pass |
| Focused ESLint on P7-5 files | Pass |
| Full ESLint (`pnpm lint`) | Pass with 24 pre-existing warnings and zero errors |
| RTL gate (`pnpm lint:rtl`) | Pass — 543 files; no undocumented physical-direction styles |
| Hardcoded-copy gate (`pnpm lint:i18n`) | Pass — 363 files; no unapproved user-facing strings |
| Message parity (`pnpm i18n:missing`) | Pass — 3,500 matching base leaf messages |
| Unused-message gate (`pnpm i18n:unused`) | Pass |
| Focused P7-5 tests | Pass — 4 files, 16 tests |
| P7-0 through P7-5 document regression set | Pass — 17 files, 72 tests |
| Full non-integration unit suite (`pnpm test`) | Pass — 281 files, 2,080 tests |
| Local migration apply | Pass — PostgreSQL accepted `20260801150000` |
| Supabase DB lint | P7-5 function clean; unrelated existing findings remain |
| Production build (`pnpm build`) | Pass — 74 pages; dynamic roster/profile route included |
| Whitespace check (`git diff --check`) | Pass |

The production build retains the repository's existing middleware-deprecation and broad NFT
tracing warning. The local Supabase CLI also reports that a newer CLI version is available; this
does not affect P7-5 validation.

## Blockers and deviations

- **Blockers:** none.
- **Scope deviations:** none. No P7-6+ document, central Documents module, document-settings UI,
  delivery workflow, or hardening-phase scope was added.
- **Design deviations:** none. Only the requested minor production-quality refinement was applied
  within the approved Figma hierarchy.
- Word staff sources are deliberately excluded from selection because the approved merge contract
  is PDF/JPEG/PNG/WebP; no stored source was altered.
- No review, commit, push, branch switch, PR, or remote migration was performed.
