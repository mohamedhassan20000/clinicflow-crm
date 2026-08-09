# P7-2 Design-to-Engine Conformance Gate

**Status:** passed  
**Scope:** all 16 approved document designs in Arabic and English  
**Design authority:** Figma file `nUzeFkN6Yn7m7knTzwmDHq` through Figma MCP

P7-2 is a gate, not a production-template phase. Its repository artifacts are:

- the token and cleanup decision record in `TOKENS_AND_CLEANUP.md`;
- the 16-document, 32-variant evidence sheet in `DOCUMENT_CONFORMANCE.md`;
- the typed manifest in `components/documents/harness/p72-conformance-manifest.ts`;
- the development-only structural render harness at
  `/documents/engine-harness/conformance`;
- focused unit validation in
  `tests/unit/components/p72-document-conformance.test.tsx`.

## Gate rule

A document is conformant only when both its Arabic and English Figma nodes have been inspected,
every printable region maps to the frozen P7-1 engine contract, no region is uncovered, and no new
primitive is required. A screenshot is a visual cross-check and never promotes an evidence state.

The phase passes only when all 16 documents pass. The current evidence state is:

| State | Variants | Documents affected |
|---|---:|---:|
| Verified from Figma MCP | 32 | 16 inspected |
| Blocked by missing reference or MCP quota | 0 | 0 |
| Approved A4 geometry cleanup | 2 | 1 document |
| **P7-2 gate** | **32** | **PASSED** |

The targeted rerun inspected only the 24 variants that were previously blocked; the eight already
verified variants were not queried again. The founder decision resolves the final inconsistency by
normalizing both Prescription variants to the shared A4 portrait geometry while preserving their
visual hierarchy, spacing, content structure, and RTL/LTR balance. The frozen P7-1 contract remains
unchanged, and all 16 documents now conform.

## Boundaries

The harness contains synthetic fixture data only. It does not implement a document template,
resolver, issuance flow, storage path, production navigation entry, or new engine primitive. Both
the P7-1 and P7-2 harness routes return `notFound()` in production.
