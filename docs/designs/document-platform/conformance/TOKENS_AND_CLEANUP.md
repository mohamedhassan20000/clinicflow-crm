# P7-2 Tokens, Primitive Mapping, and Cleanup Decisions

## Evidence method

Figma nodes were requested with `get_design_context` using the design-to-code workflow. The
targeted rerun queried only the 24 previously blocked variants: documents 03–05 and 08–16 in both
locales. All 24 checks returned authoritative context; documents 01, 02, 06, and 07 were not
queried again.

Prescription English initially referenced `12:522`, which is a valid watermark-only node. A
read-only parent trace located the complete `A5 Sheet Simulation` at `12:521`; that full node was
then inspected and the repository reference corrected. All 32 variants now have inspected full-page
sources.

Local `image.png` files were reviewed only as visual cross-checks for cleanup and structure. They
are not authoritative evidence and do not promote a variant's evidence status.

The newly retrieved contexts confirm the recorded primitive mappings for documents 03, 04, and
08–16. Prescription's body regions also map to the existing field-grid, section, table, callout,
verification, and signature primitives. Its inconsistent source geometry is covered by the
approved A4 normalization below.

## Shared token extraction and frozen mapping

The retrieved Figma contexts confirm the P7-1 token contract without requiring a new shared token.

| Figma value | Meaning | Frozen engine mapping |
|---|---|---|
| `#001f35` | primary ink / dark panel | `--doc-ink`, `--doc-panel-strong` |
| `#001b29` | soft ink | `--doc-ink-soft` |
| `#006575` | primary accent | `--doc-accent` |
| `#0095ab` | bright accent | `--doc-accent-bright` |
| `#ebf6f8` | accent panel | `--doc-panel` |
| `#f3fbff` | soft panel | `--doc-panel-soft` |
| `#e5f6ff` | blue panel | `--doc-panel-blue` |
| `#3d494c` | muted text | `--doc-muted` |
| `#d7e4e7` | divider | `--doc-divider` |
| `#00b26a` | success | `--doc-success` |
| `#f2a618` | warning | `--doc-warning` |
| `#ba1a1a` | danger | `--doc-danger` |
| `#ffffff` | paper | `--doc-paper` |
| `210 × 297 mm` | A4 portrait | `DocumentPage` portrait geometry |
| `56.693 px` | 15 mm page inset at 96 dpi | 15 mm logical page margins |
| `7, 8, 9, 10, 12, 14, 16, 24 px` | document type scale | existing primitive typography |
| `120 px` | watermark display size | `.cf-document-watermark` |
| `4, 8, 16, 24, 32 px` | recurring spacing rhythm | existing primitive gaps/padding |
| `2, 4, 8 px` | local corner radii | existing primitive radius choices |

English uses Manrope. Arabic uses the approved Thmanyah Sans family already embedded by the engine.
The design contract continues to require Latin digits and isolated LTR runs for identifiers,
phones, email, URLs, amounts, dates, and QR keys.

Several retrieved Arabic frames contain Noto Sans Arabic, Noto Kufi Arabic, or FreeSerif and some
sample values use Arabic-Indic digits. Engine reproduction intentionally normalizes those samples
to the approved embedded Thmanyah family and Latin digits. This is a contract-required cleanup,
not a new token or template exception.

### Non-contract shades observed

The retrieved frames also contain local shades such as `#47617a`, `#bdc9cc`, `#cdedfb`, and
`#f22c2d`. They do not express a new semantic role. For engine fidelity they are normalized to,
respectively, the frozen muted, divider, blue-panel, and danger roles. Promoting near-duplicate
paint values would expand the frozen contract without a reusable behavior and is therefore rejected.

## Primitive ownership

`DocumentPage` owns `DocumentHeader`, `DocumentFooter`, watermark, A4 geometry, locale direction,
fonts, pagination chrome, and print behavior. Document bodies may only compose the 13 frozen body
primitives enumerated by the P7-2 manifest. No P7-2 body mapping requires an additional primitive.
Prescription uses the existing A4 portrait geometry after approved design cleanup.

## Approved Prescription geometry cleanup

Prescription Arabic is named `A5 Prescription Canvas` in Figma and measures approximately
`559.36 × 967.88 px`. Prescription English is named `A5 Sheet Simulation` and measures
approximately `561.25 × 793.69 px`. The two imported locale frames therefore disagree with each
other and with the shared A4 geometry used by the rest of the platform.

Founder decision: Prescription must use the frozen engine's A4 portrait geometry. Both variants are
normalized to A4 while preserving their visual hierarchy, spacing rhythm, content structure,
medication table, notes, signature/verification zones, and balanced RTL/LTR composition. This is an
approved design cleanup; it does not add A5 support or amend the P7-1 contract.

## Approved cleanup for engine fidelity

The following changes remove design-capture artifacts without altering the printable design:

1. Remove the dark/noisy outer canvas, preview backdrop, browser frames, and page shadow from print
   and PDF. The engine may retain its own non-printing preview backdrop and shadow on screen.
2. For Cancellation Report Arabic, remove the ClinicFlow application header, Preview/Log/Templates
   navigation, Print/PDF actions, pale application canvas, and floating controls. Only the white
   document page is printable.
3. Replace every stylized or placeholder QR image with the generated, inlined verification QR.
4. Treat sample logos, clinic contacts, document numbers, dates, watermarks, patient/staff data,
   signatures, and stamps as dynamic or optional slots. Do not hardcode the captured samples.
5. Preserve legitimate document content, including legal/certifying prose, status indicators,
   totals, signatures, and verification regions. A visual placeholder is not permission to remove
   the corresponding data-backed region.
6. Render Follow-up Analytics share/progress visuals inside table cells. The content does not own
   pagination, chrome, or a reusable layout contract, so it does not justify a new primitive.
7. Remove Receptionist Performance print controls; the Figma nodes explicitly identify them as
   hidden-on-print/non-document actions.
8. Normalize both Prescription variants to shared A4 portrait geometry without changing their
   hierarchy, spacing intent, RTL/LTR balance, or content structure.

These decisions are cleanup only. They do not authorize production templates or P7-3 work.
