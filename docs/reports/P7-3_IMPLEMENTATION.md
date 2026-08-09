# P7-3 Implementation — Revenue Report vertical slice

**Date:** 2026-08-01  
**Branch:** `feat/p7-document-platform`  
**Scope:** P7-3 only — Revenue Report (01) end to end  
**Status:** Complete; not committed

## Outcome

P7-3 implements the first complete ClinicFlow Document Platform vertical slice. The existing
P7-0 persistence/lifecycle foundation and frozen P7-1 engine/primitives are reused; no P7-4+
document template, Documents module, or document-settings surface was added.

The Revenue page now opens a filter-preserving AR/EN draft preview. Drafts render the approved
Revenue Report structure with a DRAFT watermark and no allocated identity. Issuance resolves and
freezes clinic/report/settings data, delegates idempotent numbering/render/store/finalization to
the P7-0 foundation, and returns the issued immutable snapshot and canonical PDF. Issued documents
support history, canonical reprint, QR verification, and a rate-limited public verification page.

## Implemented functionality

- Revenue Report resolver reusing `getRevenueSummaryData`, with RLS-scoped transaction detail,
  clinic branding, locale formatting, and effective document settings.
- Issue-time snapshot schema (`version: 1`) containing the period, filters, branding, format,
  settings, aggregates, and transaction rows needed for faithful reprint.
- Safe issue-time logo inlining restricted to the clinic's own public `clinic-assets` path, allowed
  image MIME types, and a 5 MiB limit; invalid optional logos fall back to the engine identity mark.
- Layer-2 Revenue Report template using only the frozen primitive sequence:
  `StatCardRow → SectionHeader → DataTable → TotalsSummary → NotesCallout → VerificationBlock → SignatureBlock`.
- AR/EN template copy with RTL/LTR behavior and Latin-digit invariance.
- Contextual preview trigger on `/reports/revenue`, preserving date, doctor, and department filters.
- `/reports/revenue/document` draft and issued views, locale switching, issue action, canonical
  reprint action, and actor-attributed lifecycle history.
- Idempotent issuance through `issueDocumentFoundation`, including frozen number, watermark,
  snapshot, verification token, PDF storage, completion, and existing rollback/retry behavior.
- Public `/verify/[token]` lookup with strict 32-character lowercase hex validation, IP rate limit,
  enumeration-resistant unavailable behavior, and exactly five disclosed fields: status, document
  number, document type, issue date, and clinic name.
- Revenue-only reprint RPC that preserves document identity/snapshot/PDF, atomically increments
  `print_count`, and appends a `reprinted` event.

## Production-boundary fixes exercised by P7-3

P7-3 made the previously isolated P7-1 renderer reachable from a Server Action and from a live
desktop-Chrome roundtrip. Three narrow compatibility fixes were required without changing the
frozen engine or primitive contract:

- Replaced `react-dom/server` with React 19's static prerender API so Next.js permits the PDF helper
  in the Server Action graph.
- Kept Sparticuz launch flags for its serverless binary, but used minimal safe flags for an installed
  desktop Chrome build.
- Corrected print-selector specificity so the document root overrides the application-wide hidden
  state and is present in the generated PDF.

## Figma evidence

The Revenue Report nodes were read directly through Figma MCP from file
`nUzeFkN6Yn7m7knTzwmDHq`. Direct re-inspection confirmed Arabic at `8:262` and English at `8:18`.
The reversed locale mapping in the imported reference paths and P7-2 conformance record was
corrected as the required P7-3 review fix. This documentation-only correction does not change the
implementation, approved primitive mapping, or conformance gate result.

## Database changes

Migration `20260801130000_p73_revenue_document_slice.sql` adds only:

1. `verify_document_token(text)` — `SECURITY DEFINER`, anon/authenticated execute, strict token
   shape, issued/void/cancelled rows only, five-field projection.
2. `record_revenue_document_reprint(uuid)` — authenticated operational-role boundary, caller-clinic
   and `REVENUE_REPORT` scoped, canonical path return, count increment, history append.

The migration was applied successfully to the existing local Supabase stack. No remote database
was changed.

## Files changed for P7-3

### Product and lifecycle

- `actions/documents.ts`
- `app/(protected)/reports/revenue/page.tsx`
- `app/(protected)/reports/revenue/document/page.tsx`
- `app/(public)/verify/[token]/page.tsx`
- `components/documents/revenue-document-actions.tsx`
- `components/documents/templates/revenue-report.tsx`
- `lib/documents/assets.ts`
- `lib/documents/renderers/revenue-report.tsx`
- `lib/documents/resolvers/revenue-report.ts`
- `lib/documents/revenue-copy.ts`
- `lib/documents/verification.ts`
- `messages/en.json`
- `messages/ar.json`
- `types/database.ts`

### Reused renderer integration fixes

- `components/documents/engine/styles.ts`
- `lib/documents/pdf/html.tsx`
- `lib/documents/pdf/render.ts`
- `tests/unit/lib/p71-document-pdf.test.tsx`

### Migration and validation infrastructure

- `supabase/migrations/20260801130000_p73_revenue_document_slice.sql`
- `scripts/check-messages.mjs` (recognizes explicit-locale `getTranslations` calls)
- `tests/unit/setup.ts` (explicit-locale server translator mock)
- `tests/unit/components/p73-revenue-report-document.test.tsx`
- `tests/unit/db/p73-revenue-document-slice-migration.test.ts`
- `tests/unit/lib/p73-public-document-verification.test.ts`
- `tests/unit/lib/p73-revenue-document-contract.test.ts`
- `tests/unit/integration/p73-revenue-document-slice.test.ts`
- `tests/unit/integration/p73-revenue-pdf-render.test.tsx`
- `docs/reports/P7-3_IMPLEMENTATION.md`

## Validation results

| Validation | Result |
|---|---|
| Branch/worktree preflight | Pass — correct branch; existing dirty P7 work preserved |
| TypeScript (`pnpm typecheck`) | Pass |
| Focused ESLint on P7-3 files | Pass |
| Full ESLint (`pnpm lint`) | Pass with 24 pre-existing warnings and zero errors |
| RTL gate | Pass — 529 files, no undocumented physical-direction styles |
| Hardcoded-copy gate | Pass — 356 files, no unapproved user-facing strings |
| Message parity | Pass — 3,344 matching base leaves |
| Unused-message gate | Pass |
| Focused P7-1/P7-3 unit tests | Pass — 5 files, 13 tests |
| P7-3 Supabase integration | Pass — 2 tests (public verification and canonical reprint/history) |
| P7-0 lifecycle regression integration | Pass — 4 tests |
| Live Arabic Revenue PDF roundtrip | Pass — valid non-empty `%PDF-` output through production Chromium renderer |
| Local migration apply | Pass — PostgreSQL accepted `20260801130000` |
| Supabase DB lint | P7-3 functions clean; command reports unrelated pre-existing findings in older functions |
| Production build (`pnpm build`) | Pass — 74 pages; new preview and verification routes included |
| Whitespace check (`git diff --check`) | Pass |

Build output retains the repository's existing middleware-deprecation and broad NFT font-tracing
warnings. Supabase DB lint retains older findings in `search_patient_clinic_faq`,
`activate_whatsapp_provider`, and several unrelated legacy functions; neither P7-3 function was
reported.

## Blockers and deviations

- **Blockers:** none.
- **Scope deviations:** none. No P7-4+ document type or module/settings scope was implemented.
- **Resolved evidence discrepancy:** the reversed Revenue Report locale references were corrected
  to Arabic `8:262` and English `8:18`; this did not change the approved structure or implementation
  scope.
- No commit, push, branch switch, PR, remote migration, or review was performed.
