# 04 · Shared Component Analysis

## Objective

Enumerate the **Layer-1 primitive library** — the shared building blocks every document is
composed from — and the design tokens (typography, spacing, color) they use. This is the
"reuse budget": build these once, and the 16 templates become thin.

> Tokens below are **derived from the Figma designs** (the design source of truth) and
> expressed on the existing ClinicFlow design system (shadcn + Tailwind v4). Screenshots were
> a cross-check only. Exact values are read from Figma during implementation.

---

## 1. Primitive inventory & document coverage

| Primitive | Purpose | Used by (documents) |
|-----------|---------|---------------------|
| `DocumentHeader` | Logo + clinic identity (leading) · title + metadata block (trailing) · rule | **all 16** |
| `DocumentFooter` | System attribution · page numbers · copyright · links | **all 16** |
| `VerificationBlock` | QR + "scan to verify" caption + optional auth key | 01, 03, 04, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16 (all issued) |
| `SectionHeader` | Section title with accent bar / icon | most (01, 05, 07, 08, 10, 12, 15, …) |
| `StatCardRow` | Row/grid of KPI stat cards (label + big value + sub) | 01, 02, 08, 09, 10, 11, 12, 13, 16 |
| `DataTable` | Tinted header row, divider/zebra rows, end-aligned numeric cols, optional totals row | 01, 02, 05, 08, 09, 10, 11, 12, 13, 15, 16 |
| `GroupedTables` | Section-grouped tables with per-group count badge | 03, 14 |
| `TotalsSummary` | Grand-total / summary strip or card cluster | 01, 10, 16 |
| `FieldGrid` | Two-column label/value grid | 04, 15, (patient/physician blocks in 05, 07) |
| `IdentityHero` | Prominent subject card (initials/photo + name + id + status) | 04, 15, (16 bill-to) |
| `NotesCallout` | Tinted rounded panel with label (notes/instructions/remarks) | 01, 05, 06, 07, 08, 09, 10, 11, 12, 15, 16 |
| `CertifyingProse` | Legal certifying paragraph with inline emphasized fields | 06 |
| `ChecklistPanel` | Grouped checkbox test list (checked/unchecked) | 07 |
| `StatusBadge` | Pill status (ACTIVE, COMPLETED, PARTIALLY PAID, VALID …) | 02, 03, 04, 14, 15, 16 |
| `SignatureBlock` | Labelled signature line(s); optional stamp/seal slot | **all 16** (1–2 per doc) |
| `Watermark` | Behind-content diagonal mark (engine-managed) | all (DRAFT preview; per settings issued) |

15 primitives cover 100% of the 16 documents. Only `CertifyingProse` (06) and `ChecklistPanel`
(07) are single-document today — both are simple and worth having as named primitives for
future clinical documents.

---

## 2. Typography

Fonts are fixed to the existing families — **no new fonts, no substitutions** (correction #2):

| Role | Family | Notes |
|------|--------|-------|
| Arabic text | **Thmanyah Sans** (`--font-thmanyah`) | weights 300/400/500/700/900; **no 600** — a `600` request resolves to 700 |
| Latin text | **Manrope** (`--font-manrope`) | variable weight |
| Digits (all languages) | Latin glyphs always | via forced `numberingSystem:'latn'` (doc 03 §3) |

Type scale (roles derived from the designs; mapped to Tailwind tokens at build):

| Token | Use | Weight |
|-------|-----|--------|
| Display | Document title ("REVENUE REPORT", "INVOICE") | 700–900 |
| H2 | Section headers | 700 |
| H3 | Card/table headers, subject name | 600→700 (Arabic 700) |
| Body | Table cells, field values, prose | 400–500 |
| Label | Field labels, captions ("REPORT ID", "SCAN TO VERIFY") | 500, uppercase, tracked |
| Micro | Footer attribution, refs, page numbers | 400 |

RTL note: Arabic uses no uppercase; "label" styling in Arabic relies on weight/size/color, not
letter-casing.

---

## 3. Spacing & layout tokens

- **Page:** A4 with a generous symmetric content margin; a fixed content column width.
- **Header rule:** a single heavy horizontal rule separates header from body across all docs.
- **Vertical rhythm:** consistent section gap; card/table internal padding shared via the
  primitive, not per template.
- **Card grid:** stat cards use a 3–6 column responsive row that collapses gracefully; gaps and
  radii are shared tokens.
- **Tables:** shared row height, header tint, divider color, and end-aligned numeric columns.
- **Logical spacing:** all paddings/margins use logical properties so RTL mirrors without
  bespoke values (doc 03 §2).

---

## 4. Color tokens

Derived from Figma; expressed as document-scoped CSS variables on the existing palette:

| Token | Approx. role | Usage |
|-------|-------------|-------|
| `--doc-ink` | Dark navy | Titles, headings, strong text, header rule |
| `--doc-accent` | Teal | Section accent bars, links, emphasis, KPI accents |
| `--doc-panel` | Light blue tint | Callouts, stat cards, table header fill, hero card |
| `--doc-panel-strong` | Deeper tint / navy fill | Emphasis cards (e.g. "AMOUNT DUE", grand totals) |
| `--doc-muted` | Grey | Labels, captions, secondary text, dividers |
| `--doc-success` / `--doc-warning` / `--doc-danger` | Green / amber / red | Status badges, semantic figures (outstanding, owed) |
| `--doc-paper` | White | Page background (documents always render light) |

Exact hex values are read from Figma at implementation and registered as document tokens so a
future rebrand is a single-file change.

---

## 5. Header & footer specification (shared across all 16)

**Header (`DocumentHeader`):**
- Leading side: clinic **logo** + **name** + a contact line (address · phone · license · email).
- Trailing side: **document title** + a metadata stack (document number, issue date, optional
  time, period/date-range).
- Bottom: the heavy rule.
- Direction-aware: leading/trailing swap by `dir`; digits Latin; codes/emails/phones bidi-isolated.

**Footer (`DocumentFooter`):**
- Leading: system attribution + copyright.
- Trailing: `Page X of N`; optional Terms/Privacy/Verify links.
- Optional QR slot (some designs place the QR in the footer; others in the body callout).

Both pull branding from the single injected context.

---

## 6. Signature & stamp zones

- `SignatureBlock` renders one or more labelled lines ("Authorized Signature", "Medical
  Director Signature", "Physician's Signature", "Clinic Administrator", "Patient Signature").
- Count and labels vary by document (1 for reports, 2 for patient list / invoice / patient
  file); the primitive accepts a list.
- Clinical/financial documents (05, 06, 07, 16) add a **stamp/seal** slot beside the signature.
- Signature blocks declare `break-inside: avoid` so they never split across pages.

---

## 7. Body archetype → primitive composition (quick reference)

| Archetype | Typical composition |
|-----------|--------------------|
| Analytical | `SectionHeader` → `StatCardRow` → `DataTable`(+totals) → `NotesCallout` → `SignatureBlock`/`VerificationBlock` |
| Roster | `GroupedTables` (repeat per department) → `NotesCallout` → `SignatureBlock` + `VerificationBlock` |
| Profile | `IdentityHero` → `FieldGrid` (+ `DataTable` schedule for staff) → `NotesCallout` → `SignatureBlock` + `VerificationBlock` |
| Clinical | patient `FieldGrid` + physician `FieldGrid` → `DataTable`/`ChecklistPanel`/`CertifyingProse` → `NotesCallout` → `SignatureBlock`(+stamp) + `VerificationBlock` |
| Financial | bill-from + `IdentityHero`(bill-to) + `StatusBadge` → `TotalsSummary` cards → `DataTable`(line items) → `NotesCallout` + payment breakdown → `SignatureBlock` ×2 + `VerificationBlock` |

This table is the blueprint each Layer-2 template follows — which is why templates are small.
