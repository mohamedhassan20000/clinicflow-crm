# P7-9 Documents Settings — Implementation Report

**Status:** COMPLETE

**Branch:** `feat/p7-document-platform`

**Date:** 2026-08-03

**Scope:** The complete Document Settings module (roadmap doc 13 P7-9; design doc 09; doc 16 §11
sub-phase ownership). A **thin settings UI over existing services**: the P7-0 `document_settings`
resolution model, existing RBAC (`isPrimaryClinicAdmin` + `requireMutationRole`), the P7-6A clinical
catalogs / clinician credentials, and the existing clinic-branding fields. **No new document engine
features, no new document types, no new patient workflow, no new clinical-authoring functionality, no
new business rules.** No P7-10 (Hardening) work.

## Outcome

`/settings/documents` (primary-admin gated) is the central Documents Settings hub. It lets the primary
clinic admin configure the P7-0 `document_settings` resolution layer per document type and globally, and
surfaces clinic readiness for issuing documents (branding, clinician credentials, reference catalogs)
with deep links to the surfaces that already own each field. Every setting maps to an item in the
approved P7 architecture (doc 09); nothing outside it was invented.

The module is **catalog-driven**: the per-type table iterates the frozen `DOCUMENT_CATALOG`, so a new
document type appears here automatically with **no configuration and no migration** — exactly the doc 09
§2 extensibility contract. Resolution order (per-type override → clinic global default → catalog default)
is re-stated for the settings preview but **the at-issue authority remains the resolvers**; no issuance
business logic is duplicated.

## What P7-9 configures (mapped to doc 09 / the requested scope)

- **Document numbering configuration (doc 09 §1.2).** Editable per-type / global numbering **prefix**
  (`^[A-Z][A-Z0-9-]{0,15}$`, future-allocations-only; the UI states this) and a **yearly-reset** toggle.
  The current prefix, padding, and **live next sequence** per type are displayed read-only.
- **Per-document enable/disable (doc 09 §1.1, §1.3).** Per-type **watermark** enable/disable **+** custom
  text (empty ⇒ clinic name) and per-type **QR / verification** enable/disable, plus a **global default**
  row that every un-overridden type inherits.
- **Branding configuration + header/footer (doc 09 §1.5).** A branding-completeness checklist (name,
  logo, address, phone, email, website, license, **tax/VAT**, custom **document footer**) surfaced here
  and **edited in Clinic Settings** (not duplicated); a missing tax/VAT identifier is flagged before an
  Invoice ("Tax Invoice") is issued.
- **Default signature/stamp presentation (doc 16 §6).** The clinician-credential readiness card shows,
  per active physician, whether a **license** and a **signature/stamp** are stored, and restates the
  mandatory manual-signature fallback; editing links to Staff Settings.
- **Verification behavior configuration (doc 09 §1.3).** The per-type QR toggle plus the read-only
  verification base URL (`clinicflow.fit/verify`) the mark resolves to.
- **Default print options (doc 09 §1.4).** Per-type **include-attachments default** (only exposed for the
  attachment-supporting Patient/Staff File types), stored in the additive `print_options` JSON bag.
- **Drug + lab-test catalog management, department assignment (P7-6A).** Reused, not rebuilt: the
  readiness card reports active/total counts and deep-links to the existing `/settings/clinical` surface
  (`components/clinical/catalog-settings.tsx` + `actions/clinical/catalogs.ts`), which already owns
  department scoping.
- **Clinician credential management + completeness indicators (P7-6A + doc 09 §1.5).** Reused: editing is
  the existing `ClinicianCredentialsForm` in Staff Settings; P7-9 adds the **completeness/status
  indicators**.
- **Settings navigation integration.** A primary-admin-only **Documents** tab in `SettingsNav`.

### Deliberately not implemented (out of the approved architecture)

- **Document retention / archival settings** — the requested scope qualifies this with "if defined";
  it is **not defined** anywhere in doc 09 or doc 16, so no retention/archival business rule was invented
  (that would be a new business rule, explicitly out of scope).
- Editing an already-issued document's number/watermark/data (issued documents are immutable, doc 05 §4;
  doc 09 §4). Settings affect **future issuance only**.
- Counter reset/rewind (doc 09 §1.2 / §11 — would risk number reuse).

## Reuse & preservation (no duplicated business logic)

- **RBAC reused verbatim.** Reads and writes are gated by `requireRole("admin")` /
  `requireMutationRole("admin")` **+** `isPrimaryClinicAdmin` — the identical primary-admin authority used
  by `report-permissions` / `page-permissions` / assistant-launcher settings. The page redirects a
  secondary admin to `/dashboard`; the nav hides the tab.
- **RLS + tenant isolation preserved.** The write path is the authenticated **primary admin's own
  session** (RLS), mirroring the P4.9A assistant-launcher precedent. A new migration adds the single
  `document_settings_manage_primary_admin` policy (`for all`, reusing the existing DB
  `is_primary_clinic_admin()` authority; `with check` also pins `updated_by = auth.uid()` for
  self-attribution). Reads go through the existing `document_settings_select_clinic` policy. Numbering
  counters stay **server-only** (no authenticated policy added); the numbering view reads them through one
  reviewed, metadata-only `loadClinicDocumentCounters` helper (sequence numbers only — no PHI/financial
  data) behind the primary-admin gate.
- **Immutable-document behavior preserved.** No settings write touches `documents`, counters, or issued
  snapshots; settings are consumed by resolvers only at the next issuance.
- **No engine change.** No catalog entry, template, renderer, or resolver was modified. `settings-config.ts`
  is a pure display-layer re-statement of the existing resolution order.

## Files changed for P7-9

### New

- `supabase/migrations/20260803120000_p79_document_settings_write.sql` — authenticated primary-admin
  write policy for `document_settings` (grant + `for all` RLS policy; reuses `is_primary_clinic_admin`).
- `lib/documents/settings-config.ts` — pure settings shapes, defaults, and the display-layer effective
  resolution (per-type → global → catalog).
- `lib/validations/documents-settings.ts` — zod contract mirroring the P7-0 column constraints
  (watermark length, prefix format, strict print options, registered-type guard).
- `actions/documents-settings.ts` — `getDocumentSettingsOverview` (primary-admin read of branding /
  per-type settings + live next-seq / clinician & catalog readiness), `saveDocumentSettings` (upsert one
  global/per-type row), `resetDocumentSettings` (delete → fall back to defaults).
- `app/(protected)/settings/documents/page.tsx` — primary-admin-gated page composing the readiness cards
  and the interactive per-type manager.
- `components/settings/document-type-settings-manager.tsx` — client per-type table + edit sheet
  (watermark/QR/prefix/yearly-reset/attachments) with save + reset.
- `components/settings/documents-readiness-cards.tsx` — server-rendered branding / clinician / catalog
  completeness cards with deep links to the owning surfaces.
- `tests/unit/lib/p79-document-settings-config.test.ts` — resolution order, catalog coverage, and the zod
  contract (invalid prefix/type/watermark/print-option guards).
- `tests/unit/actions/p79-documents-settings.test.ts` — settings permission tests: primary-admin gate on
  read/save/reset, RLS-client self-attributed writes (`clinic_id` + `updated_by`), insert-vs-update,
  exact-row delete, and pre-auth validation rejection.
- `docs/reports/P7-9_IMPLEMENTATION.md` — this report.

### Modified

- `lib/supabase/admin.ts` — added the reviewed metadata-only `loadClinicDocumentCounters` helper for the
  numbering view.
- `components/settings/settings-nav.tsx` — primary-admin-only **Documents** tab.
- `messages/en.json`, `messages/ar.json` — `documents.settings.*` namespace + `settings.navDocuments`.
- `tests/unit/components/settings-nav.test.tsx` — Documents-tab visibility + page/action primary-admin
  boundary assertions.

## Validation results

- `pnpm exec tsc --noEmit` — **passed** (exit 0).
- `pnpm exec eslint` on all new/changed files — **passed** (0 errors).
- `pnpm lint:i18n` — **passed** (411 files, 41 documented exceptions; no new exceptions).
- `pnpm lint:rtl` — **passed** (596 files, 10 documented exceptions).
- `node scripts/check-messages.mjs` — **passed** (3,826 leaf messages; no unused keys).
- `node scripts/check-messages.mjs missing` — **passed** (valid AR/EN parity).
- `pnpm test` (unit, integration excluded by project script) — **passed** (297 files, 2,180 tests;
  +2 files / +25 tests from P7-9).
- `pnpm build` — **passed**; new route generated: `/settings/documents`.
- **Settings permission tests** — included in `p79-documents-settings.test.ts` and the settings-nav suite
  (primary-admin gate, secondary-admin denial with no write, self-attribution, exact-row scoping).
- **Integration (live local Supabase, rolled back):** the P7-9 migration **compiles cleanly** against the
  running local schema (GRANT + policy create; both `document_settings` policies present after apply), and
  a **functional RLS test against real seeded rows** proved the write path end-to-end:
  - primary admin, `updated_by = auth.uid()` → insert **SUCCEEDS**;
  - primary admin, `updated_by ≠ auth.uid()` → **DENIED** (`with check`);
  - non-primary clinic member → **DENIED** (`using`).
  All executed in a rolled-back transaction; no persistent local change.

## Blockers and deviations

- **Blockers:** none.
- **Deviations:**
  1. **Migration authored + locally compile/RLS-validated, not applied to remote** — consistent with the
     P7-11/P7-12 "no remote Supabase operation" posture. Applying `20260803120000` (and the other pending
     P7 migrations) to the remote remains a DB-connected deploy step.
  2. **Next-sequence read via a reviewed service helper** rather than a new authenticated counter policy —
     preserves the P7-0 decision to keep `document_counters` server-only (no RLS widening), while still
     delivering the doc 09 §1.2 numbering view. Gated by primary-admin; metadata-only.
  3. **Retention/archival deliberately omitted** (see above) — not defined in the approved architecture.
- **Deferred to its phase:** P7-10 Hardening (authorization matrix tests across every type, verification
  rate-limit/enumeration, PDF fidelity regression, storage retention, etc.).

## Review handoff

Not performed (per instructions). A review should write `docs/reviews/P7-9_REVIEW.md` per the
review-file workflow. No commit, push, branch switch, or PR was performed; all existing P7 working-tree
changes were preserved.
