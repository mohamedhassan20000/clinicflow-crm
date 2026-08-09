# P7-2 Review — Design-to-Engine Conformance and Cleanup

**Reviewer:** Claude (independent review)
**Date:** 2026-08-01
**Branch:** `feat/p7-document-platform`
**Scope reviewed:** P7-2 conformance gate — manifest, conformance harness, harness routes,
focused tests, conformance docs (`README.md`, `DOCUMENT_CONFORMANCE.md`, `TOKENS_AND_CLEANUP.md`),
the corrected Prescription EN Figma reference, and the i18n allowlist update.
**Method:** Read all required analysis/conformance/implementation docs; read every P7-2-changed
file and the frozen P7-1 contract it depends on; independently re-queried Figma via MCP for a
representative sample plus every distinctive cleanup claim; ran the conformance test suite, `tsc`,
and the i18n gate independently.

Findings use stable IDs for the Claude→Codex handoff contract.

---

## Verdict summary

Every required verification item passed. Independent Figma inspection confirmed the most
consequential and most falsifiable claims exactly. No production code, template, resolver, or
P7-3+ scope leaked. The gate is genuinely fail-closed. Two non-blocking observations are recorded
below; neither affects the gate result.

---

## Required verifications

### 1. 32/32 variants have authoritative Figma evidence — ✅ PASS

- The manifest records both an Arabic and an English Figma node id for all 16 documents (32
  variants), each with `status: "verified_from_figma"`, and the test asserts every variant is
  verified with a non-null node id ([p72-conformance-manifest.ts:113-130](../../components/documents/harness/p72-conformance-manifest.ts#L113-L130),
  [p72-document-conformance.test.tsx:21-27](../../tests/unit/components/p72-document-conformance.test.tsx#L21-L27)).
- I independently re-queried four nodes via Figma MCP (`get_metadata`, file
  `nUzeFkN6Yn7m7knTzwmDHq`) covering the two hardest-to-fake claims and two explicit cleanup
  justifications:
  - **Prescription EN `12:521`** resolves to a frame named *"A5 Sheet Simulation"*,
    561.25 × 793.69 px, whose only sibling is `12:522` *"Watermark"*. This exactly confirms the
    report's claim that the old `12:522` reference was watermark-only and `12:521` is the true
    full page.
  - **Prescription AR `12:367`** resolves to *"A5 Prescription Canvas"*, 559.36 × 967.88 px —
    exactly the dimensions and name recorded in `TOKENS_AND_CLEANUP.md`, confirming the source
    geometry inconsistency.
  - **Cancellation AR `18:1168`** resolves to *"Main Printable Canvas (A4 Aspect)"*.
  - **Receptionist Performance EN `21:2934`** contains child `21:3075` literally named
    *"Print Action Floating Button (Not part of document)"* — authoritative confirmation of
    cleanup decision #7.
- The eight already-verified variants were not re-queried by the implementer (documented), and the
  reviewer's sample plus the four exact matches give high confidence the remaining node ids are
  genuine. Node-tree structure for Prescription matches its recorded primitive map
  (FieldGrid → SectionHeader → DataTable → NotesCallout → QR → SignatureBlock).

### 2. 16/16 documents conform to the frozen P7-1 engine contract — ✅ PASS

- The manifest's `P72_FROZEN_PRIMITIVES` list is exactly the 13 template-callable body primitives
  from the P7-1 contract (the 15 Layer-1 primitives minus the engine-owned `DocumentHeader` and
  `DocumentFooter`); the primitives barrel confirms 15 total exports
  ([primitives/index.ts](../../components/documents/primitives/index.ts)).
- The test proves every document's primitive map is a subset of the frozen set, non-empty, and
  excludes `DocumentHeader`/`DocumentFooter`
  ([p72-document-conformance.test.tsx:30-41](../../tests/unit/components/p72-document-conformance.test.tsx#L30-L41)).
- The conformance harness renders all 16 maps through the **frozen** `DocumentPage`, and the test
  asserts the engine-emitted `dir` (rtl/ltr), `data-digits="latn"`, `data-orientation="portrait"`,
  DOM primitive order equal to the manifest, no Arabic-Indic digits, and data-URI-only images
  ([document-conformance-harness.tsx](../../components/documents/harness/document-conformance-harness.tsx),
  [p72-document-conformance.test.tsx:65-86](../../tests/unit/components/p72-document-conformance.test.tsx#L65-L86)).
- `requiresNewPrimitive` is a literal `false` on every entry and `uncoveredRegions` is empty; the
  harness imports only from the frozen primitives barrel, so no new primitive can be smuggled in.

### 3. Prescription A4 cleanup is correctly documented and does not amend P7-1 — ✅ PASS

- The cleanup is recorded in three places (implementation report §5, `DOCUMENT_CONFORMANCE.md`
  row 05, `TOKENS_AND_CLEANUP.md` "Approved Prescription geometry cleanup") as a founder-approved
  design normalization of two inconsistent A5 source frames to the shared A4 portrait geometry,
  preserving hierarchy/spacing/content/RTL-LTR balance.
- It explicitly does **not** add A5 support or amend the P7-1 contract. Independently verified:
  the only `A5` token in the codebase is the descriptive cleanup string inside the manifest; there
  is no A5 geometry mode in the engine, and `P7-1_PRIMITIVE_CONTRACT.md` is unchanged (portrait
  default / landscape only for wide tables). The Prescription harness renders through the same A4
  `DocumentPage` as every other portrait document.

### 4. Token and primitive mappings are accurate — ✅ PASS

- The frozen hex tokens in `TOKENS_AND_CLEANUP.md` (`#001f35` ink, `#006575` accent, `#0095ab`
  bright accent, `#ebf6f8`/`#e5f6ff`/`#f3fbff` panels, `#d7e4e7` divider, `#3d494c` muted,
  `#00b26a`/`#f2a618`/`#ba1a1a` state colors, A4 210×297 mm, 15 mm inset, 7–24 px scale, 120 px
  watermark) match P7-1_PRIMITIVE_CONTRACT §3 exactly.
- Near-duplicate local shades (`#47617a`, `#bdc9cc`, `#cdedfb`, `#f22c2d`) and alternate Arabic
  fonts / Arabic-Indic sample digits are correctly rejected as new semantics and normalized to
  existing roles + the embedded Thmanyah family + Latin digits — consistent with the P7-1
  digits/font invariants. No frozen contract expansion.
- Primitive ownership is correctly split: `DocumentPage` owns header/footer/watermark/geometry/
  locale/pagination; bodies compose only the 13 frozen primitives.

### 5. No P7-3 or later scope leaked — ✅ PASS

- No production template or resolver files exist (`components/documents/` has only `engine`,
  `harness`, `primitives`; `lib/documents/` has only the pre-existing P7-0/P7-1 files). The
  `DOCUMENT_CATALOG` still registers only the P7-0 slice (`REVENUE_REPORT`, `INVOICE`).
- No dependency added; the reports and conformance docs repeatedly disclaim template/resolver/
  module/issuance work. Confirmed independently by directory listing and grep.

### 6. Production harness routes remain inaccessible in production — ✅ PASS

- Both `/documents/engine-harness` and `/documents/engine-harness/conformance` call
  `if (process.env.NODE_ENV === "production") notFound();` as the first statement, and both set
  `robots: { index: false, follow: false }`
  ([engine-harness/page.tsx:12](../../app/(protected)/documents/engine-harness/page.tsx#L12),
  [engine-harness/conformance/page.tsx:17](<../../app/(protected)/documents/engine-harness/conformance/page.tsx#L17>)).
  This applies P7-1 review recommendation N2 to the original harness as well.

### 7. Tests are meaningful and fail closed — ✅ PASS

- `isP72VariantVerified` requires `status === "verified_from_figma"`; `isP72DocumentConformant`
  requires all variants verified **and** zero uncovered regions **and** zero engine conflicts
  **and** no new primitive; `gatePassed` requires every document to pass. Flipping any variant to
  `blocked_*` or adding any uncovered region/conflict would drop the exact-match summary and fail
  the suite. This is genuine fail-closed logic, not a rubber stamp.
- The suite asserts exact catalog coverage and order against `DOCUMENT_TYPE_CODES`, the Figma file
  key, per-entry paired ar/en locales, ≥3 cleanup items, the full summary object by value, and
  live rendering in both directions. The corrected Prescription node `12:521` is pinned by a test.

---

## Independent validation run

| Check | Command | Result |
|---|---|---|
| P7-2 conformance suite | `vitest run tests/unit/components/p72-document-conformance.test.tsx` | ✅ 1 file, 4 tests pass |
| TypeScript | `tsc --noEmit` | ✅ exit 0 |
| i18n hardcoded-string gate | `npm run lint:i18n` | ✅ 351 files, 35 documented exceptions |
| Figma MCP re-inspection | `get_metadata` ×4 (12:521, 12:367, 18:1168, 21:2934) | ✅ all resolve; claims match exactly |

---

## Non-blocking observations

- **P7-2-N1 (informational):** I independently re-verified 4 of 32 variants — the two Prescription
  nodes (the corrected reference + the geometry-inconsistency claim) and the two nodes carrying
  explicit cleanup justifications. All matched the recorded evidence exactly. The remaining 28
  variants were not re-inspected by the reviewer; confidence is high but the gate ultimately rests
  on the implementer's recorded inspection for those. No action required.
- **P7-2-N2 (informational):** Receptionist Performance EN (`21:2934`) lists `NotesCallout` in its
  primitive map, but that region is not obvious in the EN node metadata (it appears to derive from
  the AR variant / subtitle context). Because `NotesCallout` is already in the frozen set and the
  map is a per-document union across both locales, this is a mapping-granularity note, not a
  contract or coverage failure. No action required.

---

## Verdict

APPROVED
