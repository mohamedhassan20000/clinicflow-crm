# Shared Requirements — ClinicFlow Document Platform

These are the **approved shared requirements** that every built-in document in the
future ClinicFlow Document Platform must eventually satisfy. This file records the
agreed direction for the design-intake and later discovery phases.

**This is a requirements record only.** Nothing here is implemented in this
directory. Words like "must eventually", "future", and "discovery phase" are
deliberate: they mark work that happens after the design intake, not now. Where a
requirement says a decision is still open, it is not resolved here.

Related: the per-document capture sheets (`NOTES.md`), the
[import guide](../DESIGN_IMPORT_GUIDE.md), the [catalog](../README.md), and the
existing P7 requirement specs in [`docs/documents/`](../../../documents/).

## 1. Separate Arabic and English designs

Every built-in document has a **separate Arabic RTL design** and a **separate
English LTR design**. They are imported and treated as distinct references, not
one design flipped automatically.

## 2. Remove non-printable Stitch chrome

During implementation, the following must be **removed**: Stitch application
backgrounds, surrounding preview UI, browser-like frames, demo navigation,
floating controls, and any element outside the printable page. Only the printable
document itself survives into the design.

## 3. Consistent shared header and footer

Every issued document must eventually support a **consistent shared document
header and footer** — applied without destroying each document's individual
design.

## 4. Shared document identity

The shared document identity must support:

- clinic logo;
- clinic name;
- clinic address;
- clinic phone number;
- document title;
- unique server-issued document number;
- issue date;
- optional issue time;
- page numbers for multi-page documents where appropriate.

## 5. Machine-readable verification mark

Every issued document must eventually carry a **machine-readable verification
mark**. The implementation discovery must **evaluate QR versus linear barcode**
before choosing. Any verification mark visible in a Stitch export is a
**placeholder** and is **not production data**.

## 6. Verification mark opens a public verification page

Scanning the verification mark must open a **public document verification page**.

## 7. Public verification page — strict disclosure limits

The public verification page **may show only**:

- status: valid, void, cancelled, or unavailable;
- document number;
- document type;
- issue date;
- issuing clinic name.

It **must not** expose patient medical data, prescriptions, diagnoses, notes,
contact details, financial breakdowns, or any other sensitive information.

## 8. Server-side, atomic, per-clinic, per-type numbering

Document numbers must eventually be generated **server-side, atomically, and
independently per clinic and per document type**.

## 9. Preview does not consume a number

**Previewing must not consume a final number.** A preview is not an issued
document.

## 10. Reprints retain the original identity

**Reprinting must retain the original number and verification mark.** A reprint is
the same issued document, not a new one.

## 11. Issued numbers are never reused

Issued numbers **must not be reused**, including after voiding or cancellation. A
voided or cancelled number is retired, not recycled.

## 12. Admin-configurable watermark text

The clinic **primary Admin** must eventually be able to configure the document
**watermark text** from Settings.

## 13. Watermark behavior

- The Admin can provide **custom text**.
- If the custom text is empty, it **defaults to the clinic name**.
- It appears **behind** the page content.
- It **must not obstruct** content, signatures, tables, or verification marks.
- It **must render correctly in both Arabic and English**.
- Whether an **enable/disable** control is required is **not decided here** — the
  future discovery phase must determine this and **ask the founder before
  deciding**.

## 14. Clinical documents require future authoring forms

**Prescription, lab request, and sick-leave certificate** require **future
authoring forms** inside a redesigned patient visit workflow. Those forms are not
designed or built here.

> **Now scoped (2026-08-02).** This dependency is designed in
> [`analysis/16-clinical-authoring-and-patient-file-redesign.md`](../analysis/16-clinical-authoring-and-patient-file-redesign.md)
> and owned by **P7-6A — Clinical Authoring Foundations** (durable, auditable records + clinician
> credentials + optional clinic drug/lab catalogs). Authoring is open to any authorized staff role, each
> record stores a mandatory `responsible_doctor_id`, and the forms are the **single shared owner** launched
> by both the Patient File (P7-11) and the central Document Factory (P7-8). P7-6 renders only from those
> persisted records.

## 15. Future patient-file redesign

The future **patient-file redesign** must bring appointment details, medical
notes, prescription authoring, lab requests, and sick-leave actions into a
clearer experience — while keeping them as **separate persisted and auditable
records**.

> **Now scoped (2026-08-02).** Designed in
> [`analysis/16-clinical-authoring-and-patient-file-redesign.md`](../analysis/16-clinical-authoring-and-patient-file-redesign.md)
> §8 and owned by **P7-11 — Patient File redesign**: a unified appointment-history section (details+status,
> follow-up, invoice/billing, the appointment's medical note, related clinical documents; latest 5 + full
> history page), Packages and Deposits sections + pages, the integrated Documents section, and contextual
> New Prescription / Lab Request / Sick Leave actions. Printable history/financial documents are P7-12.

## 16. Invoice post-completion delivery prompt

**Invoice completion** must later support a **post-completion prompt** asking
whether to send the issued invoice by **WhatsApp, email, both, or not now**. The
future planning phase must **inspect existing messaging behavior** and **ask the
founder questions** before defining any automatic-send settings.
