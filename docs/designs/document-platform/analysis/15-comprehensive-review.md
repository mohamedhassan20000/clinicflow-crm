# 15 · Comprehensive Engineering Review — Document Platform Plan

**Reviewer:** Claude (Opus 4.8)
**Date:** 2026-08-01 (final review after required fixes applied)
**Branch:** `feat/p7-document-platform` (working tree: `docs/designs/` untracked; `docs/AI_AGENT_PLAN.md` and `docs/documents/README.md` modified — planning/roadmap docs only; **no production code, migrations, dependencies, components, routes, actions, or tests changed**)
**Mode:** Planning review only.

**Scope reviewed:** the full analysis (`README`, `01`–`14`), the 16-type design intake (`docs/designs/document-platform/README.md`, a `NOTES.md`, `FIGMA_REFERENCE.md` node pointers), the design-intake `shared/SHARED_REQUIREMENTS.md` (§1–§16), the P7A deliverables (`docs/documents/`, `docs/reports/P7A_IMPLEMENTATION.md`, `docs/reviews/P7A_REVIEW.md`), the master roadmap `docs/AI_AGENT_PLAN.md` §8, the Arabic invoice + prescription reference renders, and the codebase reuse anchors (all verified present).

---

## Verdict: **APPROVED**

The first review (recorded below) returned **APPROVED WITH REQUIRED FIXES** against one blocking inconsistency and five required fixes. **All six have now been applied to the planning documents and the master roadmap.** The architecture itself was — and remains — endorsed: a layered engine (`DOCUMENT_CATALOG` → thin templates → shared primitives → `<DocumentPage>` chrome), one template driving three renderers, snapshot-at-issue immutability, per-clinic/per-type atomic numbering, opaque-token verification, dual audit trail, and aggressive reuse of the existing platform — all consistent with the codebase's real patterns and verified against the actual Arabic RTL renders.

With the catalog reconciliation, branding expansion, resolver honesty, phase renumbering, conformance gate, and idempotency all folded in, the plan now presents **one authoritative document set, one phase vocabulary, and honest data-layer sizing**. It is a sound basis to begin implementation, starting with P7-0 → P7-1 → P7-2 → P7-3 as the PDF/RTL/font-fidelity go/no-go gate. The remaining items are **founder decisions** (doc 14 §4), not plan defects, and the roadmap correctly defers the phases they gate (clinical documents on upstream authoring forms; regenerate policy; the §16 delivery prompt).

---

## Resolution of the required fixes

| ID | Required fix | Status | Where resolved |
|----|--------------|--------|----------------|
| **DP-B1** (Blocking) | Reconcile the 16-document design set with the P7A 8-document catalog; make one set authoritative; record disposition of dropped types | ✅ Resolved | New **doc 02 §6** (16-set is committed, supersedes 8-set; receipt/medical-report/referral/consent-forms deferred with dispositions); **analysis README** scope note; **`AI_AGENT_PLAN.md` §8** 2026-08-01 revision block + execution-table note; **`docs/documents/README.md`** supersession banner |
| **DP-R1** | Expand branding to tax/VAT + custom footer + extensible metadata | ✅ Resolved | **doc 11 §5** (adds `tax_id`, `document_footer`, `branding_metadata jsonb`, RLS note, tax-line vs tax-identity note); **doc 09 §1.5** (completeness incl. tax/VAT + footer + metadata, flags missing tax id before invoice issue); **doc 12 §4.1**; **doc 14 rec #4**; **doc 13 P7-0** |
| **DP-R2** | Treat Sales + Follow-up Analytics as net-new resolver work and resize the phase | ✅ Resolved | **doc 02 §5** (mapping table: 6 reuse, 2 net-new); **doc 12 §1 + §2** (net-new rows; §4 gap #4); **doc 13 P7-4** (explicit resolver-build sub-tasks + sizing note); **README** net-new list |
| **DP-R3** | Replace P0–P9 with a Phase-7 sub-phase sequence | ✅ Resolved | **doc 13** fully renumbered to **P7-0 … P7-10** with a naming-reconciliation banner; **README** note; **`AI_AGENT_PLAN.md` §8** records P7-* superseding P7C/P7D/P7E; doc 14 phase refs updated |
| **DP-R4** | Add an explicit design→engine conformance/cleanup gate before every document | ✅ Resolved | **doc 13 P7-2** (new dedicated gate: cleanup → Figma token extraction → primitive mapping → reproducibility sign-off; per-document; a document cannot enter its batch until it passes); referenced in each batch's dependencies and doc 14 rec #2 |
| **DP-R5** | Document issuance idempotency + rollback | ✅ Resolved | New **doc 05 §3.1** (idempotency key, safe render-before-allocate ordering, transactional rollback, retire-not-reuse on post-allocation failure, no-partial-issue invariant); wired into **doc 13 P7-0/P7-3/P7-10**; **`AI_AGENT_PLAN.md` §8** note |

I re-read each edited section after applying it. The edits are internally consistent (phase labels, the branding field set, and the resolver mapping now agree across docs 02, 05, 09, 11, 12, 13, 14, the README, `AI_AGENT_PLAN.md` §8, and `docs/documents/README.md`), and no production artifact was touched.

---

## What remains correct and endorsed (unchanged from the first pass)

- **Architecture altitude** — layered engine + registry; five archetypes; ~15 primitives; thin templates; the two rejected alternatives correctly reasoned.
- **Dual renderer / single source of truth** — screen ⇄ browser print ⇄ Chromium from one template; `@react-pdf`/`pdfkit` correctly rejected.
- **RTL/LTR + Latin digits + bidi** — verified directly against the Arabic invoice and prescription renders (Latin digits throughout Arabic layout; LTR-isolated drug names/codes/phones; logical CSS + forced `numberingSystem:'latn'` + `<bdi>`). The strongest part of the plan.
- **Numbering** — per-clinic/per-type, atomic definer RPC, immutable full string, unique backstop, prefix edits future-only, no rewind after void.
- **Snapshot-at-issue** — the reprint-vs-regenerate foundation; legal/accounting drift correctly identified.
- **Verification** — QR over 1D; opaque token; `unavailable` for unknown/malformed; rate-limited; narrow public read of only the five safe fields.
- **Audit** — `document_events` + `activity_events`, append-only, server-write-only.
- **Reuse map** — every claimed anchor exists in the repo; `DOCUMENT_CATALOG` mirrors `REPORT_CATALOG`.
- **Font-fidelity de-risking** — inlined local Thmanyah/Manrope, proven in P7-1/P7-3 before scaling (now also gated on the Chromium bundle-size limit).

---

## Residual open questions (founder decisions — not blockers)

These are correctly parked in **doc 14 §4** and the roadmap defers the phases they gate. They should be answered **before the specific phase runs**, not before implementation begins:

1. **Regenerate semantics** (auto-void vs. both-valid; which types; who) — ship **reprint-only** first (endorsed). *Gates the regenerate follow-up.*
2. **§16 invoice delivery prompt** — how the WhatsApp/email/both/not-now prompt relates to the **already-built manual "Send to patient" flow** + `message_dispatches` ledger (doc 12 §4.6 now says it augments, not replaces). *Gates P7-7.*
3. **Issue-time locale** — one document per language (two numbers) vs. one document/two renders. *Gates P7-3 schema.*
4. **Tax line vs. tax identity** — whether the invoice computes/itemizes VAT or only carries tax identity. *Gates P7-7.*
5. **Number format specifics** — house prefix, padding width, yearly reset. *Gates P7-0.*
6. **Void authority & reason**, **per-document-type visibility**, **/verify indexing/branding**. *Gate P7-8/P7-9/P7-10 respectively.*
7. **Clinical authoring forms (SHARED §14)** — an upstream dependency; P7-6 is not scheduled until the data source exists (correctly flagged).

---

## Answers to the review questions (final)

- **Consistency with P7A & master roadmap:** Now consistent — one authoritative 16-document set, supersession recorded in three places, branding aligned to the P7C model, phase vocabulary unified.
- **Architecture & ordering:** Sound; the P7-2 conformance gate closes the last ordering gap.
- **Security/RLS/permissions/storage/audit/numbering/snapshots/verification/PDF/public routes:** Correct; idempotency/rollback now specified; public-route caching/`noindex` and snapshot-versioning captured as hardening/recommendations.
- **RTL/LTR, fonts, Latin digits, bidi:** Correct and verified against real renders.
- **16 types, fields, sections, filters, triggers, data sources:** Complete; resolver honesty fixed (2 net-new); clinical upstream dependency flagged.
- **P0–P9 vs P7B–P7E:** Sequencing adopted; labels moved into the P7 namespace (P7-0…P7-10) superseding P7C/P7D/P7E.
- **Phase sizing/ordering:** Ordering right; P7-4 resized for two resolver builds; P7-6 gated on upstream forms; branding delivered in P7-0.
- **Decisions before implementation:** The two blocking/branding decisions are resolved in-plan; the rest are founder decisions parked per phase.

---

## Handoff notes (Claude → Codex)

- The architecture backbone is **endorsed as-is**. Begin with **P7-0 → P7-1 → P7-2 → P7-3**; treat Arabic Chromium PDF fidelity + bundle size as the explicit go/no-go gate on the Revenue Report vertical slice.
- Answer the doc-14 §4 founder questions **per gated phase**, not up front — the roadmap sequences them.
- This review edited only planning/roadmap docs (analysis `02/05/09/11/12/13/14/README`, this file, `AI_AGENT_PLAN.md` §8, `docs/documents/README.md`). No production code, and nothing committed.

---

## Final verdict

**APPROVED**

---

---

# Appendix — First review (2026-08-01, pre-fix): APPROVED WITH REQUIRED FIXES

Retained for the audit trail. All findings below were resolved in the table above.

- **DP-B1 (Blocking):** Two conflicting catalogs — P7A's committed **8-document** set (invoice, receipt, prescription, medical report, sick-leave, referral, lab request, consent forms) vs. this analysis's **16-document** set (overlap of 4). The analysis referenced only the design-intake `SHARED_REQUIREMENTS.md`, never `docs/documents/` or `AI_AGENT_PLAN.md` §8, leaving no authoritative source of truth and dropping receipt/medical-report/referral/consent without disposition.
- **DP-R1:** Branding under-scoped — only email/website/license proposed; the P7C model and the "فاتورة ضريبية / Tax Invoice" render require tax/VAT, custom footer, and an extensible metadata bag.
- **DP-R2:** "Reuse the report data layer for all 8 analytical docs" over-generalized — `REPORT_CATALOG` has no `sales` and no follow-up-analytics id, so docs 10 and 11 are net-new data pipelines.
- **DP-R3:** The doc-13 `P0–P9` labels collided with the project-level `P0–P7` and the `P7A–P7E` sub-phases.
- **DP-R4:** The §8 "design must be engine-constrained" gate was not represented as a step.
- **DP-R5:** Issuance idempotency/rollback was asserted for numbering but not for the whole issue action.

Non-blocking recommendations from the first pass (delivery-flow reconciliation, Chromium bundle-size gate, issue-locale, /verify caching + noindex, snapshot versioning, primitive-count discipline, attachment immutability, void authority) were folded into doc 13, doc 12, doc 14, or the residual-open-questions list above.
