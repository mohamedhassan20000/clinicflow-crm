# 14 · Risks, Assumptions & Recommendations (Self-Review)

## Objective

Critically review the proposed architecture before it is approved: where it could fail to scale,
duplicate, or become hard to maintain; which alternatives were considered and why they were
rejected; the assumptions it rests on; the open questions for the founder; and the prioritized
recommendations.

---

## 1. Self-review — does the architecture hold?

### Scalability
- **Adding a document type** = one template + one catalog entry (migration only for new
  schema/config). Verified against the layer model (doc 01 §2) — Layers 0/1 are untouched by new
  types. ✅
- **Catalog-driven surfaces** (module list, filters, settings) auto-include new types by iterating
  `DOCUMENT_CATALOG`, exactly as `REPORT_CATALOG` drives report surfaces today. ✅
- **Numbering/settings are type-agnostic** (`doc_type` is data) — no per-type tables. ✅
- **Watch-out:** the primitive library must stay small and general. If a future document tempts a
  15th bespoke primitive, prefer composing existing ones. Mitigation: the archetype table (doc 04
  §7) is the gate — a new body should map to an archetype or justify a genuinely new one.

### Duplication risks
- **Screen vs print vs PDF** could have drifted into 2–3 designs; the single-template/three-renderer
  decision (doc 03 §9) removes that. ✅
- **AR vs EN** could have been two templates; direction-aware logical CSS keeps it one (doc 03 §2). ✅
- **Header/footer/watermark/QR** could have been copied per document; they live in Layer 0. ✅

### Maintenance risks
- **Chromium runtime** is the heaviest new operational surface (binary size, cold starts,
  serverless quirks). Mitigation: prove it in P7-1/P7-3, isolate it behind `lib/documents/pdf/`, keep
  the browser-print path as a fallback for interactive use.
- **Snapshot storage growth** (JSON + PDF per issued document). Mitigation: bounded per issuance,
  in cheap storage; it is the correct cost of immutable records; revisit lifecycle/archival only if
  volume warrants.
- **Formatter divergence** (documents force Latin digits while the app respects the clinic setting).
  Mitigation: a single document formatter module (doc 03 §3) and a lint rule that document
  templates never import the app formatters directly.

### Consistency
- One engine + tokens derived from Figma (the source of truth) → consistent identity across all 16.
  A rebrand is a token-file change, not 16 edits. ✅

**Conclusion:** the layered engine + registry is the right altitude — more structured than 16
bespoke templates, less rigid than a fully declarative document engine. No better architecture was
found; the refinements from the self-review are folded into the docs.

---

## 2. Alternatives considered & rejected

| Alternative | Why rejected |
|-------------|-------------|
| **16 bespoke templates** | Duplicates chrome/watermark/QR/numbering 16×; cross-cutting changes become 16-file edits |
| **Fully declarative JSON document engine** | Over-engineered for 16 docs; bespoke bodies (certifying prose, lab checklist, invoice totals) fight a generic renderer. We keep the *registry* idea, not the *layout* generality |
| **`@react-pdf/renderer`** | Its layout engine can't reproduce these HTML/CSS designs (gradients, RTL tables, custom fonts) without re-authoring all 16 in its primitives — the exact duplication we avoid |
| **`pdfkit` / `pdfmake` (imperative)** | Even worse fidelity/effort for design-rich, RTL, multi-font documents |
| **Encode the sequential number in the QR** | Enumerable → probing risk. Use an opaque token (doc 07) |
| **Global or per-clinic-only numbering** | Contention/leak / mixed-type sequences (doc 06 §1) |
| **Re-resolve data on reprint (no snapshot)** | Silent drift of period-scoped/financial documents — a legal/accounting hazard (doc 05 §4) |
| **Audit only in `activity_events`** | Per-document print counts/timeline need fast document-scoped queries → keep a light `document_events` too (doc 10) |
| **New fonts for print** | Prohibited; Thmanyah + Manrope reused, inlined for Chromium (doc 03 §9) |
| **Respect the clinic's Arabic-digit setting in documents** | Violates the Latin-digits-always requirement → forced Latin formatter (doc 03 §3) |

---

## 3. Assumptions

1. **Figma is the design source of truth**; screenshots are reference only. Exact tokens
   (color/spacing/type) are read from Figma at implementation (the intake nodes exposed no Figma
   variables, so values are read from the frames).
2. Documents are **A4 portrait** by default (from the designs' proportions); confirmed per type at
   build; landscape available for wide tables.
3. Existing report **RPCs/RLS** can serve as document data resolvers for the 8 analytical docs
   without widening access.
4. The **clinical authoring forms + records** (prescription/lab/sick-leave) are the data source for Phase
   P7-6, per SHARED_REQUIREMENTS §14. **Update (2026-08-02):** they are now scoped and owned by
   **P7-6A — Clinical Authoring Foundations** (doc 16) as an explicit prerequisite sub-phase, rather than an
   external dependency; P7-6 does not render until those records exist.
5. Serverless **headless Chromium** is acceptable operationally (Node/Fluid function) — validated
   in P7-1 before anything depends on it.
6. **New dependencies** (`puppeteer-core`+`@sparticuz/chromium`, `qrcode`, `pdf-lib`) are approved
   in principle (founder decision); each is introduced in the phase that needs it.
7. The **canonical production domain** for QR/verification is `clinicflow.fit` (not the preview
   `*.vercel.app`).
8. `activity_events`' append-only, spoof-proof write boundary is the model `document_events` copies.

---

## 4. Open questions for the founder

1. **Regenerate semantics (deliberately unfinalized — correction #5).** When a document is
   regenerated: does it **auto-void** the prior issue, or do both remain valid with a successor
   link? Is regenerate allowed for **all** types or only data-driven ones (reports/invoice), and
   **not** for signed clinical documents? Who may regenerate (issuer only / admin)? → Roadmap ships
   **reprint-only** first and scopes regenerate once answered.
2. **Watermark enable/disable default (SHARED_REQUIREMENTS §13).** Confirmed: per-type toggle +
   text. Any type that must **always** be watermarked (e.g. clinical/financial) regardless of the
   toggle? 
3. **Invoice delivery prompt (§16).** After invoice completion, prompt WhatsApp / email / both /
   not-now — should any be **auto-selected** or is it always a manual choice? This requires
   inspecting existing messaging behavior before wiring (doc 12 §4).
4. **Per-document-type visibility.** Is per-employee show/hide needed at the *document-type* level
   (like report permissions), or is the page-level `documents` gate enough for v1?
5. **Verification page indexing/branding.** Should the public `/verify` page carry clinic branding
   (logo/name) beyond the clinic name text, and should it be search-indexable?
6. **Issue-time locale.** When a user issues a document, is the language the **UI locale**, an
   explicit per-issue choice, or the **clinic default**? (Affects whether both AR and EN copies can
   be issued for one record.)
7. **Number format specifics.** Confirm the visible format (`PREFIX-YYYY-SEQ`), the house prefix
   (e.g. `CF-`), zero-padding width, and whether sequences reset yearly.
8. **Void authority & reasons.** Which roles may void, and is a reason required/recorded?

### Clinical authoring & patient-file redesign (P7-6A / P7-8 / P7-11 / P7-12 — doc 16)

9. **Clinical read-visibility matrix.** The *preparer* role set is closed (Admin/Manager/Receptionist/
   Doctor/Assistant-when-enabled); this is only about **who may view** each clinical record/document and
   the corresponding RLS scope. — before P7-6A.
10. **Clinical amendment/versioning.** Once a record is finalized and a document issued, are amendments
    allowed? Proposed: finalized records immutable; a correction = new record + void of the old document
    (ties to the regenerate policy, Q1). — before P7-6.
11. **Sick-leave legal profile.** Max duration / backdating / future-start caps; baseline clinic-issued
    only, fail-closed when unknown. — before P7-6.
12. **External-subject policy per type.** Which document types set `allowsExternalSubject = true`, and the
    minimum identity fields for a non-registered subject (founder confirmed clinical records may carry an
    external subject). — before P7-8 factory work.
13. **Drug/lab catalog admin.** Admin surface + permission (primary-admin vs admin) and department-scope
    representation (join table vs nullable `department_id`). — before P7-6A.
14. **`PATIENT_FINANCIAL_SUMMARY`.** Distinct type vs extending Invoice/Revenue; confirm patient-scoped
    only. — before P7-12.

---

## 5. Prioritized recommendations

1. **Approve the layered engine + `DOCUMENT_CATALOG` + single-template/three-renderer** as the
   backbone. It is the decision everything else depends on.
2. **Do P7-1/P7-3 first and treat PDF/RTL/font fidelity (+ the Chromium bundle-size limit) as the
   go/no-go gate.** Prove Arabic Chromium rendering on the Revenue Report before scaling, and only
   after each design clears the P7-2 design→engine conformance gate.
3. **Ship reprint before regenerate.** Reprint is unambiguous and covers the stated requirements;
   regenerate waits on the founder's policy (Q1).
4. **Add the full `clinics` branding schema early** (P7-0) — email, website, license, **tax/VAT
   identifier, custom footer, and the extensible metadata bag** (doc 11 §5, the P7C model), on top of
   the `fix_clinics_cross_tenant_policies` RLS hardening — so no document renders with blank identity
   and the invoice is a compliant "Tax Invoice."
5. **Keep the document formatter and Chromium runtime behind their own modules** with a lint rule
   preventing templates from bypassing them — protects the two invariants most likely to drift
   (Latin digits, render fidelity).
6. **Resolve the open questions (§4) before P7-6/P7-7** — they gate clinical documents, invoice
   delivery, and regenerate.
7. **Reuse aggressively** (doc 12): authorization, catalog pattern, audit, i18n, fonts, design
   system, report resolvers, storage, messaging — introduce net-new only where doc 12 §2 lists it.
