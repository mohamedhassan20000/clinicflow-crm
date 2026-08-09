# P7-10 Hardening — Implementation Report

**Status:** COMPLETE

**Branch:** `feat/p7-document-platform`

**Date:** 2026-08-03

**Scope:** The final hardening & quality-assurance phase for the entire Document Platform
(roadmap doc 13 P7-10; SHARED_REQUIREMENTS §7/§8; doc 16 §2/§4.2/§6/§7/§8). **No new product
functionality**: no new document types, no new engine features, no new business rules, no UI
redesign, no roadmap expansion, no P8 work. All existing P7-0…P7-9, P7-11, P7-12 work was preserved;
the only production behaviour changed is the correction of two confirmed defects (below). The phase
adds cross-cutting regression protection, closes the two defects it surfaced, and hardens the
message-catalog lint that guards i18n parity.

## Outcome

The platform is signed off against its hardening checklist. Two confirmed defects — both in the
**public verification** surface — were fixed, and three cross-cutting regression suites now lock the
platform-wide invariants (authorization matrix, verification disclosure/labelling, clinical-record
lifecycle immutability) that were previously only spot-checked or proven per-phase in live
integration tests. Every documented validation gate passes (see **Validation results**).

## Confirmed defects fixed

### D1 — Public verification page did not name the four P7-12 document types

`app/(public)/verify/[token]/page.tsx#documentTypeLabel` mapped only 16 of the 20 registered
document types. The four P7-12 history/financial types (`APPOINTMENT_HISTORY_REPORT`,
`PACKAGE_HISTORY_REPORT`, `DEPOSIT_STATEMENT`, `PATIENT_FINANCIAL_SUMMARY`) fell through to the
generic **"Document"** label when their QR was scanned — a public-facing correctness gap left by
P7-12. Fixed by:

- adding the four missing labels to the `documentPlatform.verification` message namespace in
  **both** `messages/en.json` and `messages/ar.json` (AR/EN parity), reusing the canonical titles
  already defined in `lib/documents/patient-history-copy.ts`; and
- replacing the fragile 20-branch `if`-chain with a **type-exhaustive**
  `Record<DocumentTypeCode, string>` label map (`VERIFICATION_DOCUMENT_TYPE_LABEL_KEYS`) in
  `lib/documents/verification.ts`. Because the record is keyed by `DocumentTypeCode`, **adding any
  future document type without a verification label is now a TypeScript compile error** — the class
  of defect cannot recur silently.

This stays strictly within the approved safe-disclosure set (SHARED_REQUIREMENTS §7): only the
document **type name** label was added; no new field is exposed on the public page.

### D2 — Prototype-chain lookup in the verification label resolver

The new label resolver initially used `documentType in VERIFICATION_DOCUMENT_TYPE_LABEL_KEYS`. For a
value such as `"__proto__"` (or `"constructor"`), `in` walks the prototype chain and would return a
non-label object instead of the generic fallback. The P7-10 verification-hardening test caught this;
`verificationDocumentTypeLabelKey` now uses `Object.hasOwn(...)`, so any unknown, empty, `null`, or
prototype-chain value deterministically resolves to the generic **"Document"** label. Defensive
hardening of a public, unauthenticated input path.

### D3 — `check-messages` did not honour dynamically-keyed *nested* namespaces

Refactoring D1 to a data-driven `t(verificationDocumentTypeLabelKey(...))` call exposed a latent bug
in `scripts/check-messages.mjs`: the script already **auto-detects** when a bound translator is
called with a non-literal key and records the (possibly **nested**) namespace in
`dynamicNamespaces`, but its unused-key filter only consulted the **top-level** namespace
(`key.split(".")[0]`). Auto-detected nested namespaces (e.g. `documentPlatform.verification`) were
therefore added to the set but never consulted — dead logic. The filter now exempts a key when **any**
recorded dynamic namespace is a prefix of it, so a dynamically-keyed nested namespace exempts its own
subtree **without** having to broadly exempt an entire top-level namespace. Existing top-level
behaviour is unchanged (prefix match subsumes the old `split(".")[0]` check). This is a precise
tooling-correctness fix, not a relaxation.

## Regression protection added (no new product behaviour)

All three are unit-level suites that always run in CI (no live DB required), complementing — not
duplicating — the per-phase live integration tests (`tests/unit/integration/p7*`).

### R1 — `tests/unit/lib/p710-authorization-matrix.test.ts` (9 cases)

A single frozen contract over the **whole catalog** so no future type can silently widen its
authority or disclosure:

- catalog ⇄ `DOCUMENT_TYPE_CODES` stay in sync; every type resolves to its own entry;
- every type's `pageRoles` is non-empty, duplicate-free, drawn only from valid roles, and always
  admin-inclusive;
- every type exposes **exactly** the safe five-field `SAFE_VERIFICATION_DISCLOSURE` (same frozen
  reference — no substitution), matching SHARED_REQUIREMENTS §7;
- **external-subject** preparation (`allowsExternalSubject`) is enabled for **only** the three
  clinical types (`PRESCRIPTION`, `LAB_REQUEST`, `SICK_LEAVE_CERTIFICATE`) and false/absent for every
  other type — doc 16 §4.2/§7's "no type widens silently" rule;
- **doctor no-financials** (doc 16 §8): financial statements (`INVOICE`, `DEPOSIT_STATEMENT`,
  `PATIENT_FINANCIAL_SUMMARY`) never list `doctor`/`assistant`;
- performance/roster analytics restricted to administrative oversight roles;
- numbering identity is immutable, **prefix-unique across all 20 types**, and well-formed
  (Latin-uppercase prefix, bounded padding, boolean yearly-reset) — numbering-integrity guard;
- every type is wired to a resolver + template + issuance trigger;
- attachment-merge opt-in is limited to `PATIENT_FILE`/`STAFF_FILE`.

### R2 — `tests/unit/lib/p710-verification-hardening.test.ts` (4 cases)

- the label record covers **exactly** the catalog (no missing/stray entries) and maps every type to a
  non-generic label — the compile-time-plus-runtime guarantee that D1 cannot regress;
- explicit regression assertions for the four P7-12 types;
- defensive-fallback assertions for `null`, empty, unknown, and `__proto__` inputs (locks D2);
- AR/EN parity for every label key plus the generic fallback label.

### R3 — `tests/unit/actions/p710-clinical-lifecycle-hardening.test.ts` (5 cases)

Pins the clinical-record **immutability** guards in `actions/clinical/_shared.ts` at unit level
(the live integration test `p76a-clinical-authoring` proves them end-to-end; this proves the guard
logic deterministically and cheaply):

- `finalize` transitions **only** a `draft`, scoped by `clinic_id` + `id`, stamping `finalized_by`;
- a non-draft record cannot be re-finalized (returns `recordLocked`, still filtered on
  `status = draft`);
- `void` transitions **only** a `finalized` record forward — never a draft;
- a non-finalized record cannot be voided (returns `recordLocked`);
- a DB error surfaces as `mutationFailed`, distinct from the locked-record path.

## Coverage already present (verified, not duplicated)

The hardening review confirmed the following were **already** covered by existing suites and were not
re-implemented:

- **Verification enumeration / disclosure / rate-limit / `noindex`:** `tests/unit/lib/
  p73-public-document-verification.test.ts` (token regex rejection without querying, five-field
  disclosure, collapse to `unavailable`) + the page's `robots: { index:false, follow:false }` and
  fail-closed `checkRateLimit("document-verification", …, { failureMode: "closed" })`.
- **Idempotent issuance + render-failure rollback + numbering concurrency + own-clinic PDF RLS +
  cross-tenant branding:** `tests/unit/integration/p70-document-foundations.test.ts`.
- **Clinical authoring authz, preparer/physician separation, finalized-record locking after
  deactivation, external-subject snapshots + medical-note links:** `tests/unit/integration/
  p76a-clinical-authoring.test.ts`.
- **Documents-module authorization (inaccessible type returns empty without querying, type
  constraint):** `tests/unit/integration/p78-document-module-actions.test.ts`.
- **PDF fidelity (AR/EN, Latin digits, bidi):** `p73/p76/p77` PDF-render integration tests.
- **Settings authorization + write-policy RLS:** `p79-documents-settings` + settings-nav suites.

## Files changed for P7-10

### New

- `lib/documents/verification.ts` **(modified — untracked new file from the P7-3 slice)** — added the
  type-exhaustive `VERIFICATION_DOCUMENT_TYPE_LABEL_KEYS` record and the `Object.hasOwn`-guarded
  `verificationDocumentTypeLabelKey` resolver.
- `tests/unit/lib/p710-authorization-matrix.test.ts` — R1.
- `tests/unit/lib/p710-verification-hardening.test.ts` — R2.
- `tests/unit/actions/p710-clinical-lifecycle-hardening.test.ts` — R3.
- `docs/reports/P7-10_IMPLEMENTATION.md` — this report.

### Modified

- `app/(public)/verify/[token]/page.tsx` **(untracked new file from the P7-3 slice)** — consumes the
  exhaustive label resolver; the 20-branch `if`-chain is gone (D1).
- `messages/en.json`, `messages/ar.json` — four `documentPlatform.verification.*` labels for the
  P7-12 types (D1), AR/EN parity.
- `scripts/check-messages.mjs` — nested-dynamic-namespace correctness in the unused-key filter (D3).

_No migration, catalog, resolver, renderer, template, or business-logic file was changed. No new DB
object was introduced, so no schema/RLS migration belongs to this phase._

## Validation results

- `pnpm exec tsc --noEmit` — **passed** (exit 0).
- `pnpm lint` (ESLint, whole repo) — **passed** (0 errors; 25 pre-existing warnings, none in files
  touched by P7-10).
- `pnpm build` — **passed**; `/verify/[token]` route generated.
- `pnpm test` (unit + component; integration excluded by the project script) — **passed**,
  **300 files / 2,198 tests** (+3 files / +18 tests from P7-10; baseline was 297 / 2,180).
- `pnpm test:integration` (live local Supabase; keys from `supabase status`) — **passed**,
  **46 files / 396 tests** (1 file / 3 tests skipped by design). Confirms the P7 RLS, cross-tenant,
  numbering-concurrency, clinical-authoring, and PDF-render integration tests remain green under the
  P7-10 changes.
- `node scripts/check-messages.mjs` — **passed** (3,830 leaf messages; no unused keys; +4 from P7-12
  verification labels).
- `node scripts/check-messages.mjs missing` — **passed** (valid AR/EN parity).
- `pnpm lint:i18n` — **passed** (411 files; 41 documented exceptions; none added).
- `pnpm lint:rtl` — **passed** (596 files; 10 documented exceptions; none added).
- `git diff --check` — **clean** (no whitespace/conflict markers).
- PDF rendering, RLS, and authorization coverage — exercised via the integration run above and the new
  matrix suites; no new PDF/renderer code was introduced.

## Blockers and deviations

- **Blockers:** none.
- **Deviations:**
  1. **`scripts/check-messages.mjs` changed (D3).** Necessary because the D1 refactor to a
     data-driven translation call exposed the pre-existing nested-namespace gap in the lint. The
     change is a strict correctness improvement (prefix match subsumes the old top-level check) and
     was validated by a full green `check-messages` run.
  2. **No migration authored.** P7-10 introduces no schema/RLS objects; the platform's numbering,
     idempotency, RLS, and tenant-isolation guarantees are exercised against the already-applied local
     schema via the existing integration suite. Consistent with the P7-9/P7-11/P7-12 "no remote
     Supabase operation" posture.
- **Deferred:** the open **regenerate policy** (doc 14 §4 Q1) remains reprint-only until the founder
  confirms — no regenerate path was added, as required by the roadmap risk note.

## Review handoff

Not performed (per instructions). A review should write `docs/reviews/P7-10_REVIEW.md` per the
review-file workflow. No commit, push, branch switch, or PR was performed; all existing P7 working-tree
changes were preserved.
