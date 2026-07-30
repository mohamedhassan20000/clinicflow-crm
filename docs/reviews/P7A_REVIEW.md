# P7A Review — Document Requirements Catalog

**Reviewer:** Claude (Opus 4.8)
**Date:** 2026-07-29
**Branch:** `feat/p7a-document-catalog`
**Scope reviewed:** `docs/AI_AGENT_PLAN.md` §8 / P7 (P7A–P7E), `docs/reports/P7A_IMPLEMENTATION.md`, every file under `docs/documents/`, and the complete current-branch delta from `main`.
**Mode:** Review only — nothing fixed, implemented, committed, pushed, or merged. P7B was not started and no design system was created.

## Verdict: **APPROVED**

P7A delivers exactly what the roadmap scopes for it: a complete, bounded, business-requirements catalog for the eight committed premium documents, one shared envelope/lifecycle contract, a legal-validation release gate, and an additive registry-oriented extension pattern — with **no** application code, schema, migration, message catalog, route, component, renderer, or roadmap change. Every "current data model" claim I independently checked against `types/database.ts` is accurate. Data-honesty, privacy, authorization, immutability, and legal-separation discipline is unusually strong and internally consistent. The P7A→P7B/C/D/E boundary is explicit in every artifact and no later-phase implementation is smuggled in.

Findings are minor: one Medium consistency reconciliation (the render-only consent family versus the "issued instance" shared envelope) and five Low refinements. None block the phase gate, and none require re-work before P7B design can begin.

---

## Delta from `main`

`git diff main...HEAD` is empty — the entire P7A deliverable is present only as **untracked** files (`docs/documents/`, `docs/reports/P7A_IMPLEMENTATION.md`). This is consistent with the "not committed" status in the implementation report and the instruction not to commit. The review therefore covers the working-tree files directly.

Added (documentation only):

- `docs/documents/README.md`, `SHARED_REQUIREMENTS.md`, `LEGAL_VALIDATION.md`, `EXTENDING_THE_CATALOG.md`
- `docs/documents/{invoice,receipt,prescription,medical-report,sick-leave,referral,lab-request,consent-form}.md`
- `docs/reports/P7A_IMPLEMENTATION.md`

No non-doc file is touched, confirmed by the empty tracked diff and untracked-only status.

---

## Verification against the required review checklist

### ✅ Catalog is complete and internally consistent
Eight committed definitions, all present, all with the same 12-section numbered structure (verified: each spec has exactly 12 numbered `## n.` sections) plus a metadata header (id / prefix / paper / formats / numbering). The README matrix, `SHARED_REQUIREMENTS.md`, and each spec agree on definition id, paper, issuer, numbering class, and delivery. Reading order and dependency mapping (P7B/C/D/E ownership) are stated in README §4 and repeated per spec.

### ✅ Shared lifecycle, localization, branding, numbering, privacy, QR, signature, and delivery are clearly defined
`SHARED_REQUIREMENTS.md` covers all of these as first-class sections: requirement vocabulary (§1), the logical document envelope (§2), branding placeholders + degradation (§3), patient/issuer fields (§4), preview→issue→download→correct→void immutability (§5), fiscal / clinical-traceability / consent numbering classes (§6), localization + bidi with LTR-isolated serials and Gregorian-only dates (§7), deterministic optional-field degradation (§8), the supported/unsupported signature matrix (§9), the opaque-token QR contract (§10), preview/print/PDF parity (§11), delivery + privacy (§12), and retention/audit (§13).

### ✅ Each document type has sufficient functional, data, permission, validation, localization, printing, PDF, and audit requirements
Every spec carries purpose/non-purpose, generation point + actor + trigger + preconditions, a source-of-truth assessment table, a complete field catalog with Required/Conditional/Optional markers and source status, section/table order + pagination, numbering + lifecycle, signature + QR, localization/branding/degradation, delivery, legal gates, a fixture set, and an explicit out-of-scope list.

### ✅ Current data-model gaps are stated accurately (independently verified)
I verified the catalog's repository claims against `types/database.ts`:
- `clinics` has `name, phone, logo_url, address, country, timezone, currency, locale, digits, time_format` and **does not** have email / website / social / tax-VAT / licence / custom_footer — exactly as README §5 (current) and SHARED §3 (P7C) assert.
- `appointments` exposes `total_amount, paid_amount, insurance_amount, secondary_amount, deposit_amount, outstanding_amount, payment_method, secondary_payment_method, payment_note, scheduled_at` — matches the invoice field catalog.
- `appointment_services(name, price, quantity)`, `patient_deposits(amount, payment_method, note, created_by, created_at)`, `outstanding_settlements(amount, payment_method, note, appointment_id, source_appointment_id, created_by, settled_at)` match the receipt/invoice source tables.
- `patient_document_category` enum = `national_id | insurance | other`; consent-form's manual-scan path correctly targets `category = other`.
- `medical_note_attachments` exists (backs the "note attachments" claim); `medical_notes.note` is free text (backs "free-text notes, no structured diagnosis").
- **No** `documents` / `invoices` / serial / numbering-sequence / document-instance table exists — the "no immutable instances or serial ledger" gap is accurate.
- Both billing RPCs (`complete_appointment_billing`, `complete_appointment_billing_with_previous_settlement`) exist.
- The invoice idempotency claim is real: `lib/messaging/invoice-delivery.ts` uses `dedupeKey: \`invoice:${input.appointmentId}\`` and records on `outbound_messages`.

The catalog is, if anything, **more** precise than the roadmap (the plan still says `clinics` has "only name/phone/logo_url/address"; the catalog correctly credits country/timezone/currency/locale/digits as current).

### ✅ P7B–P7E boundaries are clear; no later-phase implementation hidden in P7A
README §4 and every spec's §12 assign tokens/grid/primitives to P7B, branding schema/storage/RLS to P7C, registry/contracts/numbering RPCs/renderer/snapshots/verification to P7D, and authoring UI/persistence/invoice delivery to P7E. The extension manifest is explicitly labeled "a requirements shape, not a P7A runtime schema." The empty code diff confirms the boundary holds.

### ✅ The registry-oriented extension model is practical and additive
`EXTENDING_THE_CATALOG.md` requires a new `definition_id` rather than overloading an existing contract, gives a required manifest shape, a file+review sequence, primitive discipline (compose the P7B set; amend + re-version, never mutate), and compatibility rules (permanent ids, frozen issued versions, additive-optional-only backward compatibility). This mirrors the P1.5B report-registry precedent the roadmap cites.

### ✅ Arabic, English, RTL, accessibility, printing, and PDF are covered
SHARED §7 mandates semantic RTL, LTR-isolated serials/codes/URLs, ASCII serial digits, Gregorian dates, canonical-currency minor units, and flags PDF font-embedding rights as an explicit gate. Clinic name/legal identifiers are required to be text (searchable/accessible), not images (SHARED §3). Every spec has ar/en + print/PDF parity fixtures; §11 requires one snapshot to drive preview, print, and PDF (no separate templates).

### ✅ Sensitive medical/financial information has appropriate authorization and privacy boundaries
National ID off-by-default with documented purpose; QR payloads carry no PHI/PII/amount; logs/Sentry/analytics/filenames/object paths forbidden from clinical content; clinical documents barred from message bodies; authorization + RLS rechecked on every preview/issue/print/download/void/replace/deliver; browser-supplied clinic/patient/appointment/issuer ids never trusted as authority; cross-clinic and unauthorized-role denial fixtures required.

### ✅ Legal / jurisdiction statements are distinguished from product assumptions and cite official sources
`LEGAL_VALIDATION.md` opens by disclaiming legal advice, defines a fail-closed per-country release gate, and cites Kuwait MOH e-services / drug-control decrees (256/2019, 14/2020, 12/2022) and CITRA Decision 26/2024 as *validation needs*, explicitly not a complete implementation opinion. Sick-leave and medical-report specs forbid imitating an MOH-issued document or QR. (Citation-liveness note in validation section below.)

### ✅ No contradictions between individual specs and the shared catalog
Cross-checked matrix ↔ spec headers ↔ shared contract for paper, issuer, numbering class, delivery, QR, and signature. Consistent throughout, with the one reconciliation noted in **P7A-M1** below.

### ✅ Enough detail for later UI/Stitch/schema/implementation without over-prescribing architecture
Section/table order + pagination rules feed P7B/Stitch; Required/Conditional/Optional field catalogs with source status feed P7C/P7D schema work; the manifest + primitive set feed P7D — all expressed as requirements, not TypeScript or table DDL. No premature code architecture.

---

## Independent validation performed

| Check | Result |
|---|---|
| Tracked diff vs `main` (`git diff main...HEAD`) | Empty — deliverable is untracked docs only, as reported |
| Local Markdown link resolution across `docs/documents/` | Pass — 0 broken relative links (resolver over all `[..](..)` targets) |
| Parent/cross-doc references (`../AI_AGENT_PLAN.md`, `§3.7`, `§3.2 fix_clinics_cross_tenant_policies`) | Pass — targets exist (plan line 344 defines §3.7; §3.2 fix referenced) |
| Heading contract across the 8 specs | Pass — 12 numbered sections each |
| Trailing-whitespace scan (`docs/documents/`, report) | Pass — 0 occurrences |
| Current-data claims vs `types/database.ts` (clinics, appointments, appointment_services, patient_deposits, outstanding_settlements, patient_documents enum, medical_note_attachments, absence of document/serial tables) | Pass — all accurate |
| Billing RPC names + invoice `dedupeKey` idempotency claim | Pass — verified in `types/database.ts` and `lib/messaging/invoice-delivery.ts` |
| CITRA citation liveness | Pass — URL resolves to a 3.2 MB scanned PDF (decision-number text not OCR-readable) |
| MOH DCC citation liveness | Not confirmable — endpoint refused automated fetch (`ECONNREFUSED`); typical gov-site bot block, not disproof |

**Scope note.** P7A changes no code, so I did not re-run `pnpm typecheck/lint/test/build`; the implementation report's green results for those are plausible no-ops for a docs-only branch and were not independently reproduced. The decree numbers cited in `LEGAL_VALIDATION.md` could not be machine-verified against source text; this is acceptable because the catalog explicitly defers legal sufficiency to counsel review (which is the correct posture).

---

## Findings by severity

### Blocking / Critical / High
None.

### Medium

**P7A-M1 — Reconcile the render-only consent family with the "issued instance" shared envelope/lifecycle.**
`SHARED_REQUIREMENTS.md` §2/§5 model every document as an immutable **issued instance** with `status ∈ {draft, issued, void, replaced}`, `issued_at`, `issued_by`, `source_snapshot`, and `render_checksum` "Required when issued," plus a preview→issue→correct→void lifecycle built around an allocated number and a persisted snapshot. The consent-form family (`consent-form.md` §1, §3, §6) deliberately does the opposite: it renders a blank/prefilled form, "does not create an acceptance/consent-instance ledger merely because a blank form was printed," and is keyed by `(form_code, form_version, locale, jurisdiction)` with only an optional opaque `render_reference` — it is never "issued," voided, or replaced. The consent spec does not state which shared-envelope fields it overrides or how `status`/`issued_at`/`source_snapshot`/`render_checksum`/`document_number` map (or do not apply) to a render-only artifact. A P7D/P7E implementer reading SHARED §2 literally would try to give consent forms an issued-instance lifecycle they explicitly must not have. *Recommendation:* add an explicit narrowing in `consent-form.md` (which envelope fields apply, which are N/A for render-only) and/or a carve-out clause in SHARED §2/§5 for definitions whose numbering class is "definition code/version." Requirements-level clarification only; no code implication in P7A.

### Low

**P7A-L1 — Consent-form QR diverges from the shared QR contract without the shared section acknowledging the variant.**
SHARED §10 defines the QR exclusively as an opaque, revocable **verification-token** URL that may render "only when a real verification contract exists" and must be omitted otherwise. `consent-form.md` §5/§7 instead permits a **non-verification** QR resolving to "public approved blank-form/version information." That is a legitimate, well-guarded variant (no patient data, no signed-status claim), but it is a second QR semantics the shared contract does not anticipate. *Recommendation:* note the consent non-verification QR as an explicit narrowing/exception in SHARED §10, or state in the consent spec that it overrides §10.

**P7A-L2 — Extension heading list (14 items) does not match the committed exemplar structure (12 sections + header).**
`EXTENDING_THE_CATALOG.md` §4 enumerates 14 mandatory specification headings and §3 says to use "all headings in §4," but the eight committed specs implement 12 numbered sections plus a metadata header — "paper and output formats" (§4 item 3) lives in the front-matter header rather than a numbered section, and "localization and RTL/LTR" (item 9) is merged with "branding and optional-field degradation" (item 10) into one section. A future author following §4 literally would produce a spec that does not match the exemplars. *Recommendation:* align §4's list with the actual committed structure (or annotate which items are header metadata vs. merged sections).

**P7A-L3 — `retention_class` is a required manifest field but no committed spec assigns one.**
`EXTENDING_THE_CATALOG.md` §2 lists `retention_class` in the required registry manifest, yet none of the eight specs state a retention_class value, and SHARED §13 defers retention to future jurisdictional policy. The committed set therefore does not model the very field it asks future definitions to supply. *Recommendation:* either record an explicit "retention_class: deferred/unassigned in P7 pending §13 policy" in each spec, or note in §2 that retention_class is intentionally unpopulated until jurisdictional retention is approved.

**P7A-L4 — Prescription's controlled-drug blocking precondition depends on a catalog capability not committed anywhere in P7.**
`prescription.md` §2 says "the baseline issuer must block medicines flagged as controlled by an approved drug catalog," but §3 and §12 confirm no structured drug catalog / classification exists or is committed (drug-catalog procurement and controlled-drug workflow are out of scope). The controlled-substance safety behavior is therefore inert in the P7 baseline. The spec partially mitigates this ("warn that unclassified free text cannot be represented as a compliant controlled prescription"), but the "must block" wording can read as an active P7 guarantee. *Recommendation:* state plainly that controlled-drug blocking is unavailable until the external drug-catalog gate lands, and that the P7 baseline handles controlled substances only by warning/withholding controlled-prescription status.

**P7A-L5 — Cited legal sources lack access dates / document versions (durability).**
`LEGAL_VALIDATION.md` §2 cites MOH and CITRA sources by URL and decree/decision number but without retrieval dates or source versions. The release-gate in §1 already requires the *approval artifact* to record "source/version/date reviewed"; applying the same discipline to the catalog's own citations would harden them against link rot and silent regulatory change. (During review the CITRA PDF resolved but the MOH DCC endpoint refused automated fetch, illustrating the fragility.) *Recommendation:* add access dates and, where available, decree publication dates/versions to the §2 citations. Documentation-durability nit only.

---

## Handoff notes (Claude → Codex)

- All findings are **requirements-document clarifications**; none require code, schema, or a re-review gate before P7B may begin. P7B design can proceed against the catalog as-is.
- **P7A-M1** is the only one worth resolving before P7D/P7E persistence design, because it affects how the engine models consent versus the seven issued-instance documents. It is a wording/contract clarification, not a redesign.
- No fixes were applied. The deliverable remains untracked and uncommitted per instructions.

## Review report path

`docs/reviews/P7A_REVIEW.md`
