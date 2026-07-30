# Referral Requirements

**Definition id:** `referral`
**Prefix:** `REF`
**Paper:** ISO A4, portrait
**Formats:** authenticated preview, print, PDF download
**Numbering:** clinical traceability sequence

This specification inherits [shared requirements](SHARED_REQUIREMENTS.md).

## 1. Purpose and non-purpose

A referral is a doctor-authored request for another clinician, specialty, facility, or service to assess or manage an authorized patient, with only the clinical context required for that purpose.

It is not:

- confirmation that the destination accepted or booked the patient;
- a transfer-of-care event;
- a full-record export;
- a lab request; or
- an automatic recommendation based on department/service data.

## 2. Generation point, actor, trigger, and preconditions

- Generation point: authorized patient/encounter clinical surface.
- Actor: authenticated doctor with current RLS access.
- Trigger: explicit doctor review and issue.
- Preconditions: destination type/specialty or recipient, referral reason, requested action, sufficient relevant clinical context, issuer licence where required, and approved legal profile.

No referral is generated automatically from a note, diagnosis, report, or appointment status.

## 3. Current source-of-truth assessment

Clinic, patient, doctor, department, appointment, medical-note, and attachment data exists. Referral destinations, specialties, urgency, clinical summary, diagnoses, medication/allergy summaries, requested action, recipient contacts, referral state, and clinician licences do not exist as structured referral data.

P7E must add explicit doctor-authored fields and immutable referral persistence. It may reference explicitly selected source records but cannot dump them wholesale.

## 4. Complete field catalog

### Referral metadata and parties

| Field | Requirement | Source / rule |
|---|---|---|
| `referral_number` | Required | `REF-YYYY-000001`. |
| `referral_date` | Required | Issue date, clinic timezone. |
| `urgency` | Required | Approved vocabulary such as routine/urgent; emergency referrals must follow clinic policy, not document generation alone. |
| `patient_full_name` | Required | Patient snapshot. |
| `patient_file_number` | Required | Patient snapshot. |
| `patient_date_of_birth` | Required | Patient snapshot. |
| `patient_national_id` | Conditional | Recipient/legal requirement only. |
| `patient_phone` | Optional | Only when necessary for destination coordination. |
| `insurance_provider_name` | Optional | Explicitly relevant insurance snapshot. |

### Destination

| Field | Requirement | Rule |
|---|---|---|
| `destination_type` | Required | Clinician, specialty, facility, service, or other approved type. |
| `destination_name` | Conditional | Required when a named facility/clinician is known. |
| `destination_specialty` | Conditional | Required when referring by specialty. |
| `destination_department` | Optional | Explicit input. |
| `destination_address` | Optional | Explicit input. |
| `destination_phone` | Optional | Explicit input. |
| `destination_email` | Optional | Explicit input; no delivery implied. |
| `attention_to` | Optional | Recipient clinician/team name. |

At least one of destination name or specialty is required.

### Clinical referral content

| Field | Requirement | Rule |
|---|---|---|
| `referral_reason` | Required | Doctor-authored. |
| `requested_assessment_or_action` | Required | Doctor-authored. |
| `relevant_history` | Optional | Purpose-limited doctor-authored summary. |
| `clinical_findings` | Optional | Doctor-authored. |
| `working_diagnosis` | Optional, sensitive | Explicit doctor input. |
| `investigations_and_results` | Optional | Explicit reviewed summary; no automatic attachment extraction. |
| `treatment_to_date` | Optional | Doctor-authored. |
| `current_medications` | Optional | Explicit reviewed list; absence never means none. |
| `allergies` | Optional | Explicit reviewed status; never infer “none.” |
| `precautions_or_accessibility_needs` | Optional | Purpose-limited input. |
| `requested_timeframe` | Optional | Human-readable timeframe consistent with urgency. |
| `attachments_list[]` | Optional | Explicitly selected attachment labels/types; binary transfer is separate. |
| `referrer_contact_instruction` | Optional | Approved clinic contact/channel. |

### Referrer

Doctor name, professional licence, specialty if required, department, clinic licence, contact, and attestation follow the shared issuer contract.

## 5. Section and table order

1. branding/title/number/date/urgency;
2. destination and attention block;
3. patient identity;
4. reason and requested action;
5. populated clinical-context sections;
6. attachment list;
7. referrer contact and attestation;
8. optional verification QR; and
9. confidentiality/legal footer.

Urgency is conveyed by text and semantics, not color alone.

## 6. Numbering and lifecycle

- `REF-<clinic-local YYYY>-<six digits>`.
- Issue snapshots destination, clinical content, and referrer.
- Destination changes or clinical corrections create a replacement.
- Referral acceptance, scheduling, completion, and closed-loop response are not states in this definition.

## 7. Signature and QR

- Doctor attestation plus wet-sign/stamp line required.
- No patient or recipient signature.
- Optional QR verifies issuer/status only and exposes no referral reason or patient identity.

## 8. Localization, branding, and degradation

- System labels ar/en; clinical/destination free text is doctor-reviewed in selected language.
- Mixed facility names, emails, phone numbers, codes, and reference numbers are direction-isolated.
- Optional destination contacts, insurance, clinical sections, attachments, contact instruction, QR, and branding collapse.
- Missing destination name/specialty, reason, requested action, doctor licence, or legal profile blocks issue.

## 9. Delivery

Preview, print, and PDF download only. No Email/WhatsApp transmission, destination directory, fax, referral exchange, booking, or response tracking is introduced.

## 10. Legal gates

Apply [shared legal validation](LEGAL_VALIDATION.md) for disclosure basis, minimum necessary clinical content, patient authorization where required, issuer qualifications, referral validity, recipient transmission, and retention.

## 11. Fixtures and acceptance

- named clinician, specialty-only, and facility referrals;
- routine/urgent presentation without color-only meaning;
- minimum and all-sections clinical context;
- unknown allergy status never becomes “none”;
- long multi-page Arabic/English narrative;
- missing destination/reason/action/licence denial;
- doctor/RLS/cross-clinic denial;
- source note changes do not mutate referral; and
- preview/print/PDF parity.

## 12. Explicitly out of scope

- destination directory or interoperability;
- automatic booking/transfer/acceptance tracking;
- full-record or attachment delivery;
- AI referral recommendation/drafting;
- emergency-care workflow; and
- P7B visual design or P7C–P7E implementation.
