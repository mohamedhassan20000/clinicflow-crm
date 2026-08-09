# P7-9 Review — Documents Settings

**Reviewer:** Claude (independent review)
**Date:** 2026-08-03
**Branch:** `feat/p7-document-platform`
**Scope reviewed:** P7-9 — the Documents Settings module (roadmap doc 13 P7-9; design doc 09; doc 16 §11
sub-phase ownership): `/settings/documents`, `document_settings` CRUD (primary-admin), per-type/global
resolution preview, branding + clinician-credential + drug/lab-catalog readiness surfacing, and the
authenticated write policy migration.

**Method:** Read the authoritative plan (`AI_AGENT_PLAN.md`), the roadmap (doc 13 P7-9), doc 16 (§4/§6/§11),
the P7-9 implementation report, and the APPROVED P7-12 review. Read every P7-9 file: the migration
(`20260803120000_p79_document_settings_write.sql`), `lib/documents/settings-config.ts`,
`lib/validations/documents-settings.ts`, `actions/documents-settings.ts`, the page
(`app/(protected)/settings/documents/page.tsx`), both components (`document-type-settings-manager.tsx`,
`documents-readiness-cards.tsx`), the `loadClinicDocumentCounters` helper in `lib/supabase/admin.ts`, the
`settings-nav.tsx` change, and the two new + one updated test files. Re-read the reused infrastructure: the
P7-0 `document_settings` schema/constraints/RLS + counters in `20260801120000_p70_document_foundations.sql`,
the DB `is_primary_clinic_admin` authority (`20260720160000`), the app `isPrimaryClinicAdmin`
(`lib/primary-admin.ts`), the settings layout gate, `lib/documents/catalog.ts` (numbering, `supportsAttachments`,
`REGISTERED_DOCUMENT_TYPE_CODES`), and the **actual at-issue resolvers** (`revenue-report.ts`, `invoice.ts`,
et al.) to confirm the settings preview mirrors issuance. Independently ran `tsc`, the three P7-9 suites,
the i18n key check, and a **live local-Supabase functional RLS test** of the new write policy.

---

## Verdict summary

P7-9 is a faithful, thin settings surface over the existing P7-0 resolution model and the P7-6A clinical
settings. It configures exactly the doc 09 items — per-type/global watermark toggle + text, QR/verification
toggle, numbering prefix (future-only) + yearly-reset, and the attachment-merge print default for the two
types that support it — and **surfaces** (never re-owns) branding, clinician-credential, and drug/lab-catalog
completeness with deep links to the surfaces that already own each field. The per-type table is
catalog-driven (`REGISTERED_DOCUMENT_TYPE_CODES` = `Object.keys(DOCUMENT_CATALOG)`), so a new type appears
with no configuration and no migration — the doc 09 §2 extensibility contract.

The single new migration adds exactly the deferred write path: a `for all` RLS policy reusing the existing
DB `is_primary_clinic_admin(clinic_id, uid)` authority with a `with check` that pins `updated_by = auth.uid()`
for self-attribution, plus the `insert/update/delete` grant. Counters remain server-only (no authenticated
grant or policy); the numbering view reads them through one reviewed, metadata-only service helper behind the
primary-admin gate. No write touches `documents`, `document_counters`, or issued snapshots — issued documents
stay immutable and settings affect future issuance only. No retention/archival, counter-reset, P7-10, or
unrelated scope leaked.

I **verified the primary-admin/self-attribution/tenant enforcement live** against the running local schema
(see below): primary-admin self-attributed insert **and** update succeed; `updated_by ≠ self`, cross-clinic,
and non-primary-member writes are all denied.

**No blocking findings.** Five non-blocking observations (O1–O5).

**Verdict: APPROVED.**

---

## Required verifications

### V1 — `/settings/documents` matches the approved P7-9 scope — ✅ PASS

Every configured item maps to doc 09: numbering prefix (§1.2, future-only, stated in `prefixHint`) + yearly
reset with read-only live next-sequence; per-type watermark enable + custom text (§1.1/§1.3); per-type QR /
verification toggle (§1.3) + read-only `clinicflow.fit/verify` base; include-attachments print default (§1.4);
branding completeness incl. tax/VAT + footer (§1.5); global default row that un-overridden types inherit.
Nothing outside doc 09 is invented. Retention/archival is correctly **omitted** (undefined in doc 09/16 —
inventing it would be a new business rule).

### V2 — Only primary admins can access and mutate settings — ✅ PASS (verified live)

Four independent layers: the nav tab is `adminOnly` gated by `canCustomize = admin && isPrimaryClinicAdmin`
([settings-nav](../../components/settings/settings-nav.tsx), [layout L25-36](<../../app/(protected)/settings/layout.tsx#L25-L36>));
the page `redirect("/dashboard")`s a non-primary admin
([page L22-23](<../../app/(protected)/settings/documents/page.tsx#L22-L23>)); every action re-checks
`requireRole`/`requireMutationRole("admin")` **+** `isPrimaryClinicAdmin`
([actions L137-147,321-328,375-382](../../actions/documents-settings.ts#L137-L147)); and the DB RLS policy is
the ultimate gate. A manager reaching the URL directly fails `requireRole("admin")` in the page. Denial is
fail-closed and asserted to perform **no write** (see V14).

### V3 — Numbering configuration is future-only and cannot rewrite issued history — ✅ PASS

Settings store only the prefix/yearly-reset defaults; they are consumed by resolvers **at the next issuance**
and snapshotted into `documents.numbering_prefix_snapshot`. No P7-9 write path touches `documents` or
`document_counters`. `document_counters` is keyed by `(clinic_id, doc_type, period_key)` and is
**prefix-independent**, so changing a prefix never reuses a sequence integer and can never produce a duplicate
of an already-issued full number — consistent with doc 06 §5 (immutability + unique constraint). See O4 on
the cosmetic effect of a mid-period prefix/reset change.

### V4 — Global and per-type resolution behave correctly — ✅ PASS (mirrors the live resolver exactly)

`resolveEffectiveDocumentSettings` ([settings-config L68-96](../../lib/documents/settings-config.ts#L68-L96))
uses `effective = typeRow ?? globalRow` for watermark-enabled / watermark-text / qr / yearly-reset, and a
**field-level cascade** (`typeRow.prefix ?? globalRow.prefix ?? catalog.prefix`) for the numbering prefix.
I compared this against the **actual at-issue resolver** and it matches byte-for-byte:
`revenue-report.ts` uses `effectiveSettings = typeSettings ?? globalSettings`,
`effectiveSettings?.watermark_enabled ?? true`, `effectiveSettings?.watermark_text?.trim() || clinic.name`,
`typeSettings?.numbering_prefix?.trim() || globalSettings?.numbering_prefix?.trim() || catalog.prefix`, and
`effectiveSettings?.numbering_yearly_reset ?? catalog.numbering.yearlyReset`
([revenue-report L211-262](../../lib/documents/resolvers/revenue-report.ts#L211-L262); same shape in
`invoice.ts`, `analytical-report.ts`, `clinical-document.ts`, `patient-history.ts`). The settings preview is
therefore a faithful "what will apply" restatement, not a divergent re-implementation. Resolution unit tests
assert per-type over global over catalog for the prefix and the null/empty degradations
([config test L44-77](../../tests/unit/lib/p79-document-settings-config.test.ts#L44-L77)).

### V5 — Watermark and QR/verification settings are correctly persisted and resolved — ✅ PASS

Persistence: `watermark_enabled`/`watermark_text`/`qr_enabled` columns, with the zod contract mirroring the DB
`document_settings_watermark_length` check (1..160 trimmed, empty ⇒ null)
([validations L20-27](../../lib/validations/documents-settings.ts#L20-L27)). Resolution: empty watermark text
resolves to the clinic name at issue (`|| clinic.name`) and the UI shows the `watermarkClinicName` placeholder;
disabled ⇒ `null`. QR toggle feeds `qrEnabled` and the read-only `verificationBaseUrl` documents the resolved
`/verify` base. The table renders the effective watermark/QR/prefix and live next number.

### V6 — Include-attachments exposed only for supported document types — ✅ PASS (see O1)

`supportsAttachments` is true only for `PATIENT_FILE` and `STAFF_FILE`
([catalog L249,318](../../lib/documents/catalog.ts#L249)). `resolveEffectiveDocumentSettings` gates
`includeAttachments` on `catalog.supportsAttachments`
([settings-config L88-93](../../lib/documents/settings-config.ts#L88-L93)); the editor renders the switch only
when `target.kind === "type" && supportsAttachments`
([manager L317-333](../../components/settings/document-type-settings-manager.tsx#L317-L333)); the global editor
sets `supportsAttachments: false` so it never emits the option; and save sends `printOptions` only for
supporting types. The config test asserts `PATIENT_FILE` honours it and `REVENUE_REPORT` ignores it
([config test L61-70](../../tests/unit/lib/p79-document-settings-config.test.ts#L61-L70)). O1 notes the schema
does not itself reject the key on unsupported/global rows (nil effect).

### V7 — Branding completeness is accurate and does not invent required data — ✅ PASS

Reads the nine existing `clinics` branding columns and computes booleans by trimmed presence
([actions L240-255](../../actions/documents-settings.ts#L240-L255)). `missingRequired` contains **only** `name`
— nothing else is treated as required — and `taxIdMissing` is a **separate advisory** flag (doc 09 §1.5 gates a
compliant "Tax Invoice"), surfaced as a soft warning, not a hard requirement. Editing links out to
`/settings/clinic`; no branding field is duplicated or written here.

### V8 — Clinician credential/signature completeness reuses P7-6A correctly — ✅ PASS

Reads the P7-6A `profiles` credential columns (`professional_license_no`, `specialty`, `professional_title`,
`signature_path`) for active clinic doctors and reports per-clinician license/signature badges
([actions L257-275](../../actions/documents-settings.ts#L257-L275)). `complete = hasLicense && hasSignature`
matches the doc 16 §6 rendering need (license for the credential block; signature/stamp or the manual
fallback for validity), and the card restates the mandatory manual-signature fallback and links to
`/settings/staff`. No credential editing is added here. See O2 (minor active-filter nuance).

### V9 — Drug/Lab catalogs & department scoping reuse the clinical path without duplication — ✅ PASS

Only **counts** are read (`drug_catalog`/`lab_test_catalog` active/total via the caller's RLS-scoped client)
for the readiness card ([actions L177-184,277-284](../../actions/documents-settings.ts#L277-L284)); management
(incl. department scoping) deep-links to the existing `/settings/clinical` surface. No catalog CRUD, no
department-scope logic, and no new schema is introduced — the P7-6A owner is reused verbatim.

### V10 — Migration safely enables writes without exposing counters or cross-tenant data — ✅ PASS (verified live)

The migration adds exactly `grant insert, update, delete … to authenticated` + one `for all` policy reusing
`is_primary_clinic_admin` ([migration L16-29](../../supabase/migrations/20260803120000_p79_document_settings_write.sql#L16-L29)).
It adds **no** authenticated grant or policy for `document_counters` (allocation stays SECURITY DEFINER-only),
and SELECT continues through the existing clinic-wide `document_settings_select_clinic` policy for resolvers.
I confirmed the argument order `is_primary_clinic_admin(clinic_id, auth.uid())` matches the DB signature
`(p_clinic_id, p_user_id)` ([20260720160000 L52-55](../../supabase/migrations/20260720160000_p46_phase_review_cycle2_fixes.sql#L52-L55)).
Applying the migration against the live local schema leaves exactly two `document_settings` policies (`ALL` +
`SELECT`) — verified.

### V11 — updated_by / primary-admin enforcement is correct — ✅ PASS (verified live)

The `with check` requires both `is_primary_clinic_admin(clinic_id, auth.uid())` **and**
`updated_by = auth.uid()`; the actions set `updated_by: user.id` on every insert and update
([actions L339,332-340](../../actions/documents-settings.ts#L332-L340)). Live functional test (below) proves
a spoofed `updated_by` is rejected by the DB even for the primary admin.

### V12 — Immutable issued documents remain untouched — ✅ PASS

No P7-9 code path writes `documents`, `document_counters`, or any snapshot column. Settings are read by
resolvers at the next issuance only; existing issued rows are never re-numbered or re-rendered by a settings
change.

### V13 — No retention/archival, counter-reset, P7-10, or unrelated scope leaked — ✅ PASS

The report explicitly omits retention/archival (undefined in the architecture) and counter reset (number-reuse
risk). No hardening-only suites, no `document_counters` reset/rewind path, no new document types, no engine or
catalog change. All changed files map to the P7-9 settings slice.

### V14 — Tests are meaningful and fail closed — ✅ PASS

- **Config/validation** (`p79-document-settings-config.test.ts`): catalog-order coverage, per-type→global→catalog
  resolution, watermark-disabled ⇒ hidden, attachment gating, and strict zod rejection of an invalid prefix,
  over-length watermark, unregistered type, and **unknown print-option key** (`.strict()`).
- **Actions** (`p79-documents-settings.test.ts`): primary-admin gate on read/save/reset; a secondary admin is
  denied **and asserted to perform no non-select operation** (`expect(logs.some(l => l.operation !== "select")).toBe(false)`);
  insert-vs-update-by-id; self-attribution (`updated_by = user.id`); exact-row `clinic_id`+`doc_type` delete
  scoping; and pre-authorization validation rejection (bad prefix / made-up type reject **before**
  `requireMutationRole` is called).
- **Settings-nav** (`settings-nav.test.tsx`): Documents-tab visibility boundary.

I re-ran all three suites: **31 passed**.

---

## Findings

No blocking findings.

### O1 — Observation · `includeAttachments` is not rejected at the schema on unsupported/global rows

`documentSettingsInputSchema.printOptions` accepts `includeAttachments` for any `docType` (including the global
row and non-attachment types) ([validations L40-45](../../lib/validations/documents-settings.ts#L40-L45)). The
UI never emits it for those cases, and `resolveEffectiveDocumentSettings` gates consumption on
`catalog.supportsAttachments`, so a crafted payload has **nil effect** — the stored flag is simply ignored at
issue. Tightening (rejecting the key unless the type supports attachments) would make the contract self-evident
but is not a correctness or security issue. Non-blocking.

### O2 — Observation · Clinician readiness filter differs slightly from the primary-admin authority

The clinician query filters `is_active = true` + `deleted_at is null`
([actions L172-176](../../actions/documents-settings.ts#L172-L176)) but not `is_deleted = false`, whereas the
primary-admin lookup pins all three. Because `deleted_at`/`is_deleted` are meant to move together, this is a
display-only nuance on an own-clinic, primary-admin-gated read; a soft-deleted-but-active-flagged doctor could
in theory appear in the readiness list. Non-blocking; consider aligning for consistency.

### O3 — Observation · Next-sequence preview can show `1` after a yearly-reset toggle divergence

The live next number uses `currentPeriodKey(effective.numberingYearlyReset)`
([actions L228-234](../../actions/documents-settings.ts#L228-L234)). If an admin flips yearly-reset in an
override so the effective period key differs from the counter's historical `period_key`, the counter lookup
misses and the preview falls back to `1` until the first issue under the new key. This is a **display-only**
inaccuracy in the settings table; issuance itself allocates correctly from the real counter. Non-blocking.

### O4 — Observation · A mid-period prefix/reset change is future-only but visually mixes number series

Because counters are prefix-independent and reset only on the period key, changing a prefix mid-year continues
the same sequence integer under the new prefix (e.g. `INV-0005` then `BILL-0006`), and toggling yearly-reset
changes which counter/period a future number draws from. No already-issued number is altered and no **full**
number can collide (V3), but the issued series can read as visually inconsistent. This is inherent to the
approved doc 06 §5 model (immutability + future-only prefixes) and is correctly surfaced via the `prefixHint`
copy. Non-blocking; flagged for awareness.

### O5 — Observation · `loadClinicDocumentCounters` is a service-role (RLS-bypassing) read

The numbering view reads counters through `createAdminClient()` scoped by the `clinicId` argument, gated only
by the caller running `requirePrimaryAdmin` first ([admin L229-235](../../lib/supabase/admin.ts#L229-L235)).
It is metadata-only (`doc_type, period_key, next_seq` — no PHI/financial data) and is the intended P7-0 posture
(counters deliberately have no authenticated policy), but its safety depends on every future caller keeping the
primary-admin gate ahead of it. Today the sole caller does. Non-blocking; the helper's doc-comment already
states the contract.

---

## Independent validation run

- `pnpm exec tsc --noEmit` — **clean** (exit 0).
- `pnpm vitest run` on `p79-document-settings-config`, `p79-documents-settings`, `settings-nav` —
  **31 passed / 3 files**.
- i18n: `documents.settings.*` (67 keys) present with full AR/EN parity; `settings.navDocuments` /
  `settings.navClinical` present in both locales.
- **Live local Supabase — migration compile:** the P7-9 migration applies cleanly against the running local
  schema in a rolled-back transaction; afterward `document_settings` carries exactly two policies
  (`document_settings_manage_primary_admin` = `ALL`, `document_settings_select_clinic` = `SELECT`).
- **Live local Supabase — write-policy RLS (functional, `set role authenticated`, rolled back):** using seeded
  clinic `70000000-…-0001` (primary admin `b55929d9…`, receptionist `4b73d030…`, doctor `f831267e…`):
  - primary admin, INSERT per-type, `updated_by = self` → **SUCCESS** (`INSERT 0 1`);
  - primary admin, UPDATE global, `updated_by = self` → **SUCCESS** (`UPDATE 1`);
  - primary admin, `updated_by = other` (insert **and** update) → **DENIED** (`with check` violation);
  - primary admin, INSERT for a **different** clinic → **DENIED** (`with check` violation);
  - receptionist (non-primary member), INSERT self-attributed → **DENIED**;
  - receptionist, DELETE / UPDATE the clinic's global row → **0 rows affected** (`using` filter excludes them).
  Confirms primary-admin-only authority, self-attribution, and tenant isolation at the DB layer. All executed
  in a rolled-back transaction; no persistent local change.
- Confirmed `document_counters` has **no** authenticated grant/policy (P7-0), so the numbering data is never
  exposed to a client session — it flows only through the reviewed primary-admin-gated service helper.
- Confirmed the settings preview resolution matches the live at-issue resolvers field-for-field (V4).

**Migration application to remote:** not performed and not required for this review (consistent with the
P7-11/P7-12 "no remote Supabase operation" posture); the migration was validated locally as above. Applying
`20260803120000` (and the other pending P7 migrations) to the remote remains a DB-connected deploy step.

No production code was modified during this review. No commit was made.

---

**Verdict: APPROVED.**
