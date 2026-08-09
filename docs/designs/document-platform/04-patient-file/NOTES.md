# NOTES — Patient File

Working notes for the design intake of this document. Fill these in as you import
the manual references. Nothing here defines application behavior — it is a
capture sheet for the future design and discovery phases.

## Document identity

- **Stable code:** `PATIENT_FILE`
- **English name:** Patient File
- **Arabic name:** ملف المريض
- **Folder:** `04-patient-file/`
- **Catalog entry:** see [`../README.md`](../README.md)
- **Approved shared requirements:** see [`../shared/SHARED_REQUIREMENTS.md`](../shared/SHARED_REQUIREMENTS.md)

## Intended print location

- **Current intended product surface:** Individual patient profile

> Product surface is the *current intended* trigger point only. The exact
> issuance surface is confirmed later — see "Issuance trigger" below.

## Arabic reference checklist

- [ ] Arabic full-page screenshot placed at `ar/screenshot/reference.png`
- [ ] Arabic Stitch export copied into `ar/stitch-export/` with its structure intact
- [ ] Screenshot is a full page (no browser frame, no surrounding preview UI)
- [ ] RTL layout reads correctly end-to-start
- [ ] Embedded LTR runs (numbers, codes, URLs) are not reordered

## English reference checklist

- [ ] English full-page screenshot placed at `en/screenshot/reference.png`
- [ ] English Stitch export copied into `en/stitch-export/` with its structure intact
- [ ] Screenshot is a full page (no browser frame, no surrounding preview UI)
- [ ] LTR layout reads correctly start-to-end

## Stitch export checklist

- [ ] Complete export copied without flattening its internal folder structure
- [ ] No secrets, `.env` files, credentials, `node_modules`, or build output included
- [ ] No unrelated project files included
- [ ] Understood as a **reference** for dimensions, spacing, typography, and
      structure — not code to be copied into production

## Design cleanup notes

- Remove Stitch application backgrounds, surrounding preview UI, browser-like
  frames, demo navigation, floating controls, and anything outside the printable
  page. Record here anything unusual that will need cleanup during implementation.
- _(add notes)_

## Discovery placeholders

Do not invent values for these. They are confirmed in later discovery phases.

- **Required dynamic data:** To be discovered
- **Required permissions:** To be discovered
- **Issuance trigger:** To be confirmed
- **Number prefix:** To be confirmed
- **Paper size and orientation:** To be confirmed from design

## Open design questions

- _(list open questions raised while importing the references)_
