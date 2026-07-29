# Medical Report Requirements

**Definition id:** `medical_report`
**Prefix:** `MR`
**Paper:** ISO A4, portrait
**Formats:** authenticated preview, print, PDF download
**Numbering:** clinical traceability sequence

This specification inherits [shared requirements](SHARED_REQUIREMENTS.md).

## 1. Purpose and non-purpose

A medical report is a formal doctor-authored narrative about an authorized patient and an explicitly selected episode or reporting period.

It is not:

- an automatic printout of all medical notes;
- an AI-generated or AI-summarized clinical conclusion;
- a complete longitudinal record export;
- a sick-leave certificate, prescription, referral, or lab request; or
- an MOH-issued report unless a real approved integration later exists.

## 2. Generation point, actor, trigger, and preconditions

- Generation point: patient clinical record, optionally launched from an authorized appointment or selected notes.
- Actor: authenticated doctor with current RLS access to the patient.
- Trigger: explicit doctor review and issue.
- Preconditions: patient authorization, report title/purpose, at least one substantive clinical section, doctor licence where required, selected output language reviewed, and approved legal profile.

Selected source notes/appointments may help the doctor author the report, but the report stores its own reviewed snapshot. No note is silently included.

## 3. Current source-of-truth assessment

The repository has patient identity, appointments, free-text `medical_notes`, note attachments, doctor/department data, and simple printable patient reports. It has no formal medical-report instance, structured diagnosis/findings/treatment fields, report recipient/purpose, clinician licence, or immutable clinical snapshot.

The current medical-notes report is a record view, not this formal document.

## 4. Complete field catalog

### Report context

| Field | Requirement | Source / rule |
|---|---|---|
| `medical_report_number` | Required | `MR-YYYY-000001`. |
| `report_title` | Required | Doctor-selected localized title. |
| `report_date` | Required | Issue date, clinic timezone. |
| `reporting_period_start`, `reporting_period_end` | Optional pair | Required together when the report covers a period. |
| `report_purpose` | Required | Explicit doctor input/approved purpose code plus display text. |
| `requested_by` | Optional | Patient/employer/insurer/facility name only when explicitly supplied and permitted. |
| `recipient` | Optional | Named recipient/organization; no delivery implied. |
| `confidentiality_notice` | Conditional | Approved legal-profile text. |

### Patient and encounter

| Field | Requirement | Source / rule |
|---|---|---|
| `patient_full_name` | Required | Patient snapshot. |
| `patient_file_number` | Required | Patient snapshot. |
| `patient_date_of_birth` | Required | Patient snapshot. |
| `patient_national_id` | Conditional | Purpose/legal profile only. |
| `encounter_references[]` | Optional | Explicitly selected authorized appointments, rendered with local dates. |
| `source_note_references[]` | Optional internal/audit | Explicitly selected notes; raw note UUIDs are not printed by default. |

### Clinical narrative

| Field | Requirement | Rule |
|---|---|---|
| `reason_for_report` | Required | Doctor-authored. |
| `relevant_history` | Optional | Doctor-authored; not automatic record dump. |
| `presenting_complaint` | Optional | Doctor-authored. |
| `examination_findings` | Optional | Doctor-authored. |
| `investigations` | Optional | Doctor-authored summary/reference. |
| `assessment_or_diagnoses` | Optional, sensitive | Explicit doctor input. |
| `clinical_course` | Optional | Doctor-authored. |
| `treatment_provided` | Optional | Doctor-authored. |
| `current_medications` | Optional | Explicit reviewed list; absence never means none. |
| `functional_status_or_limitations` | Optional | Doctor-authored. |
| `recommendations` | Optional | Doctor-authored. |
| `follow_up_plan` | Optional | Doctor-authored. |
| `summary_or_conclusion` | Required | Doctor-authored substantive conclusion. |
| `limitations_or_disclaimer` | Optional | Approved content only. |
| `referenced_attachments[]` | Optional | File label/type only; embedding original attachments is separate. |

At least the reason and conclusion plus one relevant clinical narrative section are required.

### Author

Doctor name, professional licence, specialty when required, department, clinic licence, issue attestation, and contact follow the shared issuer contract.

## 5. Section and table order

1. branding, document title/number/date;
2. patient and report-purpose block;
3. encounter/reporting-period block;
4. populated clinical narrative sections in the order above;
5. referenced attachments;
6. confidentiality/limitations notice;
7. doctor attestation and wet-sign/stamp line;
8. optional verification QR; and
9. footer/page numbering.

Empty optional clinical sections disappear; remaining headings keep their semantic order.

## 6. Numbering and lifecycle

- `MR-<clinic-local YYYY>-<six digits>`.
- Issue snapshots authored content and referenced-source identities.
- Updating an underlying note never changes the report.
- Correction creates a replacement; void preserves the original.
- A replacement states the prior report number and reason without exposing that reason in public verification.

## 7. Signature and QR

- Doctor typed attestation and wet-sign/stamp line required.
- No patient signature.
- Optional QR uses ClinicFlow verification only and exposes no clinical narrative or patient identity.

## 8. Localization, branding, and degradation

- System headings localize ar/en.
- Clinical prose is doctor-authored/reviewed in the selected output language and never automatically translated.
- Mixed-language clinical terms are direction-isolated.
- Empty optional narrative sections, recipient, reporting period, attachments, QR, and optional branding collapse.
- Missing title, purpose, conclusion, doctor licence where required, or legal approval blocks issue.

## 9. Delivery

Preview, print, and PDF download only. Secure external delivery, patient portal, recipient access, and medical-record exchange are future work.

## 10. Legal gates

Apply [shared legal validation](LEGAL_VALIDATION.md), particularly medical-report issuer qualifications, confidentiality, mandatory fields, patient-request/third-party disclosure, digital validity, retention, and the prohibition on implying MOH issuance.

## 11. Fixtures and acceptance

- encounter-specific and date-range report;
- minimal valid and all-sections report;
- long multi-page bilingual prose;
- source note changed after issue does not change report;
- absent optional sections collapse;
- missing conclusion/licence denial;
- doctor/RLS/cross-clinic denial;
- replacement/void history; and
- ar/en preview/print/PDF parity.

## 12. Explicitly out of scope

- AI drafting/summarization;
- automatic note concatenation;
- complete-record export;
- external health-information exchange;
- clinical coding/billing diagnosis;
- signed-report delivery portal; and
- P7B visual design or P7C–P7E implementation.
