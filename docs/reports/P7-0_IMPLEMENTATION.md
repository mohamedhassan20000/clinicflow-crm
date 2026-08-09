# P7-0 — Document Platform Foundations — Implementation Report

**Date:** 2026-08-01  
**Plan reference:** `docs/designs/document-platform/analysis/13-implementation-roadmap.md` — P7-0  
**Scope:** P7-0 only. No review, commit, branch switch, push, merge, or later P7 phase work.

## 1. Outcome

P7-0 is implemented as the type-agnostic foundation for the approved 16-document
ClinicFlow platform. It adds tenant-safe document persistence, append-only lifecycle
events, atomic numbering, retry-safe issuance, private artifact storage, clinic
document-branding settings, locale-safe Latin-digit formatting, bidi isolation
helpers, and the initial typed document catalog.

No renderer, document layout primitive, template, data resolver, preview/download
route, verification endpoint, module page, or delivery integration was added. Those
remain owned by P7-1 and later phases.

The P7-0 review follow-up is complete. The storage read policy now extracts the
document ID from `storage.filename(name)`, and its live regression test proves that
an incomplete object is denied, an issued object is readable by its owning clinic,
and the same object is denied cross-clinic. The completion RPC also makes its
`reused` contract explicit without a dead write-path flag.

## 2. Data, security, and storage

Migration `20260801120000_p70_document_foundations.sql` adds:

- `documents`, with frozen issue-time branding/data snapshots, render state,
  verification token, deterministic storage path, idempotency key, and allocated
  number identity;
- `document_events`, as the append-only issuance lifecycle record;
- `document_counters`, as the per-clinic/per-type/per-period sequence source;
- `document_settings`, supporting clinic-wide defaults and per-document overrides;
- clinic branding fields for email, website, license number, tax/VAT identity,
  custom document footer, and a bounded extensible JSON metadata bag;
- the private `clinic-documents` bucket, restricted to clinic-scoped PDF reads and
  service-role writes.

All four new tables have RLS enabled. Authenticated reads are clinic-scoped, with
subject-level visibility applied to issued documents. Incomplete rendering and
failed rows are never exposed through authenticated document reads. Direct
authenticated document/event writes and counter mutation are denied; issuance is
performed through the service-only boundary. Branding mutations remain Admin-only,
including a database trigger that protects the new sensitive identity fields from
Manager writes.

Storage objects use the deterministic path
`documents/<clinic-id>/<doc_type>/<document-id>.pdf`. The read policy validates the
clinic folder, document type, filename document ID, canonical storage path, and
document ownership/state; upload validation permits PDF only with a 25 MB limit.

## 3. Numbering and idempotent issuance

`allocate_document_number` uses a locked upsert over the unique
clinic/type/period counter key, so concurrent calls allocate distinct monotonically
increasing values.

The issue guard is split into service-only reserve, complete, and fail operations:

1. `reserve_document_issue` takes a transaction-scoped advisory lock on the
   clinic/idempotency key, returns the original reservation for an identical retry,
   rejects conflicting reuse, and allocates the visible number exactly once.
2. Rendering/upload work runs against the persisted reservation and its frozen
   snapshots.
3. `complete_document_issue` atomically publishes the document and appends the
   lifecycle/audit records. Repeating completion is safe; its `reused` result is
   explicitly `false` for the publishing write and `true` only for an already-issued
   replay.
4. `fail_document_issue` marks the reservation failed without discarding its
   allocated identity. An identical retry reuses that same row and number. Failed
   artifacts are removed only when the failure transition actually succeeds, so an
   ambiguous response cannot delete an already-committed PDF.

This models render-failure rollback as rollback of publication and artifact state,
not reuse of a number that may already have appeared inside a rendered document.
It prevents partial issue, duplicate documents, and number drift across retries.

## 4. Branding settings

The existing Clinic Settings form now exposes the approved P7-0 identity fields in
English and Arabic:

- contact email and website;
- clinic license and tax/VAT identifiers;
- custom document footer;
- extensible branding metadata as validated JSON.

The fields use the existing settings action, validation, role, and localized-form
patterns. Empty optional values normalize to `null`; metadata is required to be a
plain JSON object and is size-bounded. No separate Documents Settings page was
created because that belongs to P7-9.

## 5. Shared document utilities and catalog

`lib/documents/format.ts` forces the `latn` numbering system for Arabic and English
document numbers, money, percentages, dates, times, and identifiers. It also
normalizes Arabic-Indic and Extended Arabic-Indic input digits to ASCII digits.

`lib/documents/bidi.ts` provides direction-aware props and Unicode isolation for
LTR atoms embedded in RTL copy.

`lib/documents/catalog.ts` defines the authoritative 16 document type codes and
typed catalog contracts. In keeping with the roadmap's “couple of entries” limit,
only Revenue Report and Invoice have skeleton entries. The initial configurable
numbering default is `<PREFIX>-<YYYY>-<4-digit sequence>` with yearly reset; no
house-specific prefix is hardcoded.

`lib/documents/issuance.ts` contains the renderer-independent orchestration guard.
`lib/supabase/admin.ts` supplies the narrowly scoped service wrappers for reservation,
completion, failure, upload, and cleanup. Rendering is deliberately injected and is
not implemented in P7-0.

## 6. Files changed for P7-0

### New

- `supabase/migrations/20260801120000_p70_document_foundations.sql`
- `lib/documents/bidi.ts`
- `lib/documents/catalog.ts`
- `lib/documents/format.ts`
- `lib/documents/issuance.ts`
- `tests/unit/db/p70-document-foundations-migration.test.ts`
- `tests/unit/integration/p70-document-foundations.test.ts`
- `tests/unit/lib/p70-clinic-branding-validation.test.ts`
- `tests/unit/lib/p70-document-catalog.test.ts`
- `tests/unit/lib/p70-document-format.test.ts`
- `tests/unit/lib/p70-document-issuance.test.ts`
- `docs/reports/P7-0_IMPLEMENTATION.md`

### Modified

- `actions/settings.ts`
- `app/(protected)/settings/clinic/page.tsx`
- `components/settings/clinic-form.tsx`
- `lib/supabase/admin.ts`
- `lib/validations/settings.ts`
- `messages/en.json`
- `messages/ar.json`
- `types/database.ts`

The pre-existing modifications to `docs/AI_AGENT_PLAN.md` and
`docs/documents/README.md`, plus the pre-existing untracked `docs/designs/` tree,
were treated as baseline inputs and preserved.

## 7. Validation

| Check | Result |
|---|---|
| P7-0 migration | Applied successfully to local Supabase |
| Focused P7-0 unit/static suite | 5 files / 18 tests passed |
| Live P7-0 Supabase integration | 1 file / 4 tests passed |
| Full non-integration suite | 266 files / 2,016 tests passed |
| TypeScript | `pnpm typecheck` — pass |
| ESLint | `pnpm lint` — pass with 24 pre-existing warnings, 0 errors |
| RTL logical-property gate | `pnpm lint:rtl` — pass; 489 files scanned |
| Hardcoded i18n copy gate | `pnpm lint:i18n` — pass; 325 files scanned |
| EN/AR message parity | `pnpm i18n:missing` — pass; 3,260 base leaf messages |
| Production build | `pnpm build` — pass |
| Diff whitespace | `git diff --check` — pass |

The live database tests cover concurrent duplicate issuance, a single counter
allocation, failed-render invisibility, retry/finalization with the same document
number, document/event tenant isolation, lifecycle event ordering, completion replay
semantics, storage denial before issuance, own-clinic storage reads after issuance,
cross-clinic storage denial, and rejection of Manager/cross-tenant branding writes.

Supabase's schema linter completed and found no P7-0 migration issue. It continues
to report two unrelated pre-existing errors in `search_patient_clinic_faq` and
`activate_whatsapp_provider`.

## 8. Phase boundary

P7-1 through P7-10 were not started. In particular, this implementation does not
include `DocumentPage`, engine layout primitives, Chromium/PDF rendering, font
embedding, QR generation, design-conformance sheets, any of the 16 templates or
their resolvers, invoice delivery wiring, the Documents module, document settings
UI, verification routes, or hardening/load work.

The branch remains `feat/p7-document-platform`. No commit was created.
