# P7-1 Frozen Document Primitive Contract

**Status:** Implemented and frozen by P7-1  
**Scope:** Layer 0 (`DocumentPage`) and Layer 1 shared primitives only  
**Design source:** approved architecture plus representative Figma frames for the analytical,
roster, clinical, profile, and financial archetypes. Per-document conformance remains P7-2.

## 1. Layer 0: `DocumentPage`

`DocumentPage` is the only document chrome owner. It requires:

- `locale: "ar" | "en"` and derives `dir` with `localeDirection`;
- `lifecycle: "preview" | "issued"`;
- the issue-time `branding` and `identity` snapshots;
- `watermark` settings;
- an optional `orientation` (`portrait` by default; `landscape` for approved wide tables);
- optional footer content and screen-preview page values.

It provides a render context containing locale, direction, the invariant `digits: "latn"`,
lifecycle, orientation, branding, and identity. Layer-2 templates must render inside
`DocumentPage`; they must not reproduce headers, footers, watermarks, page geometry, or font rules.

### Watermark rules

- Preview always renders `DRAFT` / `مسودة`, regardless of the issued watermark toggle/text.
- Issued + disabled renders no watermark.
- Issued + enabled uses trimmed custom text, falling back to the clinic name.
- It is pointer-inert, behind content, low opacity, and repeated by print media.

## 2. Layer-1 primitives

| Primitive | Required input | Optional/degradation contract | Pagination contract |
|---|---|---|---|
| `DocumentHeader` | branding + identity | logo falls back to clinic initial; absent contact fields are omitted without empty separators | repeated through the print table header group |
| `DocumentFooter` | branding | attribution, copyright, links, and verification slot omit independently | repeated through the print table footer group; screen values fall back to `1 of 1`; print uses page counters |
| `VerificationBlock` | inlined QR data URI, title, caption | verification key omits; remote/placeholder images are rejected | never split |
| `SectionHeader` | title | icon omits without spacing residue | never split from itself |
| `StatCardRow` | one or more cards | empty list renders nothing; detail omits | each card avoids splitting |
| `DataTable` | columns, rows, empty label | empty rows render one honest empty-state row; totals/caption omit | table header/footer groups repeat; body rows avoid splitting |
| `GroupedTables` | columns + groups | empty groups render nothing; group count omits | each group heading stays with its table where the browser permits |
| `TotalsSummary` | one or more items | empty list renders nothing; strong emphasis is opt-in | summary items avoid splitting |
| `FieldGrid` | label/value items | null, undefined, and empty-string values are removed; remaining items reflow | grid avoids splitting where possible |
| `IdentityHero` | name + initials | image, identifier, detail, and status omit independently; initials replace absent image | never split |
| `NotesCallout` | label + content | tone defaults to accent | never split |
| `CertifyingProse` | content | inline emphasis is supplied as React content | avoids splitting where possible |
| `ChecklistPanel` | groups/items | empty groups render nothing; unchecked rows remain visible and subdued | panel avoids splitting |
| `StatusBadge` | label | tone defaults to neutral | inline, never independently paginated |
| `SignatureBlock` | signature list | empty list renders nothing unless a stamp slot exists; stamp omits independently | entire signature zone never splits |

`Watermark` is engine-managed rather than template-callable.

## 3. Shared tokens

The document-scoped tokens confirmed across representative Figma frames are:

- ink `#001f35`, soft ink `#001b29`;
- accent `#006575`, bright accent `#0095ab`;
- panels `#ebf6f8`, `#e5f6ff`, `#f3fbff`;
- divider `#d7e4e7`, muted `#3d494c`;
- success `#00b26a`, warning `#f2a618`, danger `#ba1a1a`;
- A4 with 15 mm inline/top content margins and a 7–24 px type scale;
- 120 px, low-opacity watermark.

English uses the approved Manrope variable face. Arabic uses the approved licensed Thmanyah Sans
faces (300/400/500/700/900; no synthetic 600 contract). The PDF renderer embeds all font bytes as
data URIs; it performs no font/CDN request.

## 4. Direction, digits, and bidi

- CSS uses logical inline/block properties. No primitive relies on physical left/right placement.
- Document formatters force `nu-latn`; templates must not import app formatters.
- Codes, document numbers, phones, email, URLs, numeric table cells, and QR payloads use isolated
  LTR runs within RTL layouts.
- Arabic labels are never uppercased or letter-spaced.

## 5. Screen, browser print, and Chromium

All three paths consume `DOCUMENT_ENGINE_CSS` and the same React tree.

- Screen: centered light-paper A4 surface with a non-printing shadow/backdrop.
- Browser print: `@page`, exact print colors, repeated table header/footer groups, page counters,
  repeating watermark, and anti-orphan rules.
- Chromium: Node/Fluid runtime, `printBackground: true`, CSS page size preferred, JavaScript
  disabled, external requests aborted, fonts and QR inlined.

The Chromium package is externalized from the Next server chunk. The P7-1 operational gate is
120 MiB for the three approved renderer packages together, materially below the current Vercel
Function package ceiling.

## 6. Layer-2 constraints for P7-2+

A document template may compose these primitives and branch on direction for a genuinely different
Arabic region. It may not add document-specific chrome, bypass Latin-digit formatting, load remote
render assets, or silently introduce a new primitive. Any uncovered Figma region must be handled by
the P7-2 conformance gate before a template is implemented.
