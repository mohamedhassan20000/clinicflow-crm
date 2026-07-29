# Lab Request Requirements

**Definition id:** `lab_request`
**Prefix:** `LAB`
**Paper:** ISO A4, portrait
**Formats:** authenticated preview, print, PDF download
**Numbering:** clinical traceability sequence

This specification inherits [shared requirements](SHARED_REQUIREMENTS.md).

## 1. Purpose and non-purpose

A lab request is a doctor-authored order asking a laboratory to perform specific tests for an authorized patient, with collection and clinical context needed to process the request.

It is not:

- a lab result or interpretation;
- proof that a specimen was collected;
- a billing order;
- an automatic test suggestion; or
- an electronic lab integration message.

## 2. Generation point, actor, trigger, and preconditions

- Generation point: authorized patient/encounter clinical surface.
- Actor: authenticated doctor with current RLS access.
- Trigger: explicit doctor review and issue.
- Preconditions: at least one complete requested test, priority, patient identity, ordering clinician licence where required, reviewed clinical context/instructions, and approved legal profile.

No request is generated automatically from a note, diagnosis, report, service, or appointment status.

## 3. Current source-of-truth assessment

Patient, appointment, doctor, clinic, medical-note, and insurance data exists. There is no lab/test catalog, lab destination, specimen order, fasting/timing instruction, diagnosis/clinical indication, result destination, order status, or clinician licence.

P7E must add explicit doctor-authored order fields and durable lab-request persistence. This definition does not create result storage.

## 4. Complete field catalog

### Request and patient

| Field | Requirement | Source / rule |
|---|---|---|
| `lab_request_number` | Required | `LAB-YYYY-000001`. |
| `ordered_at` | Required | Issue timestamp, clinic timezone. |
| `priority` | Required | Approved vocabulary such as routine/urgent/stat; semantics are clinic/legal-profile defined. |
| `patient_full_name` | Required | Patient snapshot. |
| `patient_file_number` | Required | Patient snapshot. |
| `patient_date_of_birth` | Required | Patient snapshot. |
| `patient_national_id` | Conditional | Laboratory/legal requirement only. |
| `patient_sex` | Conditional | No current source; only when required for the requested test/reference handling. |
| `patient_phone` | Optional | Only when the lab requires contact and disclosure is approved. |
| `insurance_provider_name` | Optional | Explicitly relevant snapshot. |
| `encounter_date` | Optional | Selected appointment snapshot. |

### Laboratory destination

| Field | Requirement | Rule |
|---|---|---|
| `laboratory_name` | Optional | Explicit destination; omission means patient may present to a compatible lab. |
| `laboratory_branch` | Optional | Explicit input. |
| `laboratory_address` | Optional | Explicit input. |
| `laboratory_contact` | Optional | Explicit input. |
| `attention_to` | Optional | Lab/team name. |
| `result_return_instruction` | Required | Approved route/instruction; must not imply an integration that does not exist. |

### Test-order table

| Field | Requirement | Rule |
|---|---|---|
| `test_name` | Required | Doctor-authored or approved catalog label. |
| `test_code` | Optional | Approved lab/catalog code only. |
| `specimen_type` | Conditional | Required when the test or lab profile requires it. |
| `collection_container` | Optional | Explicit structured instruction. |
| `collection_timing` | Optional | Date/time/relative instruction. |
| `fasting_required` | Required explicit state | `yes`, `no`, or `not_applicable`; absence is invalid. |
| `fasting_duration_hours` | Conditional | Required when fasting is yes. |
| `special_handling` | Optional | Temperature/light/transport instruction. |
| `laterality_or_site` | Conditional | Required for tests where site matters. |
| `requested_due_date` | Optional | Clinic-local date/time. |
| `line_note` | Optional | Doctor-authored, test-specific. |

At least one complete test line is required.

### Clinical and ordering context

| Field | Requirement | Rule |
|---|---|---|
| `clinical_indication` | Required | Doctor-authored minimum necessary context. |
| `working_diagnosis` | Optional, sensitive | Explicit doctor input. |
| `relevant_medications` | Optional | Explicit reviewed list. |
| `relevant_precautions` | Optional | Explicit reviewed allergies/infection/other precautions. |
| `general_instructions` | Optional | Applies to the whole request. |
| `copy_results_to` | Optional | Explicit clinician/facility name; no automatic delivery. |

Doctor name, professional licence, specialty if required, department, contact, and attestation follow the shared issuer contract.

## 5. Section and table order

1. branding/title/number/date/priority;
2. patient and optional destination;
3. clinical indication;
4. requested-tests table;
5. general collection/result instructions and precautions;
6. ordering doctor attestation and wet-sign/stamp line;
7. optional verification QR; and
8. confidentiality/legal footer.

Test-table headers repeat on continuation pages. Priority is not represented by color alone.

## 6. Numbering and lifecycle

- `LAB-<clinic-local YYYY>-<six digits>`.
- Issue snapshots test lines/instructions.
- Corrections create a replacement.
- Collection, cancellation by lab, result, review, and completion states are outside this document instance.

## 7. Signature and QR

- Doctor attestation and wet-sign/stamp line required.
- No patient/lab signature.
- Optional QR verifies order status/issuer only; it contains no tests, indication, or patient data.

## 8. Localization, branding, and degradation

- System labels ar/en; test names/instructions are doctor-reviewed.
- Test codes, units, times, emails, and identifiers remain direction-isolated.
- Optional destination, contacts, code, specimen details, handling, diagnosis, medications, precautions, QR, and branding collapse.
- Missing test, explicit fasting state, clinical indication, doctor licence, or legal profile blocks issue.

## 9. Delivery

Preview, print, and PDF download only. No lab API, Email/WhatsApp transmission, result routing, barcode/specimen label, or patient portal is added.

## 10. Legal gates

Apply [shared legal validation](LEGAL_VALIDATION.md) for issuer qualifications, mandatory patient/test fields, specimen instructions, disclosure to external laboratories, result return, digital validity, and retention.

## 11. Fixtures and acceptance

- single/multiple tests, with and without lab destination;
- fasting yes/no/not-applicable and missing-state denial;
- specimen/handling/laterality conditional fields;
- routine/urgent/stat semantic rendering;
- multi-page test table;
- missing test/indication/licence denial;
- doctor/RLS/cross-clinic denial;
- QR/logs contain no tests or indication; and
- ar/en preview/print/PDF parity.

## 12. Explicitly out of scope

- lab/result integration, result storage/interpretation;
- specimen collection, labels, barcodes, chain of custody;
- AI test recommendation;
- patient delivery;
- billing/insurance authorization; and
- P7B visual design or P7C–P7E implementation.
