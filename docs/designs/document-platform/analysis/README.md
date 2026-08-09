# ClinicFlow Document Platform — Engineering Analysis

**Status:** Planning deliverable. This directory is **analysis and roadmap only** — no
production code, migrations, dependencies, components, or PDFs are created by this work.
It is the engineering plan to be reviewed and approved before any implementation begins.

**Inputs studied:** all 16 imported document designs (Arabic RTL + English LTR), each
document's Figma reference, and the shared requirements in
[`../shared/SHARED_REQUIREMENTS.md`](../shared/SHARED_REQUIREMENTS.md); plus the existing
ClinicFlow codebase (Next.js 16 App Router + Supabase + next-intl + shadcn/Tailwind v4).

> **Design Source of Truth.** For every document, the **Figma design (via MCP) is the only
> source of truth**. The imported screenshots are a **quick visual reference only** and must
> never override the Figma design during implementation.

---

## How to read this analysis

Read in order. Each file is self-contained but assumes the ones before it.

| # | File | What it answers |
|---|------|-----------------|
| — | [`README.md`](README.md) | This index + the executive summary below |
| 01 | [`01-platform-architecture.md`](01-platform-architecture.md) | The overall system: layers, modules, data & render flow |
| 02 | [`02-document-catalog-and-taxonomy.md`](02-document-catalog-and-taxonomy.md) | All 16 documents classified; per-document catalog rows |
| 03 | [`03-shared-rendering-engine.md`](03-shared-rendering-engine.md) | The one reusable engine: RTL/LTR, bidi, digits, watermark, QR, PDF |
| 04 | [`04-shared-component-analysis.md`](04-shared-component-analysis.md) | The shared primitive library + typography/spacing/color tokens |
| 05 | [`05-document-lifecycle.md`](05-document-lifecycle.md) | Preview → issue → print → reprint → regenerate → void |
| 06 | [`06-document-numbering.md`](06-document-numbering.md) | Numbering strategy + justification |
| 07 | [`07-verification.md`](07-verification.md) | QR + the public verification page |
| 08 | [`08-documents-module.md`](08-documents-module.md) | The Documents module (list, filters, actions) |
| 09 | [`09-documents-settings.md`](09-documents-settings.md) | The Documents Settings page |
| 10 | [`10-document-history.md`](10-document-history.md) | History / audit trails |
| 11 | [`11-data-model.md`](11-data-model.md) | Proposed schema + storage |
| 12 | [`12-integration-and-reuse-map.md`](12-integration-and-reuse-map.md) | What we reuse vs what is net-new |
| 13 | [`13-implementation-roadmap.md`](13-implementation-roadmap.md) | Phases, sub-phases, dependencies, order |
| 14 | [`14-risks-assumptions-recommendations.md`](14-risks-assumptions-recommendations.md) | Self-review, risks, assumptions, open questions |

---

## Scope & roadmap note (reconciliation)

- **Committed document set.** This **16-document** design-intake set is the **authoritative,
  committed Phase 7 document set** and **supersedes** the earlier 8-document P7A catalog
  (`docs/documents/`) and the original list in `AI_AGENT_PLAN.md` §8. Receipt, medical report,
  referral, and consent forms are **deferred** (doc 02 §6). `AI_AGENT_PLAN.md` §8 and
  `docs/documents/README.md` are updated to record this.
- **Phase naming.** The engineering phases in [`13-implementation-roadmap.md`](13-implementation-roadmap.md)
  are named **`P7-0` … `P7-10`** (inside master-roadmap Phase 7), **restructuring and superseding the
  old `P7C`/`P7D`/`P7E` split** — so they never collide with the project-level `P0–P7` phases. `P7A`
  (catalog) is done (scope now the 16-set); `P7B` (approved designs) is satisfied by the imported
  designs, subject to the **P7-2 design→engine conformance gate**.

## Executive summary

### The problem
Sixteen distinct printed/exported documents (financial reports, operational reports,
staff/patient rosters, entity profiles, clinical documents, and an invoice) must be
generated in both Arabic (RTL) and English (LTR), each carrying a shared clinic identity,
a unique server-issued number, a QR verification mark, and an optional watermark — with
consistent branding and near-zero template duplication.

### The core insight
Studied as **one ecosystem** rather than 16 separate designs, every document is the same
skeleton — **shared header → body → shared footer** — and the bodies reduce to a small set
of recurring building blocks (KPI stat cards, data tables, grouped tables, field grids,
identity heroes, notes callouts, signature blocks, status badges, verification blocks),
plus a handful of bespoke bodies. This makes a **single shared rendering engine + a small
primitive library + thin per-document templates** the right architecture — not 16 bespoke
templates, and not an over-engineered fully-declarative document engine.

### The architecture in one picture
```
DOCUMENT_CATALOG (registry: 1 entry per type)
        │  discovery • permissions • filters • numbering prefix • data resolver • template
        ▼
Per-document template  (Layer 2 — ~16 thin compositions)
        │  composes ↓
Document primitive library (Layer 1 — header, footer, tables, cards, signatures, QR …)
        │  wrapped by ↓
<DocumentPage> chrome (Layer 0 — A4, direction, branding, watermark, page numbers)
        │  rendered two ways ↓
Browser print  ───────────────┐        Headless Chromium (server)
(interactive preview/print)   │        (canonical stored PDF: issue, reprint, email, WhatsApp)
                              same HTML/React template — one source of truth
```

### Decisions locked with the founder
1. **Rendering:** one HTML/React template per document is the single source of truth,
   rendered on-screen and via **server-side headless Chromium** for the canonical stored
   PDF. No design re-authoring; perfect RTL + font fidelity.
2. **Numbering:** **per-clinic + per-document-type**, atomic and server-side, allocated
   only at issue, never reused; the full visible number is stored **immutably**.
3. **Verification:** **QR** encoding an opaque token → a public page that discloses only
   safe metadata.
4. **Watermark:** per-type **enable/disable toggle + custom text** (defaults to clinic
   name); preview always shows a `DRAFT` watermark.
5. **Fonts:** existing **Thmanyah Sans** (Arabic) + **Manrope** (Latin) only — no new fonts.
6. **Digits:** **Latin (0–9) always**, including Arabic documents, with RTL layout,
   spacing, typography, alignment, and visual balance fully preserved and correct bidi
   handling for mixed content.
7. **Snapshot-at-issue:** issued documents freeze their data + canonical PDF so **reprint**
   re-serves the original, while **regenerate** produces a new numbered document from
   current data (regenerate semantics deliberately left open — see doc 14).

### What is reused vs net-new
- **Reused:** RBAC, roles, the page/report visibility model, `activity_events` audit,
  next-intl + `localeDirection`, the shadcn/Tailwind design system, the Thmanyah/Manrope
  fonts, clinic-scoped Supabase + RLS, storage/signed-URL patterns, the reports data
  layer, TanStack Table, nuqs, resend, and the WhatsApp messaging layer.
- **Net-new:** the document rendering engine + primitive library, the `DOCUMENT_CATALOG`,
  the documents/counters/settings tables, the PDF render runtime (Chromium), QR + PDF-merge
  dependencies, the public verification route, a Latin-digit document formatter layer, the
  **expanded clinic branding schema** (tax/VAT, custom footer, metadata bag; doc 11 §5), and the
  **two net-new analytical resolvers** — Sales Report and Follow-up Analytics — which have no existing
  report resolver (doc 02 §5).

### Requirements coverage
Every shared requirement §1–§16 is traced to a section in
[`12-integration-and-reuse-map.md`](12-integration-and-reuse-map.md#requirements-traceability).
