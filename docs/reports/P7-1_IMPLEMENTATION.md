# P7-1 Document Rendering Engine Implementation Report

**Date:** 2026-08-01  
**Branch:** `feat/p7-document-platform`  
**Scope:** P7-1 only — document page composition, shared primitives, bilingual rendering harness, verification QR generation, and server-side PDF rendering

## Outcome

P7-1 is implemented on top of the approved P7-0 foundations. The implementation provides the shared A4 document engine and primitive contract required by later template phases without adding any P7-2 templates, Documents-module product routes, issuance lifecycle actions, or public verification endpoints.

All automated checks pass. A real headless-Chromium PDF roundtrip could not be executed in the managed workspace because the sandbox denied the `tsx` IPC socket and did not permit the escalated browser launch. The renderer and a repeatable Arabic PDF validation script are included, but runtime visual/font inspection remains an external validation item.

## Functionality Implemented

### Layer 0: `DocumentPage`

- A4 portrait and landscape page composition with 15 mm document margins.
- A single CSS source shared by the on-screen harness, browser print, and Chromium PDF renderer.
- Centralized document header, footer, identity band, lifecycle watermark, page direction, language, and pagination context.
- Lifecycle-safe watermark behavior:
  - preview artifacts always render `DRAFT` / `مسودة`;
  - issued artifacts may disable the watermark;
  - issued blank watermark text falls back to the clinic name.
- Print isolation, repeated table header/footer chrome, fixed watermark behavior, and break-avoidance rules for document blocks.
- Logical CSS properties and explicit bidi isolation for identifiers, codes, phone numbers, amounts, and other LTR data inside Arabic documents.

### Layer 1: shared primitives

The frozen P7-1 contract covers the following primitives:

1. `DocumentHeader`
2. `DocumentFooter`
3. `VerificationBlock`
4. `SectionHeader`
5. `StatCardRow`
6. `DataTable`
7. `GroupedTables`
8. `TotalsSummary`
9. `FieldGrid`
10. `IdentityHero`
11. `NotesCallout`
12. `CertifyingProse`
13. `ChecklistPanel`
14. `StatusBadge`
15. `SignatureBlock`

The primitives accept generic presentation data, omit absent optional fields, avoid domain-specific data fetching, and preserve the separation between the rendering engine and later Layer 2 templates.

### Bilingual implementation harness

- Added a protected developer harness at `/documents/engine-harness`.
- Includes explicit English and Arabic fixtures that exercise every P7-1 primitive.
- Exercises preview and issued lifecycle behavior, numeric isolation, long content, verification, signature, totals, grouped tables, and status variants.
- The harness is an implementation surface only and is not the P7-4 Documents module.

### Verification QR generation

- Generates QR PNG data URIs with `qrcode`.
- Constructs only the canonical `https://clinicflow.fit/verify/<opaque-token>` URL.
- Validates opaque tokens before URL construction and rejects unsafe/path-like input.
- `VerificationBlock` accepts embedded `data:image/...` QR sources and rejects remote image placeholders.

### Server-side PDF renderer

- Renders React document content to a complete static HTML document.
- Uses `puppeteer-core` with `@sparticuz/chromium`, with local Chrome discovery for development and an explicit executable-path override.
- Inlines local Manrope and Thmanyah WOFF2 fonts as data URLs; PDF rendering requires no font CDN or other runtime network access.
- Aborts all page network requests except `data:` and `about:` resources and disables page JavaScript.
- Uses print media, A4 output, background graphics, tagged PDF output, and guaranteed browser cleanup.
- Keeps Chromium external to the Next.js server bundle and explicitly traces the local font files.

### Frozen contract

`docs/designs/document-platform/P7-1_PRIMITIVE_CONTRACT.md` records the approved prop contracts, direction and digit rules, degradation behavior, pagination ownership, shared tokens, renderer guarantees, and the restrictions later template work must respect.

## Dependencies

Only the dependencies explicitly approved for P7-1 were added:

- `puppeteer-core` `^25.4.0`
- `@sparticuz/chromium` `^149.0.0`
- `qrcode` `^1.5.4`
- `@types/qrcode` `^1.5.6` (development)

No other dependency was added.

The operational dependency-size gate is 120 MiB. Installed package sizes resolved through pnpm symlinks are:

| Package | Size |
| --- | ---: |
| `@sparticuz/chromium` | 66.48 MiB |
| `puppeteer-core` | 7.80 MiB |
| `qrcode` | 0.23 MiB |
| **Total** | **74.51 MiB** |

## Tests Added

- `tests/unit/components/p71-document-engine.test.tsx`
  - English and Arabic document composition
  - direction and bidi isolation
  - preview/issued watermark boundaries
  - primitive omission and rendering behavior
  - embedded verification-image boundary
- `tests/unit/lib/p71-document-verification-qr.test.ts`
  - canonical URL construction
  - unsafe token rejection
  - QR data URI generation
- `tests/unit/lib/p71-document-pdf.test.tsx`
  - complete offline HTML output
  - local font embedding
  - Arabic direction and renderer security defaults
- `tests/unit/lib/p71-document-bundle-size.test.ts`
  - explicit 120 MiB operational dependency-size gate
  - runtime font files are present and tracked for clean checkouts/builds

Focused result: **4 test files, 16 tests passed**.

## Validation Results

| Validation | Result |
| --- | --- |
| Focused P7-1 Vitest suite | Pass — 4 files, 15 tests |
| Full non-integration test command (`pnpm test`) | Pass — exit code 0 |
| TypeScript (`pnpm typecheck`) | Pass |
| ESLint (`pnpm lint`) | Pass — 0 errors; 24 existing repository warnings |
| RTL gate (`pnpm lint:rtl`) | Pass — 517 files; 10 documented exceptions |
| i18n gate (`pnpm lint:i18n`) | Pass — 348 files; 33 documented exceptions |
| Locale parity (`pnpm i18n:missing`) | Pass — 3,260 base leaf messages |
| Production build (`pnpm build`) | Pass; existing Next.js middleware-convention deprecation warning remains |
| Dependency-size gate | Pass — 74.51 MiB of 120 MiB |
| Runtime font packaging gate | Pass — every PDF font source is present and tracked by Git |
| Whitespace/error check (`git diff --check`) | Pass |
| Live Arabic Chromium PDF roundtrip | **Blocked by managed sandbox** — `tsx` IPC socket returned `EPERM`; escalated headless-browser execution was not permitted |

The included external roundtrip command is:

```bash
pnpm exec tsx scripts/validate-p71-document-engine.tsx /tmp/clinicflow-p71-ar.pdf
```

## Files Changed for P7-1

### Configuration and dependency metadata

- `next.config.ts`
- `package.json`
- `pnpm-lock.yaml`
- `scripts/i18n-allowlist.json`

### Document engine and harness

- `app/(protected)/documents/engine-harness/page.tsx`
- `app/fonts/manrope/manrope-latin-variable.woff2`
- `components/documents/engine/document-page.tsx`
- `components/documents/engine/index.ts`
- `components/documents/engine/render-context.tsx`
- `components/documents/engine/styles.ts`
- `components/documents/engine/types.ts`
- `components/documents/harness/document-engine-harness.tsx`
- `components/documents/primitives/certifying-prose.tsx`
- `components/documents/primitives/checklist-panel.tsx`
- `components/documents/primitives/data-table.tsx`
- `components/documents/primitives/document-footer.tsx`
- `components/documents/primitives/document-header.tsx`
- `components/documents/primitives/field-grid.tsx`
- `components/documents/primitives/grouped-tables.tsx`
- `components/documents/primitives/identity-hero.tsx`
- `components/documents/primitives/index.ts`
- `components/documents/primitives/notes-callout.tsx`
- `components/documents/primitives/section-header.tsx`
- `components/documents/primitives/signature-block.tsx`
- `components/documents/primitives/stat-card-row.tsx`
- `components/documents/primitives/status-badge.tsx`
- `components/documents/primitives/totals-summary.tsx`
- `components/documents/primitives/verification-block.tsx`

### PDF and verification utilities

- `lib/documents/pdf/fonts.ts`
- `lib/documents/pdf/html.tsx`
- `lib/documents/pdf/index.ts`
- `lib/documents/pdf/render.ts`
- `lib/documents/verification-qr.ts`
- `scripts/validate-p71-document-engine.tsx`

### Contract, report, and tests

- `docs/designs/document-platform/P7-1_PRIMITIVE_CONTRACT.md`
- `docs/reports/P7-1_IMPLEMENTATION.md`
- `tests/unit/components/p71-document-engine.test.tsx`
- `tests/unit/lib/p71-document-bundle-size.test.ts`
- `tests/unit/lib/p71-document-pdf.test.tsx`
- `tests/unit/lib/p71-document-verification-qr.test.ts`

## Roadmap Boundaries Preserved

- No Layer 2 document template was implemented.
- No P7-2 patient file or prescription behavior was implemented.
- No issuance, regeneration, revocation, or document persistence action was added.
- No public `/verify/[token]` route was added.
- No Documents-module navigation or product UI was added.
- Existing P7-0 code, migrations, documentation, report, and review remain untouched by P7-1 work except where P7-1 intentionally reuses their exported foundations.
- No commit, push, branch switch, or pull request was performed.

## Blockers and Deviations

1. **Live PDF roundtrip validation is blocked in this managed environment.** The sandbox denied the `tsx` IPC socket and the required headless-browser escalation. The implementation, build, static renderer tests, font-embedding tests, request-isolation tests, and cleanup behavior are present and passing, but a generated PDF was not visually inspected here.
2. **Two relevant Figma intake references are empty.** The Patient File and Prescription `FIGMA_REFERENCE.md` files contain no node reference. P7-1 styling was therefore verified against the available approved representative archetypes (revenue, patient list, laboratory, staff, and English/Arabic invoice) while intentionally avoiding P7-2 template inference.
3. **Manrope was previously available only through Next.js-generated font output.** To satisfy the approved offline-rendering architecture, the exact existing Manrope Latin variable WOFF2 used by the application is stored as the tracked runtime asset `app/fonts/manrope/manrope-latin-variable.woff2`; a regression gate verifies that every PDF font source remains present and tracked for clean checkouts and builds. This adds neither a font family nor a dependency. Thmanyah continues to use the repository's licensed local files.

There are no implementation-scope deviations from P7-1 beyond these documented validation and design-intake constraints.
