# P7-2 Design-to-Engine Conformance and Cleanup Implementation

**Date:** 2026-08-01
**Branch:** `feat/p7-document-platform`
**Status:** COMPLETE — conformance gate passed

## Outcome

P7-2's in-repository conformance machinery, cleanup record, mappings, bilingual render proofs, and
focused tests are implemented. A targeted rerun inspected all 24 previously blocked variants and
did not re-query the eight already verified variants. All 32 variants now have authoritative Figma
inspection evidence. The founder decision resolves the final design inconsistency by normalizing
both Prescription variants to the platform's shared A4 portrait geometry. The frozen P7-1 contract
remains unchanged, and the P7-2 gate now passes for all 16 documents.

No production document template, resolver, issuance flow, registry expansion, delivery behavior,
or P7-3+ module work was added. No dependency was added. No branch switch, commit, push, or PR was
performed.

## Work completed

### 1. Source and contract audit

- Verified the active branch as `feat/p7-document-platform` and preserved the existing dirty P7
  worktree.
- Read the P7 analysis index, implementation roadmap, relevant architecture and risk documents,
  P7-1 implementation/review, the frozen primitive contract, Phase 7 plan, shared requirements,
  import guide, all 16 design notes, and all 32 `FIGMA_REFERENCE.md` files.
- Inspected every local Arabic and English design screenshot as a non-authoritative cross-check.
- Used Figma MCP as the design authority. Both variants of documents 01, 02, 06, and 07 were
  retrieved. The service quota was reached while retrieving document 03.
- Reran only the 24 previously blocked nodes: both variants of documents 03–05 and 08–16. Every
  requested design was reachable; no already verified variant was queried again.
- Found that Prescription English `12:522` was a valid watermark-only node. A read-only Figma parent
  trace resolved the complete page at `12:521`; the full page was inspected and the local reference
  was corrected.
- Updated the evidence manifest and focused assertions to 32 verified variants, 16 conformant
  documents, and zero frozen-engine conflicts.

### 2. Exact shared token mapping

- Confirmed the frozen P7-1 ink, accent, panel, divider, state, paper, A4, page-inset, typography,
  spacing, radius, and watermark tokens against the successfully retrieved nodes.
- Recorded exact Figma values and their engine mappings in
  `docs/designs/document-platform/conformance/TOKENS_AND_CLEANUP.md`.
- Rejected near-duplicate local paint values as new shared semantics. They map to existing muted,
  divider, blue-panel, and danger roles; the frozen P7-1 contract was not expanded.
- Recorded contract-required normalization of Figma's alternate Arabic fonts and Arabic-Indic
  sample digits to the approved embedded Thmanyah family and Latin digits.

### 3. Typed, fail-closed evidence manifest

- Added all 16 catalog types and both locales in approved order.
- Recorded source node IDs, local evidence paths, archetypes, cleanup rules, ordered primitive maps,
  and explicit evidence states.
- Restricted mappings to the 13 template-callable P7-1 body primitives. Header, footer, watermark,
  page geometry, locale, and pagination remain owned by `DocumentPage`.
- A document passes only if both variants are verified, no printable region is uncovered, no engine
  conflict remains, and no new primitive is required. The phase passes only if every document
  passes.

### 4. Non-production reproduction harness

- Added synthetic English/LTR and Arabic/RTL structural render proofs for all 16 candidate maps.
- Rendered the proofs through the frozen `DocumentPage` contract with Latin-digit formatters and a
  generated/inlined QR boundary.
- Added a development-only conformance page at `/documents/engine-harness/conformance`.
- Applied P7-1 review recommendation N2: both the original engine harness and the P7-2 conformance
  harness return `notFound()` in production.

The harness is deliberately not a production document template. It demonstrates that every
approved composition is renderable through the frozen engine contract.

### 5. Cleanup decisions

- Remove outer design-canvas backgrounds, browser frames, capture shadows, demo navigation, action
  buttons, and floating controls from print/PDF output.
- Specifically remove the application chrome captured around Cancellation Report Arabic.
- Replace placeholder QR artwork with the generated verification QR.
- Convert sample branding, identifiers, dates, patient/staff data, signatures, stamps, and tax or
  payment values into dynamic or optional slots.
- Keep legitimate legal prose, totals, status, signature, and verification regions.
- Treat Follow-up Analytics progress/share display as table-cell content, not a new primitive.
- Remove Receptionist Performance print controls explicitly marked non-document content in Figma.
- Normalize both Prescription variants to A4 portrait while preserving hierarchy, spacing intent,
  content structure, and RTL/LTR balance. Do not add A5 support.

## Evidence and conformance result

| Evidence state | Variant count |
|---|---:|
| Verified through Figma MCP | 32 |
| Missing Figma node reference | 0 |
| Blocked by Figma MCP quota | 0 |
| **Total** | **32** |

All 16 documents have complete bilingual evidence and conform to the frozen primitive and page
contract after recorded cleanup. Prescription's body primitive map already conformed; the founder
decision approves normalizing its inconsistent Arabic and English frame sizes to the same A4
portrait geometry used by the platform.

**P7-2 gate result: PASSED (16/16 documents conformant; 32/32 variants verified).**

## Files changed for P7-2

### Added

- `components/documents/harness/p72-conformance-manifest.ts`
- `components/documents/harness/document-conformance-harness.tsx`
- `app/(protected)/documents/engine-harness/conformance/page.tsx`
- `tests/unit/components/p72-document-conformance.test.tsx`
- `docs/designs/document-platform/conformance/README.md`
- `docs/designs/document-platform/conformance/TOKENS_AND_CLEANUP.md`
- `docs/designs/document-platform/conformance/DOCUMENT_CONFORMANCE.md`
- `docs/reports/P7-2_IMPLEMENTATION.md`

### Updated

- `app/(protected)/documents/engine-harness/page.tsx`
- `docs/designs/document-platform/05-prescription/en/stitch-export/FIGMA_REFERENCE.md`
- `scripts/i18n-allowlist.json`

All other pre-existing modified and untracked files were preserved.

## Validation

| Check | Result |
|---|---|
| Targeted P7-2 conformance Vitest suite | PASS — 1 file, 4 tests |
| TypeScript `tsc --noEmit` | PASS |
| Focused ESLint | PASS |
| i18n hardcoded-string gate | PASS — 351 files, 35 documented exceptions |
| `git diff --check` | PASS |
| Next.js production build | PASS — Next.js 16.2.6, Turbopack |

The build emitted the repository's existing Next.js warning that the `middleware` file convention
is deprecated in favor of `proxy`; it is unrelated to P7-2.

## Cleanup decisions and deviations

1. **No remaining access blocker:** all 24 requested reruns succeeded; missing references and MCP
   quota counts are now zero.
2. **Corrected reference:** Prescription English `12:522` addressed only its watermark. Its parent
   chain identified the complete page `12:521`, which is now the recorded source.
3. **Prescription source inconsistency:** Arabic is an `A5 Prescription Canvas` measuring about
   `559.36 × 967.88 px`; English is an `A5 Sheet Simulation` measuring about
   `561.25 × 793.69 px`. The founder-approved cleanup normalizes both to A4 portrait while
   preserving hierarchy, spacing, RTL/LTR balance, and content structure.
4. **No contract expansion:** P7-2 did not add A5 page geometry or implement a production template.

## Phase boundary

- P7-2 is complete and `gatePassed` is true.
- No P7-3 templates, resolvers, or module behavior were implemented in this work.
