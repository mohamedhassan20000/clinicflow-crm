# Shared Document Requirements

These requirements apply to every P7 document unless a document specification explicitly narrows them.

## 1. Requirement vocabulary

| Marker | Meaning |
|---|---|
| **Required** | The document cannot be issued without the value. Preview may show an actionable missing-data state. |
| **Conditional** | Required only when its stated condition is true. |
| **Optional** | Render when present; omit the whole label/row/block when absent. |
| **Current** | A trustworthy source exists in the repository today. |
| **P7C** | The branding source is intentionally deferred to P7C. |
| **P7D/E** | The engine, instance, snapshot, or authoring source must be introduced by P7D or P7E. |
| **External gate** | Clinic configuration, regulator integration, or legal approval outside the current schema is required. |

“Required” describes an issued artifact, not permission to fabricate the value. A missing required P7C/P7D/E/external value blocks issuance.

## 2. Shared document envelope

Every issued instance has the following logical fields, even when a display field is not printed.

| Field | Requirement | Source | Rendering rule |
|---|---|---|---|
| `document_id` | Required | P7D/E | Immutable UUID; never reused. It may remain internal when a human number is printed. |
| `definition_id` | Required | P7D registry | Stable id from this catalog. |
| `definition_version` | Required | P7D registry | Immutable version used to render the instance. |
| `document_number` | Per document | P7D numbering ledger | Printed when the document specification defines a numbering class. |
| `status` | Required | P7D/E | `draft`, `issued`, `void`, or `replaced`; drafts are never delivery-ready. |
| `issued_at` | Required when issued | P7D/E | Stored as UTC; rendered in clinic timezone. |
| `issued_by` | Required when issued | Authenticated profile | Server-derived user id plus immutable display-name/role snapshot. |
| `clinic_id` | Required | Server authorization | Never accepted from an untrusted client as authority. |
| `patient_id` | Required for patient documents | Authorized source record | Internal relation; printed identifiers are document-specific. |
| `appointment_id` | Conditional | Authorized source record | Internal relation when the document is encounter- or invoice-linked. |
| `locale` | Required | Explicit output choice, defaulting to clinic formatting locale | Exactly `ar` or `en` in P7. |
| `direction` | Derived | Locale | `rtl` for Arabic, `ltr` for English; never user-supplied separately. |
| `timezone` | Required snapshot | Clinic settings | IANA timezone captured at issue time. |
| `currency` | Conditional | Clinic settings / financial snapshot | Canonical clinic currency only on fiscal artifacts. |
| `digits` | Required snapshot | Clinic settings | Applies to dates and amounts; identifiers remain ASCII-safe. |
| `source_snapshot` | Required when issued | P7D/E | Immutable, minimal data used for the issued rendering. |
| `render_checksum` | Required when issued | P7D | Hash of canonical rendered bytes or canonical render payload. |
| `voided_at`, `voided_by`, `void_reason` | Conditional | P7D/E | Required together for `void`; the original instance remains retained. |
| `replaced_by_document_id` | Conditional | P7D/E | Required for `replaced`; replacement gets its own number. |

## 3. Shared branding contract

Branding is data, not layout. P7B decides its visual presentation; P7C supplies the missing values.

| Placeholder | Requirement | Current source / owner | Degradation |
|---|---|---|---|
| `clinic_name` | Required | `clinics.name` — Current | Blocks issuance if absent. |
| `clinic_logo` | Optional | `clinics.logo_url` now; P7C asset storage later | Use a typographic clinic-name mark; never a broken-image box. |
| `clinic_address` | Optional, jurisdictionally conditional | `clinics.address` — Current | Omit the address row unless law makes it required. |
| `clinic_phone_primary` | Optional, jurisdictionally conditional | `clinics.phone` — Current | Omit the phone row unless law makes it required. |
| `clinic_phone_secondary` | Optional | P7C | Omit. |
| `clinic_email` | Optional, jurisdictionally conditional | P7C | Omit. |
| `clinic_website` | Optional | P7C | Omit. |
| `clinic_social_links[]` | Optional | P7C | Omit the whole social block. |
| `clinic_tax_registration` | Conditional | P7C | Never infer from clinic metadata; block a tax-document mode when required and absent. |
| `clinic_licence_numbers[]` | Conditional on clinical/legal use | P7C | Block issuance where the selected jurisdiction requires one. |
| `clinic_custom_footer` | Optional | P7C | Use only the system footer and page numbering. |
| `clinic_branding_metadata` | Optional | P7C | Only registry-approved keys may render; arbitrary HTML/CSS/scripts are forbidden. |

The clinic name and legal identifiers are text, not images, so they remain searchable and accessible.

## 4. Shared patient and issuer fields

### Patient

| Field | Default | Current source | Rule |
|---|---|---|---|
| `patient_full_name` | Required | `patients.full_name` | Snapshot at issuance. |
| `patient_file_number` | Conditional | `patients.file_number` | Default patient identifier on clinical documents. |
| `patient_date_of_birth` | Document-specific | `patients.date_of_birth` | Render only where needed. |
| `patient_national_id` | Document-specific, sensitive | `patients.national_id` | Off by default; require an explicit documented purpose. |
| `patient_phone` | Optional | `patients.phone` | Do not print on clinical documents unless required. |
| `patient_email` | Optional | `patients.email` | Do not print on clinical documents unless required. |
| `insurance_provider_name` | Conditional | patient/appointment insurance relation | Snapshot name, never a live mutable label. |

### Issuer / clinician

| Field | Requirement | Source | Rule |
|---|---|---|---|
| `issuer_full_name` | Required | `profiles.full_name` | Server-resolved and snapshotted. |
| `issuer_role` | Required | `profiles.role` | Server-resolved and snapshotted. |
| `issuer_department` | Conditional | `profiles.department_id` → department name | Required when the clinical definition needs it. |
| `clinician_professional_licence` | Required for regulated clinical artifacts unless counsel says otherwise | P7E gap | It is not the clinic licence and must never be copied from P7C clinic metadata. |
| `clinician_specialty` | Conditional | P7E gap | The current department name is not automatically a professional specialty. |
| `signature_mode` | Per document | P7D/E | Typed attestation and/or wet-sign line only in P7. |

## 5. Lifecycle and immutability

1. **Preview** resolves authorized source data and shows a visible `DRAFT` marker. It allocates no permanent number and cannot be sent as an issued document.
2. **Issue** re-runs authorization and validation server-side, allocates any required number atomically, captures the source snapshot and branding/configuration versions, renders, hashes, and persists the immutable instance.
3. **Download / print / allowed delivery** always use the persisted issued snapshot. They do not rebuild from mutable patient, clinic, appointment, or payment rows.
4. **Correction** creates a replacement document. It never edits issued content in place.
5. **Void** preserves the original number and snapshot with actor, timestamp, and reason. Numbers are never recycled.
6. Deleting or replacing an appointment must not delete its fiscal or clinical document history. Document persistence must use durable references rather than cascade from mutable workflow rows.

Draft persistence and authoring recovery are P7E decisions. Issued immutability is not optional.

## 6. Numbering classes

### Fiscal sequence

Invoice and receipt use an independent, per-clinic, per-definition, per-calendar-year sequence:

`<PREFIX>-<YYYY>-<000001>`

- `YYYY` is resolved in the clinic timezone at issuance.
- Allocation and instance creation occur in one database transaction.
- Concurrency may not duplicate or skip an allocation.
- A committed number is retained when voided/replaced, so the ledger remains gap-free.
- Failed transactions consume no number.
- Invoice and receipt sequences never share a counter.

### Clinical traceability sequence

Prescription, medical report, sick leave, referral, and lab request use the same human-readable structure with their own prefixes. Their ledger must be unique and atomic. Whether a jurisdiction requires statutory gap-free numbering is an [external legal gate](LEGAL_VALIDATION.md); ClinicFlow still retains voided numbers for auditability.

### Consent definitions

Consent forms are identified primarily by an immutable `form_code` and `form_version`. A patient-prefilled render may receive an opaque render reference, but P7 does not create an acceptance/consent-instance ledger merely because a blank form was printed.

Prefixes are fixed by each document specification. A later need to customize display prefixes is a separate requirements change; database uniqueness must never depend on user-editable text alone.

## 7. Localization and bidirectional text

- System labels, date labels, and explanatory boilerplate render in the selected output locale (`ar` or `en`).
- Free-text clinical or legal content is **never machine-translated implicitly**. The author must supply/review content in the output language.
- Arabic output uses semantic RTL ordering. Tables mirror column order where P7B approves it; numbers, serials, medicine codes, URLs, email addresses, and QR payload labels remain isolated LTR runs.
- Human-readable serials always use ASCII digits, even when clinic display digits are Arabic-Indic.
- Dates and times use the clinic timezone snapshot. Gregorian dates are required; no Hijri-only artifact is permitted in P7.
- Fiscal amounts use the canonical clinic currency and its correct minor-unit precision. A user’s approximate display-currency preference must never alter an issued fiscal document.
- Font fallback must preserve Arabic shaping. P7B must not assume that the licensed dashboard font may legally be embedded into generated PDFs; font-embedding rights are an explicit design/implementation gate.

## 8. Optional-field degradation

- An absent optional field removes its label, separator, and reserved whitespace.
- An absent optional block causes adjacent blocks to reflow within P7B primitives.
- A missing logo falls back to the clinic name.
- An empty table renders a document-specific empty state in preview and normally blocks issuance when the table is core to the document.
- A missing required legal field blocks issue with a field-specific, localized error.
- A missing optional QR or signature image does not leave an empty framed box; the allowed typed/wet-sign alternative renders instead.
- Multi-page documents repeat the approved identification header and page number and never orphan a table header or signature block. P7B owns the exact pagination design.

## 9. Signatures and attestations

P7 supports:

- printed issuer name, role, department/specialty, and licence number;
- an explicit issuer-attestation timestamp captured when the authorized issuer confirms issue; and
- a visible wet-signature/stamp line where required.

P7 does **not** support:

- cryptographic/electronic signatures;
- signature-pad capture;
- patient acceptance capture;
- countersignature workflows; or
- inferred signatures from an uploaded image.

Adding stored signature/stamp assets requires a separately reviewed authorization, storage, revocation, and misuse-prevention design. It is not assumed by this catalog.

## 10. QR and verification

The shared QR primitive is optional per document and may render only when a real verification contract exists.

- Payload is an HTTPS URL containing an opaque, revocable verification token.
- The QR contains no patient name, national ID, diagnosis, medicine, amount, or other PHI/PII.
- The verification response exposes the minimum authenticity state: valid/void/replaced, document type, issuer clinic, issue date, and masked/document-safe reference.
- Access is rate-limited, audited, and supports token revocation.
- A QR generated by ClinicFlow must be labelled as ClinicFlow/clinic verification. It must never imitate a Ministry or regulator QR.
- When no verification endpoint exists, omit the QR block entirely.

The verification service is not implemented by P7A and must be explicitly scoped in P7D/E before any QR appears.

## 11. Output and parity contract

Every committed document supports:

- authenticated preview;
- print stylesheet/output; and
- PDF download.

For the same issued instance, preview, print, and PDF must use the same persisted snapshot and definition version. Content, pagination decisions, document number, and QR payload must match. Printer hardware margins may differ, but the application must not maintain a separate “PDF template” and “print template.”

## 12. Delivery and privacy

- Only the invoice is integrated with P3 delivery in P7E, and that send remains manual, independently idempotent per Email/WhatsApp channel, and recorded in `outbound_messages`.
- Other P7 documents are preview/print/download only unless their own specification says otherwise. “Delivery-ready” means a stable issued PDF exists; it does not silently authorize a new messaging workflow.
- Clinical documents must not be put in message bodies. A future secure attachment/link workflow needs identity, expiry, access audit, revocation, and jurisdiction review.
- Logs, Sentry, analytics, QR payloads, filenames, and object paths must not contain patient names, national IDs, diagnoses, medications, or free-text content.
- Authorization is rechecked for every preview, issue, print, download, void, replacement, and delivery action. A document route never trusts clinic, patient, appointment, or issuer ids supplied by the browser.

## 13. Retention and audit

Each issued instance records create/issue/print/download/deliver/void/replace events with actor, clinic, document id, action, and timestamp, without copying document content into generic audit rows.

Retention periods and patient deletion handling require jurisdictional policy. Until approved, issued records are preserved and access-restricted rather than silently cascaded or hard-deleted.

