# 03 · Shared Rendering Engine

## Objective

Specify the **one** reusable engine that renders every document. It owns everything that
must be identical across all 16 types and both languages: page geometry, direction, digits,
bidi, branding, watermark, page numbering, QR placement, and the path from a React template
to a printed page and a stored PDF.

The engine is `<DocumentPage>` (Layer 0) plus a rendering **context** that the Layer-1
primitives consume. A per-document template never re-implements any of this.

---

## 1. Page geometry & print model

- **Paper:** A4 portrait default (confirmed from the designs' proportions); the catalog/
  settings can later override per type. Landscape is available for wide tables (e.g. the
  Doctor Performance wide table) but defaults to portrait.
- **Print CSS:** documents render inside an `@page { size: A4; margin: … }` context with a
  fixed content width and a print-safe color model (always the light "paper" theme,
  regardless of the app's dark mode — documents are printed artifacts, not themed UI).
- **Multi-page:** the engine manages running header/footer and `Page X of N` numbering.
  Body primitives declare page-break behavior (`break-inside: avoid` on cards/rows/signature
  zones) so tables split cleanly and signatures never orphan.
- **Fixed regions:** header band, footer band, and watermark are positioned by the engine;
  the body scrolls/flows between them.

---

## 2. Direction (RTL / LTR) with preserved visual balance

Requirement: each document has a **separate Arabic RTL design and English LTR design**
(SHARED_REQUIREMENTS §1), and the Arabic version must preserve **layout, spacing,
typography, alignment, and visual balance** — not a naive auto-flip.

Approach:
- `<DocumentPage dir={localeDirection(locale)}>` sets `dir="rtl"` or `"ltr"` (reusing
  `localeDirection` from `lib/i18n/config.ts`).
- Primitives are authored with **CSS logical properties** (`margin-inline-start`,
  `padding-inline`, `inset-inline`, `text-align: start/end`, `border-inline-start`) so the
  same component mirrors correctly by direction: the logo sits on the leading side, the title
  on the trailing side, tables reverse column order, accent bars flip — automatically and
  *balanced*, exactly as the AR screenshots show.
- **No blind mirroring of things that must not flip:** the QR module, embedded Latin runs,
  and numeric columns keep their intrinsic direction (see §4). Icons that encode direction
  (e.g. progress/trend arrows) are chosen per direction, not transform-flipped.
- Because AR and EN are the *same primitives under a different `dir` + translated content*,
  we satisfy both "separate deliberate Arabic design" (we build and review it explicitly) and
  "no duplication" (one template, two directions). Where a document's AR design differs
  structurally from a pure mirror, the template branches on `dir` for that region only.

---

## 3. Latin (English) digits — always

Requirement: **all numeric values use Latin digits 0–9 in every document, including Arabic
ones** (global requirement + correction #3).

The app's existing formatters (`lib/datetime.ts`, `lib/currency/format.ts`) honor a per-clinic
`digits: "latin" | "arabic"` setting via `toNumberingLocale()`. **Documents must ignore that
setting and always use Latin digits.** This is a deliberate, documented divergence.

Design:
- A document-scoped formatting layer `lib/documents/format.ts` exposes `formatDocNumber`,
  `formatDocMoney`, `formatDocDate`, `formatDocTime`, `formatDocPercent`. Each wraps the same
  `Intl.NumberFormat` / `Intl.DateTimeFormat` the app already uses **but forces
  `numberingSystem: 'latn'`**, independent of `ClinicLocale.digits`.
- Currency, percentages, dates, times, counts, IDs, and phone numbers all route through this
  layer. The Arabic *text, labels, and layout* remain Arabic; only the **glyphs of digits** are
  Latin — matching every AR screenshot (e.g. `TRY 6,100.00`, `24 مايو 2024`, `RX-2024-9912`).
- The `<DocumentPage>` render context carries a `digits: 'latn'` flag so no primitive can
  accidentally fall back to the clinic's Arabic-digit preference.

---

## 4. Mixed-content bidi handling

Requirement (correction #4): drug names, document numbers, codes, phone numbers, emails,
URLs, and QR payloads must render correctly inside RTL context without reordering.

Design:
- **Isolation:** LTR atoms embedded in RTL text are wrapped in `<bdi>` (or a
  `unicode-bidi: isolate` primitive, `<LtrRun>` / `<Code>`), so the bidi algorithm treats
  each as a neutral, self-contained run. This prevents the classic breakage where
  `+90 532 481 72 94` or `Amoxicillin 500mg` gets visually scrambled in an Arabic paragraph.
- **Explicit direction on known-LTR fields:** document numbers, license/registration codes,
  emails, URLs, and phone numbers render in an `dir="ltr"` inline box with `text-align`
  following the surrounding column, so the *value* stays LTR while its *placement* respects
  the RTL layout (exactly as the AR prescription shows `PAT-8821#` and `RX-2024-9912`).
- **QR payload:** the verification URL encoded in the QR is a plain ASCII LTR string; the QR
  image itself is direction-neutral and positioned by the engine (leading/trailing per design),
  never transformed.
- **Numbers in tables:** numeric columns are `dir="ltr"` and end-aligned within the cell,
  independent of table direction, so digit groups and decimals read correctly in both languages.
- A lint/QA checklist (doc 14) calls out bidi review as a required visual check per document.

---

## 5. Watermark

Requirement (SHARED_REQUIREMENTS §12–§13 + founder decision): per-document-type
**enable/disable toggle + custom text**; empty text defaults to the **clinic name**; sits
**behind** content; must not obstruct content/signatures/tables/QR; correct in AR and EN.

Design:
- The engine renders a single watermark layer behind the body (`position: absolute; inset: 0;
  z-index: 0; pointer-events: none; opacity: low`), with the body on a higher stacking layer.
- **Preview** always shows a `DRAFT` watermark (ties watermark to lifecycle state — a preview
  is never an issued document; see doc 05). The AR/EN previews confirm placeholder
  "DRAFT/OFFICIAL" diagonal marks.
- **Issued** documents show the effective watermark from settings: the per-type custom text if
  enabled and non-empty, else the clinic name, or nothing if the type's watermark is disabled.
- Rendered as large, low-opacity, rotated text using the direction-appropriate font (Thmanyah
  for Arabic text, Manrope for Latin), centered and sized to avoid overlapping signatures/QR.
- Settings source: `document_settings` per `doc_type` (doc 09, doc 11).

---

## 6. Clinic branding injection

All branding (logo, name, address, phone, email, website, license) is resolved **once** from
Clinic Settings and injected into `DocumentHeader`/`DocumentFooter` via the render context —
never duplicated per template (SHARED_REQUIREMENTS §4). The current `clinics` table supplies
`name, phone, logo_url, address`; **email, website, and license/registration are gaps** to add
(doc 11 §5). Missing optional fields (e.g. website) are simply omitted from the header line.

---

## 7. Document identity block

The engine renders the identity metadata consistently (SHARED_REQUIREMENTS §4): document
title, **document number**, issue date, optional issue time, and period/date-range where the
type has one. In **preview** the number shows a placeholder (`PREVIEW` / `—`); on **issue** it
shows the permanent allocated number. `Page X of N` is engine-managed.

---

## 8. QR placement

The `VerificationBlock` primitive holds the QR + "scan to verify" caption. Placement varies by
design (footer-leading, footer-trailing, or a bordered callout in the body) — the template
chooses the slot, the engine guarantees the QR is a real, scannable code (not the placeholder
seen in the Stitch exports, which are explicitly non-production per SHARED_REQUIREMENTS §5).
QR generation and payload are specified in doc 07.

---

## 9. The render pipeline (template → outputs)

```
Layer-2 template  +  resolved data  +  render context (locale, dir, digits:'latn', branding, watermark)
        │
        ├─▶ Browser (React)         → interactive preview
        ├─▶ Browser window.print()  → walk-up paper (same DOM, @media print)
        └─▶ Headless Chromium       → canonical PDF (server), stored in the documents bucket
```

### Chromium specifics (font fidelity is the risk that this design neutralizes)
- Runtime: `puppeteer-core` + `@sparticuz/chromium` in a **Node serverless / Fluid Compute**
  function (not Edge). Timeouts are comfortable (platform default is generous).
- **Fonts:** the template's CSS inlines `@font-face` for **Thmanyah Sans** (Arabic) and
  **Manrope** (Latin) from the local `.woff2` files already in the repo (`app/fonts/…`), so the
  headless browser has the exact faces — Arabic renders correctly with no substitution
  (correction #2). No web/CDN fonts (matches the app's local-font policy).
- **Determinism:** Chromium prints to A4 PDF with `printBackground: true` so gradients/tinted
  panels survive. The same HTML that previews on screen is what is printed → zero divergence.
- **Attachments (Patient/Staff File):** after rendering the profile page to PDF, selected
  stored attachments (images/PDFs, already MIME-limited to pdf/jpg/png/webp) are appended using
  `pdf-lib` to produce one merged PDF (doc 09 §5, doc 11 §6).

### Why not the alternatives
`@react-pdf/renderer` cannot reproduce these HTML/CSS designs (gradients, complex RTL tables,
custom fonts) without re-authoring all 16 in its own primitives — duplicating the very thing
this engine removes. Imperative libs (`pdfkit`/`pdfmake`) are worse. Full comparison: doc 14.

---

## 10. What the engine guarantees (summary)

| Guarantee | Mechanism |
|-----------|-----------|
| Consistent header/footer/identity | Layer 0 owns them; templates can't drift |
| Correct RTL/LTR + balance | logical CSS + `dir`; deliberate AR design |
| Latin digits everywhere | forced `numberingSystem:'latn'` context |
| Correct mixed-content order | `<bdi>`/isolation + explicit `dir` on LTR atoms |
| Branding from settings only | single injected context |
| Watermark rules | engine overlay + `document_settings` + lifecycle |
| Real, scannable QR | `VerificationBlock` + generator (doc 07) |
| Screen == print == PDF | one template, three renderers |
| Arabic font fidelity in PDF | inlined local Thmanyah `@font-face` in Chromium |
