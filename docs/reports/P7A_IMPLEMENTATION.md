# P7A Implementation Report — Document Requirements Catalog

**Date:** 2026-07-29
**Branch:** `feat/p7a-document-catalog`
**Roadmap:** `docs/AI_AGENT_PLAN.md` §8 — P7A
**Status:** Implemented; P7B and later phases not started

## 1. Outcome

P7A now has a complete, bounded requirements catalog under `docs/documents/` for the committed premium-document set:

- invoice;
- receipt;
- prescription;
- medical report;
- sick-leave certificate;
- referral;
- lab request; and
- consent-form family.

The catalog also defines one shared document envelope, a legal/jurisdiction release gate, and an additive registry-oriented extension pattern. It is a planning deliverable only.

## 2. Requirements captured

Every committed specification includes:

- purpose and explicit non-purpose;
- generation point, authorized actor, trigger, and issue preconditions;
- fixed paper size/orientation and output formats;
- current source-of-truth assessment and missing-data gaps;
- complete dynamic/conditional/optional field tables;
- section/table ordering and pagination requirements;
- signature/attestation and privacy-safe QR behavior;
- numbering, immutable issue, void, replacement, and retry semantics;
- Arabic/English and RTL/LTR behavior;
- shared P7C branding placeholders and deterministic optional-field degradation;
- allowed delivery channels;
- jurisdiction/legal-validation gates;
- fixtures and acceptance criteria; and
- an explicit P7A/P7B/P7C–P7E boundary.

## 3. Architecture decisions

### Immutable issued snapshots

Issued documents render from a persisted source snapshot and definition version. Reprint, download, and allowed delivery do not rebuild from mutable patient, clinic, appointment, payment, or medical-note rows. Corrections create replacements; voiding never deletes or recycles a number.

### Numbering

Invoice and receipt have independent per-clinic fiscal sequences. Prescription, medical report, sick leave, referral, and lab request have independent clinical-traceability sequences. Allocation is transactional, concurrency-safe, and idempotent. Consent forms use an immutable form code/version and do not create false acceptance history.

### Data honesty

The repository currently lacks structured medication, diagnosis, clinician-licence, sick-leave, referral, lab-order, consent-definition, tax-snapshot, document-instance, and serial-ledger data. The catalog marks these as explicit P7C/P7D/P7E or external gates. It forbids inference from free-text notes, appointment status, billing lines, department labels, or unrelated metadata.

### Privacy and verification

QR payloads are opaque verification URLs with no patient, clinical, medication, or financial content. A QR appears only when a real rate-limited, audited verification service exists. Clinical documents remain preview/print/download only; P7E integrates only the invoice with the unchanged manual P3 delivery boundary.

### Legal separation

The catalog records official Kuwait validation sources and fail-closed legal-profile requirements without claiming legal sufficiency. ClinicFlow-rendered sick leave must not imitate an MOH-issued document. Consent-form rendering is explicitly separate from e-signature, structured consent, and agreement-history capture.

## 4. Files changed

### Added — catalog

- `docs/documents/README.md`
- `docs/documents/SHARED_REQUIREMENTS.md`
- `docs/documents/LEGAL_VALIDATION.md`
- `docs/documents/EXTENDING_THE_CATALOG.md`
- `docs/documents/invoice.md`
- `docs/documents/receipt.md`
- `docs/documents/prescription.md`
- `docs/documents/medical-report.md`
- `docs/documents/sick-leave.md`
- `docs/documents/referral.md`
- `docs/documents/lab-request.md`
- `docs/documents/consent-form.md`

### Added — implementation record

- `docs/reports/P7A_IMPLEMENTATION.md`

No application code, message catalog, migration, generated type, dependency, configuration, route, action, component, test fixture, or roadmap file was changed.

## 5. Validation

| Check | Result |
|---|---|
| P7A specification-heading contract across all 8 committed definitions | Pass |
| Local Markdown-link resolution across `docs/documents/` | Pass |
| Catalog inventory/boundary audit | Pass — 8 committed definitions; P7B–P7E absent |
| Catalog trailing-whitespace check + `git diff --check` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass — 0 errors, 24 pre-existing source warnings |
| Full non-live unit/component suite (`pnpm test`) | Pass — 250 files, 1,907 tests |
| Production build (`pnpm build`) | Pass — Next.js 16.2.6, 71 pages generated |

The first lint attempt ran concurrently with tests and encountered the repository’s temporary RTL-probe file disappearing during ESLint’s scan. Lint was rerun serially after tests and passed with no errors. Live database integration tests were not run because P7A changes no schema, RLS, database code, application code, or test fixture.

## 6. Explicit later-phase boundary

P7A does not implement:

- P7B document-design tokens, grid, typography, primitives, or external visual designs;
- P7C branding schema, storage, RLS, settings, or asset management;
- P7D registry, typed runtime contracts, document storage, numbering RPCs, PDF/print renderer, snapshot persistence, or verification service;
- P7E authoring UI, templates, document-domain schema, preview/print/download routes, or invoice delivery attachment;
- e-signature, signature capture, consent acceptance/history, tax engine, controlled-drug support, medical interoperability, or new delivery workflows.

Nothing was reviewed, committed, pushed, merged, or opened as a pull request.
