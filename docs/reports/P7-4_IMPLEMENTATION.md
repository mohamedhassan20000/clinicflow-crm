# P7-4 Implementation — Analytical document batch

**Date:** 2026-08-01  
**Branch:** `feat/p7-document-platform`  
**Scope:** P7-4 only — documents 02 and 08–13  
**Status:** Complete; not committed

## Outcome

P7-4 completes the approved remaining analytical batch on the existing P7-0 through P7-3
Document Platform. The batch adds Follow-up Page, Cancellation, No-show, Sales, Follow-up
Analytics, Doctor Performance, and Receptionist Performance as previewable, issuable, immutable,
verifiable AR/EN documents. Together with the approved P7-3 Revenue Report, all eight analytical
documents in the 16-document catalog are now implemented.

The implementation reuses the frozen document engine and primitive contract, the P7-0 idempotent
issuance foundation, catalog numbering, snapshot lifecycle, Chromium PDF renderer, canonical
storage/reprint behavior, QR verification, history, branding, and document settings. No primitive
or engine-contract change was required, and no P7-5+ document or Documents module/settings scope
was added.

## Implemented functionality

- Registered the seven approved P7-4 catalog entries with frozen prefixes `FU`, `CR`, `NS`, `SAL`,
  `FUA`, `DPF`, and `RPF`, their owning-surface roles, filters, resolvers, templates, verification
  disclosure, and contextual triggers.
- Added one versioned, discriminated analytical snapshot contract shared by the batch, preserving
  the resolved period, filters, branding, locale format, settings, and type-specific factual data.
- Reused the existing report data layer for Follow-up Page, Cancellation, No-show, Doctor
  Performance, and Receptionist Performance.
- Added the two roadmap-required net-new RLS-scoped data pipelines:
  - Sales uses completed paid appointments and outstanding settlements within the collection
    period, with explicit component totals, outstanding balance, transaction counts, settlement
    counts, and payment-method aggregation.
  - Follow-up Analytics uses recorded follow-up outcomes joined to appointments, with
    appointment-scheduled period semantics, optional doctor scope, outcome counts, and calculated
    rates.
- Added thin Layer-2 templates for all seven designs using only approved primitives and their
  approved order. Wide tables and share bars remain ordinary `DataTable` variants/content, so the
  P7-1 primitive contract stays unchanged.
- Added AR/EN analytical copy, RTL/LTR layout, Thmanyah/Manrope typography through the existing
  engine, and Latin-digit-only document formatting.
- Added contextual, filter-preserving preview actions to the five existing report pages and report
  index cards for the two net-new Sales and Follow-up Analytics document surfaces.
- Added the shared `/reports/[report]/document` draft/issued flow: locale switching, draft print,
  issue, issued snapshot display, canonical reprint, and actor-attributed lifecycle history.
- Routed issue through `issueDocumentFoundation` for idempotent number reservation, frozen
  snapshot/settings, QR token, PDF render/store/finalize, and the existing retry/rollback behavior.
- Extended public verification presentation for all seven document types while preserving the
  existing five-field disclosure boundary and opaque-token lookup.
- Added a batch-scoped canonical reprint transaction that checks clinic, document type, status,
  and role; increments `print_count`; and appends a `reprinted` history event.

## Figma evidence and conformance

The implementation was checked directly through Figma MCP against the approved source file
`nUzeFkN6Yn7m7knTzwmDHq` at these locale nodes:

| Document | Arabic | English |
|---|---:|---:|
| 02 Follow-up Page | `11:638` | `11:507` |
| 08 Cancellation | `18:1168` | `18:956` |
| 09 No-show | `19:1381` | `19:1552` |
| 10 Sales | `19:1718` | `19:1882` |
| 11 Follow-up Analytics | `20:2232` | `20:2074` |
| 12 Doctor Performance | `20:2398` | `20:2595` |
| 13 Receptionist Performance | `21:2783` | `21:2934` |

The approved hierarchy, section sequence, metric grouping, table structure, verification/signature
placement, and bilingual direction were preserved. Production polish was limited to consistent
engine spacing, alignment, padding, borders, subtle opacity, table density, and QR presentation;
no document was redesigned.

Focused DOM conformance tests assert each template's direct primitive order. Issued Arabic cases
also assert RTL direction, Latin digits, document identity, and a real QR image slot.

## Database changes and data-honesty boundary

Migration `20260801140000_p74_analytical_document_batch.sql` adds only:

1. `get_document_sales_report(timestamptz, timestamptz)` — `SECURITY INVOKER`, explicit financial
   report roles, caller-clinic filtering, completed/paid collection-period semantics, and existing
   table RLS.
2. `get_document_follow_up_analytics_report(timestamptz, timestamptz, uuid)` — `SECURITY INVOKER`,
   explicit operational roles, caller-clinic and optional doctor filtering, appointment-period
   semantics, and existing appointment/follow-up RLS.
3. `record_analytical_document_reprint(uuid)` — `SECURITY DEFINER`, caller-clinic/type/status/role
   checks, immutable canonical-path return, print-count increment, and history append.

The migration was applied successfully to the local Supabase stack. Live fixtures verified Sales
totals, role denial, tenant isolation, Follow-up Analytics doctor/tenant scope, and canonical
reprint history. No remote database was changed.

## Files changed for P7-4

### Product, lifecycle, and surfaces

- `actions/documents.ts`
- `app/(protected)/reports/[report]/document/page.tsx`
- `app/(protected)/reports/page.tsx`
- `app/(protected)/reports/follow-ups/page.tsx`
- `app/(protected)/reports/cancellations/page.tsx`
- `app/(protected)/reports/no-shows/page.tsx`
- `app/(protected)/reports/doctors/page.tsx`
- `app/(protected)/reports/receptionists/page.tsx`
- `app/(public)/verify/[token]/page.tsx`
- `components/documents/analytical-document-actions.tsx`
- `components/documents/templates/analytical-reports.tsx`
- `components/reports/reports-index.tsx`
- `lib/documents/analytical-copy.ts`
- `lib/documents/catalog.ts`
- `lib/documents/renderers/analytical-report.tsx`
- `lib/documents/resolvers/analytical-report.ts`
- `messages/en.json`
- `messages/ar.json`
- `types/database.ts`

### Database, tests, and report

- `supabase/migrations/20260801140000_p74_analytical_document_batch.sql`
- `tests/unit/components/p74-analytical-documents.test.tsx`
- `tests/unit/db/p74-analytical-document-batch-migration.test.ts`
- `tests/unit/integration/p74-analytical-document-batch.test.ts`
- `tests/unit/lib/p70-document-catalog.test.ts`
- `tests/unit/lib/p74-analytical-document-contract.test.ts`
- `docs/reports/P7-4_IMPLEMENTATION.md`

## Validation results

| Validation | Result |
|---|---|
| Branch/worktree preflight | Pass — correct branch; existing dirty P7 work preserved |
| Figma MCP inspection | Pass — all 14 approved AR/EN P7-4 nodes read directly |
| TypeScript (`pnpm typecheck`) | Pass |
| Focused ESLint on P7-4 files | Pass |
| Full ESLint (`pnpm lint`) | Pass with 24 pre-existing warnings and zero errors |
| RTL gate (`pnpm lint:rtl`) | Pass — 535 files; no undocumented physical-direction styles |
| Hardcoded-copy gate (`pnpm lint:i18n`) | Pass — 359 files; no unapproved user-facing strings |
| Message parity (`pnpm i18n:missing`) | Pass — 3,487 matching base leaf messages |
| Unused-message gate (`pnpm i18n:unused`) | Pass |
| Focused P7-4 tests | Pass — 4 files, 23 tests |
| P7-0 through P7-4 document regression set | Pass — 16 files, 66 tests |
| Full non-integration unit suite (`pnpm test`) | Pass — 278 files, 2,067 tests |
| P7-4 live Supabase integration | Pass — 4 tests |
| Local migration apply | Pass — PostgreSQL accepted `20260801140000` |
| Supabase DB lint | P7-4 functions clean; command reports two unrelated pre-existing function errors |
| Production build (`pnpm build`) | Pass — 74 pages; dynamic analytical route included |
| Whitespace check (`git diff --check`) | Pass |

The production build retains the repository's existing middleware-deprecation and broad NFT font
tracing warnings. The first sandboxed build attempt could not fetch the existing Google Manrope
stylesheet; the approved network-enabled retry passed. Supabase DB lint still reports unrelated
legacy errors in `search_patient_clinic_faq` and `activate_whatsapp_provider`; none of the P7-4
functions were reported.

## Blockers and deviations

- **Blockers:** none.
- **Scope deviations:** none. No P7-5+ catalog entry, template, roster/profile/clinical/financial
  document, Documents module, document-settings UI, delivery flow, or hardening-phase scope was
  implemented.
- **Design deviations:** none. Only the requested minor production-quality visual refinements were
  applied within the approved Figma structure.
- No review, commit, push, branch switch, PR, or remote migration was performed.
