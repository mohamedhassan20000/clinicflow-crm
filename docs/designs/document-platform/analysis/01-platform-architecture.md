# 01 · Platform Architecture

## Objective

Define the overall architecture of the ClinicFlow Document Platform: its layers, module
boundaries, how data flows from an existing clinic surface to an issued document, and how
one design renders identically to screen, print, and a stored PDF.

---

## 1. Design principles

1. **One skeleton, many bodies.** Every document is `shared header → body → shared footer`.
   The chrome is written once; only the body differs.
2. **Compose, don't duplicate.** Bodies are composed from a shared primitive library, not
   re-authored per document.
3. **Registry-driven.** A single `DOCUMENT_CATALOG` is the source of truth for discovery,
   permissions, filters, numbering, data resolution, and template selection — mirroring the
   proven `REPORT_CATALOG` pattern already in the codebase (`lib/reports/catalog.ts`).
4. **One template, two renderers.** The same React/HTML template drives the on-screen
   preview/print path and the server-side Chromium PDF path. There is never a second design.
5. **Issued documents are immutable.** Data and the canonical PDF are frozen at issue time.
6. **Reuse the platform.** Authorization, i18n, design tokens, fonts, audit, storage, and
   the reports data layer are reused, not reinvented.
7. **Figma is the design source of truth**; screenshots are quick reference only.

---

## 2. The four layers

```
┌───────────────────────────────────────────────────────────────────────────┐
│ Layer 3 — DOCUMENT_CATALOG (registry)                                       │
│   One entry per document type: code, titleKeys, category, permissions,      │
│   numbering prefix, filter schema, data-resolver ref, template ref,         │
│   verification disclosure fields, issuance trigger(s).                      │
└───────────────────────────────────────────────────────────────────────────┘
                                   │ selects
                                   ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ Layer 2 — Per-document templates (~16 thin compositions)                    │
│   e.g. RevenueReportTemplate, PrescriptionTemplate, InvoiceTemplate.        │
│   Pure presentation: receive typed, already-resolved data + locale/dir,     │
│   arrange Layer-1 primitives. No data fetching, no side effects.            │
└───────────────────────────────────────────────────────────────────────────┘
                                   │ composes
                                   ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ Layer 1 — Document primitive library                                        │
│   DocumentHeader, DocumentFooter, StatCardRow, DataTable, GroupedTables,    │
│   FieldGrid, IdentityHero, NotesCallout, SignatureBlock, StatusBadge,       │
│   VerificationBlock, SectionHeader, CertifyingProse, ChecklistPanel,        │
│   TotalsSummary. Built on the existing design tokens + fonts.               │
└───────────────────────────────────────────────────────────────────────────┘
                                   │ wrapped by
                                   ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ Layer 0 — <DocumentPage> chrome                                             │
│   A4 page geometry, print CSS, direction (rtl/ltr), clinic branding,        │
│   watermark, page numbering, QR placement, Latin-digit formatting context.  │
└───────────────────────────────────────────────────────────────────────────┘
```

Adding document #17 **normally touches only Layer 2 (a new template) and Layer 3 (a new
catalog entry).** A migration is required **only** when the new type needs new schema or new
persisted configuration (e.g. a genuinely new counter prefix stored in settings). Layers 0
and 1 stay untouched — this is the scalability guarantee.

### Why not the two alternatives (see doc 14 for the full self-review)
- **16 bespoke templates** → duplication of header/footer/watermark/QR/signature logic 16×;
  every cross-cutting change (a branding tweak, a numbering rule) becomes a 16-file edit.
- **Fully declarative JSON document engine** → over-engineered for 16 documents; the bespoke
  bodies (certifying prose, lab checkbox panels, invoice totals) fight a generic renderer.
  We keep the *registry* idea (declarative metadata) but keep *layout* as React composition.

---

## 3. Module boundaries

| Module | Location (proposed) | Responsibility |
|--------|--------------------|----------------|
| Catalog | `lib/documents/catalog.ts` | `DOCUMENT_CATALOG` registry (Layer 3) |
| Engine (chrome) | `components/documents/engine/` | `<DocumentPage>` + rendering context (Layer 0) |
| Primitives | `components/documents/primitives/` | Shared blocks (Layer 1) |
| Templates | `components/documents/templates/` | Per-document compositions (Layer 2) |
| Data resolvers | `lib/documents/resolvers/` | Type-specific server data fetch (reuse `lib/reports/data.ts`) |
| Formatting | `lib/documents/format.ts` | Latin-digit-always formatters + bidi helpers |
| Numbering | `lib/documents/numbering.ts` + RPC | Atomic per-clinic/per-type allocation |
| PDF render | `lib/documents/pdf/` | Chromium render + PDF merge |
| Verification | `app/(public)/verify/[token]/` | Public verification page |
| Actions | `actions/documents.ts` | issue / preview / reprint / regenerate / void |
| Module UI | `app/(protected)/documents/` | History list, filters, row actions |
| Settings UI | `app/(protected)/settings/documents/` | Documents settings |

These are proposed boundaries for the roadmap, not created here.

---

## 4. Data & render flow

### 4.1 Preview (no number consumed)
```
Surface (e.g. Revenue page) ──▶ actions/documents.previewX(params)
   requireRole(...)                        │
                                           ▼
                            data resolver (reuse reports RPC/RLS)
                                           │  resolved data
                                           ▼
                     Layer 2 template inside <DocumentPage> (dir + locale)
                                           │
                                           ▼
               on-screen preview  ·  watermark = DRAFT  ·  number = "PREVIEW"
```

### 4.2 Issue (allocates the permanent number, freezes the snapshot)
```
actions/documents.issueX(params)
   requireMutationRole(...)                                     ┌── activity_events (audit)
        │  1. allocate number  ── atomic RPC ──▶ document_counters
        │  2. resolve data (same resolver)                      └── document_events (lifecycle)
        │  3. persist `documents` row: number, token, snapshot(jsonb), params
        │  4. render canonical PDF (Chromium) ──▶ storage bucket (pdf_storage_path)
        ▼
   issued document (immutable)
```

### 4.3 Reprint vs regenerate
- **Reprint** → serve the **stored canonical PDF** from the snapshot. Same number, same QR,
  identical figures. Logs a `printed`/`reprinted` event.
- **Regenerate** → a **new** issue from **current** data → **new number**, new snapshot, new
  PDF. Never mutates the original. (Exact regenerate policy is left open — see doc 14.)

### 4.4 Delivery (invoice, per SHARED_REQUIREMENTS §16)
The stored PDF is the artifact handed to the existing **resend** (email) and **WhatsApp**
messaging layers. No re-render is needed for delivery.

---

## 5. The dual renderer (why one template can do all three outputs)

| Output | Renderer | Use |
|--------|----------|-----|
| Screen preview | React in the browser | Interactive preview before issue |
| Printed paper | Browser `window.print()` + `@media print` CSS on the same DOM | Walk-up printing |
| Stored PDF | Headless Chromium (`puppeteer-core` + `@sparticuz/chromium`) rendering the same template server-side, then "print to PDF" | Canonical artifact for issue/reprint/email/WhatsApp |

Because all three consume the **identical** template, RTL layout, Thmanyah/Manrope fonts,
gradients, rounded cards, and tables render pixel-consistently. Chromium is given the fonts
via inlined `@font-face` (local `.woff2`), guaranteeing Arabic fidelity in the headless
environment. Full engine detail is in [`03-shared-rendering-engine.md`](03-shared-rendering-engine.md).

---

## 6. Where documents are triggered

Two complementary entry points, both wired through the catalog:

1. **Contextual issuance** — deep links from the surface that owns the data (Revenue page →
   Revenue Report; patient profile → Patient File; visit workspace → Prescription/Lab/Sick
   leave; invoice/billing → Invoice; Reports pages → their report documents; Staff settings →
   Staff File / System Members).
2. **Centralized creation** — the Documents module lets an authorized user pick a type, fill
   its filter/params, preview, and issue.

The catalog entry declares each type's `issuanceTrigger` + `href`, so a surface never
hard-codes document knowledge.

---

## 7. Cross-cutting concerns (handled once, in the engine)

| Concern | Where handled | Reference |
|---------|--------------|-----------|
| RTL/LTR + visual balance | Layer 0 `<DocumentPage dir>` + logical CSS | doc 03 §2 |
| Latin digits always | Formatting context (`numberingSystem:'latn'`) | doc 03 §3 |
| Mixed-content bidi | `bdi`/isolation helpers in primitives | doc 03 §4 |
| Clinic branding | Injected once into `DocumentHeader`/`DocumentFooter` | doc 04 §3 |
| Watermark | Layer 0 overlay (DRAFT vs issued + toggle/text) | doc 03 §5 |
| Document identity/number | Layer 0 metadata block | docs 05, 06 |
| QR + verification | `VerificationBlock` + public route | doc 07 |
| Authorization | `requireRole` in actions + catalog `pageRoles` | doc 12 §1 |
| Audit/history | `document_events` + `activity_events` | doc 10 |

Because these live in the engine, a per-document template cannot get them wrong or drift.
