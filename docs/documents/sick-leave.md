# Sick-Leave Certificate Requirements

**Definition id:** `sick_leave`
**Prefix:** `SL`
**Paper:** ISO A4, portrait
**Formats:** authenticated preview, print, PDF download
**Numbering:** clinical traceability sequence

This specification inherits [shared requirements](SHARED_REQUIREMENTS.md).

## 1. Purpose and non-purpose

A sick-leave certificate is a doctor-issued statement that a patient is medically unfit for work/study for a specified period, subject to the clinic’s jurisdictional authority.

It is not:

- an MOH electronic sick leave;
- a guarantee that an employer, school, insurer, or authority will accept it;
- a general medical report;
- proof of diagnosis; or
- an automatically generated consequence of appointment completion.

## 2. Generation point, actor, trigger, and preconditions

- Generation point: authorized patient/encounter clinical surface.
- Actor: authenticated doctor with current RLS patient access.
- Trigger: explicit doctor review and issue.
- Default encounter precondition: a real clinic encounter is selected. Exceptions require an approved legal profile.
- Date-range, backdating, maximum-duration, future-start, extension, and overlap rules come from the approved jurisdiction profile and fail closed when unknown.

The app must show prominently whether the certificate is clinic-issued or backed by a specific regulator integration. P7 baseline is clinic-issued only.

## 3. Current source-of-truth assessment

Patient/doctor/appointment data exists. Work/study recipient, incapacity determination, leave dates, restrictions, return date, doctor licence, sick-leave instance/status, and regulator verification do not.

P7E needs explicit doctor input and persistence. Appointment status or medical-note existence never proves incapacity.

## 4. Complete field catalog

### Certificate and patient

| Field | Requirement | Source / rule |
|---|---|---|
| `sick_leave_number` | Required | `SL-YYYY-000001`. |
| `issued_at` | Required | Clinic-local issue timestamp. |
| `encounter_date` | Required | Selected authorized appointment/encounter. |
| `patient_full_name` | Required | Patient snapshot. |
| `patient_file_number` | Required | Patient snapshot. |
| `patient_date_of_birth` | Required | Patient snapshot. |
| `patient_national_id` | Conditional | Legal/recipient profile only. |
| `recipient_organization` | Optional | Employer/school/other explicitly supplied name. |
| `recipient_reference` | Optional | Employee/student/reference id, purpose-limited. |

### Leave determination

| Field | Requirement | Rule |
|---|---|---|
| `leave_start_date` | Required | Doctor-confirmed local date. |
| `leave_end_date` | Required | On/after start; jurisdiction duration rules apply. |
| `leave_duration_days` | Required derived | One shared inclusive/exclusive business rule approved by legal profile; displayed transparently. |
| `return_date` | Required derived/confirmed | Consistent with leave end and work-calendar rule. |
| `fitness_statement` | Required | Approved localized statement. |
| `work_or_study_restrictions` | Optional | Doctor-authored; omit when none/unknown. |
| `diagnosis_or_reason` | Off by default, conditional | Only when legally necessary and patient disclosure basis is approved. |
| `extension_of_number` | Optional | Prior certificate number when this is an extension. |
| `doctor_comment` | Optional | Purpose-limited, non-diagnostic unless approved. |

### Issuer

Doctor name, professional licence, specialty if required, clinic licence, issue attestation, and contact follow the shared issuer contract.

## 5. Section and table order

1. branding/title/number/status;
2. patient and optional recipient identity;
3. encounter date;
4. prominent leave period, duration, and return date;
5. fitness statement and optional restrictions;
6. privacy-safe note about diagnosis omission where appropriate;
7. doctor attestation and wet-sign/stamp line;
8. optional ClinicFlow verification QR; and
9. legal footer.

## 6. Numbering and lifecycle

- `SL-<clinic-local YYYY>-<six digits>`.
- Extensions receive a new number and reference the prior certificate.
- Corrections/revocations void or replace; they never edit issued dates silently.
- Public verification, if added, shows valid/void/replaced and issuer clinic/date only.

## 7. Signature and QR

- Doctor attestation and wet-sign/stamp line required.
- No patient/employer signature in P7.
- ClinicFlow QR must be visibly distinct from MOH QR/branding and must not claim MOH verification.
- Without a real verification service, the QR is omitted.

## 8. Localization, branding, and degradation

- System copy ar/en; doctor comments are reviewed in selected language.
- Dates are Gregorian and clinic-local.
- Diagnosis is absent by default; its absence removes the row completely.
- Optional recipient, restrictions, extension, comment, QR, and branding fields collapse.
- Missing doctor licence, encounter, date-rule approval, or jurisdiction approval blocks issue.

## 9. Delivery

Preview, print, and PDF download only. No employer submission, MOH submission, Email, or WhatsApp workflow is introduced by P7.

## 10. Legal gates

Kuwait’s MOH publishes official electronic sick-leave PDFs with official-body QR verification. P7 must follow [legal validation](LEGAL_VALIDATION.md) and must not mimic or claim that status. Counsel must approve private-clinic authority, required fields, date limits, diagnosis disclosure, signatures/stamps, and recipient validity before enablement.

## 11. Fixtures and acceptance

- one-day and multi-day leave;
- approved extension;
- recipient present/absent;
- diagnosis omitted by default;
- illegal/backdated/overlong/overlapping range denial per test profile;
- no MOH branding or implied MOH QR;
- doctor-only/RLS/cross-clinic denial;
- void/replacement verification; and
- ar/en preview/print/PDF parity.

## 12. Explicitly out of scope

- MOH/regulator integration;
- employer/school submission;
- acceptance guarantees;
- diagnosis inference;
- patient/employer signature capture; and
- P7B visual design or P7C–P7E implementation.
