# Design Import Guide

This guide tells you **exactly where to place each manual file** for the ClinicFlow
Document Platform design intake. Follow it per document. Nothing here builds or
designs anything — it only organizes the references you import by hand.

See the [catalog and folder list in `README.md`](README.md), and the approved
cross-document rules in [`shared/SHARED_REQUIREMENTS.md`](shared/SHARED_REQUIREMENTS.md).

## The two kinds of reference

For every document you import two kinds of reference, in **both Arabic and English**:

1. **Full-page screenshots** — the **visual source of truth**. This is what the
   final printed document should look like.
2. **Stitch exports** — a **structural reference** used to inspect exact
   dimensions, spacing, typography, and layout structure. The Stitch export is
   *never* the source of truth for how it should look, and is *never* copied
   blindly into production code (see below).

## Where each file goes

Inside each document folder (for example `01-revenue-report/`):

| What you are importing | Put it here | Preferred name |
|---|---|---|
| Arabic full-page screenshot | `ar/screenshot/` | `reference.png` |
| English full-page screenshot | `en/screenshot/` | `reference.png` |
| Arabic Stitch export | `ar/stitch-export/` | keep the export's own files/names |
| English Stitch export | `en/stitch-export/` | keep the export's own files/names |
| Assets used only by this document | `assets/` | descriptive names |
| Assets shared across multiple documents | [`shared/assets/`](shared/assets/) | descriptive names |

So, concretely, for the Revenue Report:

```
01-revenue-report/
├── ar/screenshot/reference.png        ← Arabic full-page screenshot
├── ar/stitch-export/<export files>    ← Arabic Stitch export (structure intact)
├── en/screenshot/reference.png        ← English full-page screenshot
├── en/stitch-export/<export files>    ← English Stitch export (structure intact)
└── assets/                            ← images/fonts used only by this document
```

### Screenshots

- Use the preferred names `ar/screenshot/reference.png` and
  `en/screenshot/reference.png` wherever possible.
- Capture the **full page**. Do not crop out parts of the document.
- If you have more than one representative screenshot (for example a short page
  and a long multi-page version), keep `reference.png` as the primary and add
  clearly named extras alongside it (for example `reference-long.png`).

### Stitch exports

- A complete Stitch export may contain **multiple files and nested folders**.
  Copy the **entire export** into the relevant `stitch-export/` directory
  **without flattening its internal structure** — keep its folders and file
  names exactly as exported.
- Keep the Arabic export under `ar/stitch-export/` and the English export under
  `en/stitch-export/`.

## Source-of-truth rule

- The **screenshots are the visual source of truth** — they define how the
  finished document should look.
- The **Stitch export is a reference** used to inspect dimensions, spacing,
  typography, and structure.
- **Stitch exports must not later be copied blindly into production code.** They
  are read for measurements and structure; the production implementation is
  built on ClinicFlow's own shared document primitives, not by pasting exported
  markup.

## What must never be imported

Imported files must **not** include any of the following:

- secrets or API keys;
- environment files (`.env`, `.env.local`, etc.);
- credentials of any kind;
- `node_modules/`;
- build output (`dist/`, `.next/`, compiled bundles, etc.);
- any unrelated project files.

If a Stitch export bundle contains any of the above, remove them before copying
the export into its `stitch-export/` directory.

## Per-document checklist

For each document, before considering its intake complete:

- [ ] `ar/screenshot/reference.png` placed
- [ ] `en/screenshot/reference.png` placed
- [ ] `ar/stitch-export/` populated with the Arabic export (structure intact)
- [ ] `en/stitch-export/` populated with the English export (structure intact)
- [ ] Document-specific assets placed in `assets/` (and shared ones in
      [`shared/assets/`](shared/assets/))
- [ ] No secrets, env files, credentials, `node_modules`, build output, or
      unrelated files included
- [ ] The document's `NOTES.md` updated
