# Consent-Form Family Requirements

**Definition id:** `consent_form`
**Definition-code prefix:** `CONS`
**Paper:** ISO A4, portrait
**Formats:** authenticated preview, print, PDF download
**Numbering:** immutable form code/version; optional opaque prefilled-render reference

This specification inherits [shared requirements](SHARED_REQUIREMENTS.md).

## 1. Purpose and non-purpose

The consent-form family renders an approved, versioned form that staff can review with a patient/guardian and sign outside ClinicFlow.

The committed family supports two content profiles under the same rendering/data contract:

- `general_treatment` — general consent to receive clinic evaluation/treatment; and
- `procedure_specific` — consent content tied to a named procedure/treatment.

It is not:

- electronic consent or legal acceptance capture;
- proof the patient saw, understood, or signed the form;
- a versioned legal-policy acceptance store;
- a signature-pad/e-signature workflow; or
- a replacement for counsel-approved wording.

Adding a materially different consent purpose is a new approved content profile or document definition under the [extension pattern](EXTENDING_THE_CATALOG.md), not arbitrary clinic-authored HTML.

## 2. Generation point, actor, trigger, and preconditions

- Generation point: authorized patient/appointment/procedure preparation surface.
- Actor preparing the form: authenticated staff with existing patient access and the role allowed by the approved content profile.
- Clinical content for `procedure_specific`: reviewed/confirmed by an authorized doctor; non-clinical staff cannot author risks/alternatives.
- Trigger: explicit preview/print/download. There is no in-system “accept” or “sign” trigger.

Preconditions:

- approved form code, version, jurisdiction, locale, and effective date;
- counsel-approved localized content snapshot;
- patient and any guardian context required for prefilling;
- named procedure/treatment for procedure-specific forms;
- clinician review when the form contains clinical/procedure content; and
- no expired/withdrawn definition.

## 3. Current source-of-truth assessment

Patient, appointment, doctor, department, and generic `patient_documents` upload exist. There is no consent-definition store, legal text versioning, patient capacity/guardian model, interpreter/witness records, signature capture, acceptance instance, withdrawal, or supersession history.

P7E may allow a signed scan to be uploaded manually as `patient_documents.category = other`, but that file is not structured acceptance evidence and must not be shown as such.

## 4. Complete field catalog

### Definition and render metadata

| Field | Requirement | Source / rule |
|---|---|---|
| `form_code` | Required | Stable code, e.g. `CONS-GEN` or `CONS-PROC`; ASCII-safe. |
| `form_version` | Required | Immutable approved content version. |
| `form_title` | Required | Approved localized title. |
| `content_profile` | Required | `general_treatment` or `procedure_specific`. |
| `jurisdiction` | Required | Approved country/legal profile. |
| `effective_from` | Required | Definition effective date. |
| `effective_to` | Optional | Definition expiry/withdrawal boundary. |
| `rendered_at` | Required | Clinic-local render timestamp. |
| `render_reference` | Optional | Opaque reference for patient-prefilled render; it is not acceptance evidence. |

### Patient, guardian, and communication

| Field | Requirement | Source / rule |
|---|---|---|
| `patient_full_name` | Required | Patient snapshot. |
| `patient_file_number` | Required | Patient snapshot. |
| `patient_date_of_birth` | Required | Patient snapshot. |
| `patient_national_id` | Conditional | Legal/content-profile requirement only. |
| `capacity_statement` | Conditional | Approved text/selection; current data gap. |
| `guardian_full_name` | Conditional | Required when guardian representation applies. |
| `guardian_relationship` | Conditional | Required with guardian. |
| `guardian_identifier` | Conditional, sensitive | Legal-profile requirement only. |
| `interpreter_required` | Optional explicit state | When true, interpreter fields become required. |
| `interpreter_full_name` | Conditional | Required when interpreter is used. |
| `interpreter_language` | Conditional | Required when interpreter is used. |
| `witness_required` | Definition-driven | When true, witness signature block renders. |
| `witness_full_name` | Optional prefill | May remain blank for wet completion. |

### Procedure/clinical context

| Field | Requirement | Rule |
|---|---|---|
| `procedure_or_treatment_name` | Required for procedure-specific | Doctor-reviewed. |
| `responsible_clinician` | Conditional | Required for procedure-specific where known. |
| `scheduled_date` | Optional | Appointment/procedure date; not proof it occurred. |
| `purpose_and_nature` | Required for procedure-specific | Approved/doctor-reviewed content. |
| `material_risks[]` | Required for procedure-specific | Approved/doctor-reviewed content; not AI-generated. |
| `expected_benefits[]` | Conditional | Approved content. |
| `reasonable_alternatives[]` | Required for procedure-specific unless legal review says otherwise | Includes consequence of no treatment where appropriate. |
| `special_clauses[]` | Optional | Approved definition blocks only, such as anesthesia or blood products; no free-form HTML. |

### Approved legal-content blocks

| Block | Requirement | Rule |
|---|---|---|
| `authorization_statement` | Required | Counsel-approved, versioned localized text. |
| `information_acknowledgement` | Required | Counsel-approved text. |
| `questions_opportunity_statement` | Required | Counsel-approved text. |
| `no_guarantee_statement` | Conditional | Definition/legal-profile driven. |
| `privacy_or_data_use_statement` | Conditional | Approved purpose-specific text; not platform policy acceptance. |
| `withdrawal_statement` | Conditional | Approved text explaining external/offline process in P7. |
| `custom_clinic_addendum` | Unsupported in baseline | Requires separate versioned/counsel-reviewed content design; never branding metadata. |

### Wet-signature blocks

| Field/line | Requirement | Rule |
|---|---|---|
| `patient_or_guardian_signature_line` | Required | Blank wet-sign line. |
| `patient_or_guardian_name_line` | Required | May prefill display name. |
| `patient_signature_date_time_line` | Required | Blank/manual completion. |
| `clinician_signature_line` | Profile-driven | Required for procedure-specific baseline. |
| `clinician_name_and_licence` | Conditional | Required when clinician signature block applies. |
| `witness_signature_line` | Conditional | Definition/legal-profile driven. |
| `interpreter_signature_line` | Conditional | Required when interpreter used. |

No filled signature image, signature timestamp, acceptance status, IP address, or user-agent evidence is created.

## 5. Section and table order

1. branding/form title/code/version;
2. patient/guardian/interpreter identity;
3. procedure/treatment context when applicable;
4. approved information, risks, benefits, alternatives, and special clauses;
5. authorization/acknowledgement/legal statements;
6. wet-signature blocks;
7. form version/effective date and optional render reference;
8. optional non-verification QR containing only a public form-definition reference, if approved; and
9. footer/page numbering.

Legal clauses remain together with their headings. Signature blocks must not split across pages.

## 6. Versioning and lifecycle

- Form content is immutable by `(form_code, form_version, locale, jurisdiction)`.
- Wording changes always create a new version.
- A withdrawn version remains renderable only for historical comparison by authorized staff, not for new patient use.
- A prefilled render reference identifies only what was rendered. It never transitions to “accepted.”
- Signed scans, if uploaded later, retain their own patient-document audit and are not retroactively linked as structured consent without a future reviewed design.

## 7. Signature and QR

- Wet-signature lines only.
- No electronic signature, checkbox acceptance, signature-pad capture, or countersignature action.
- A QR is not required. If present, it may resolve to public approved blank-form/version information only; it must not expose patient prefills or claim that consent was signed.

## 8. Localization, branding, and degradation

- Legal content must be separately counsel-approved in Arabic and English. It is never machine-translated at render time.
- Mixed names/identifiers are direction-isolated.
- Guardian, interpreter, witness, clinician, appointment, special-clause, optional QR, and optional branding blocks collapse only when the approved definition says they are not required.
- Missing required conditional data blocks rendering; it does not produce blank legal assertions.
- Clinic custom footer cannot override or contradict approved consent text.

## 9. Delivery

Preview, print, and PDF download only. No Email/WhatsApp send, patient portal, signature request, reminder, or signed-form return workflow is introduced.

## 10. Legal gates

Apply [shared legal validation](LEGAL_VALIDATION.md) to every content profile and locale. Counsel approval must cover capacity, guardian, interpreter, witness, risks/alternatives, withdrawal, retention, signature form, and whether electronic/PDF forms are suitable.

This family remains strictly separate from the future platform/clinic agreement-history work in `docs/AI_AGENT_PLAN.md` §3.7.

## 11. Fixtures and acceptance

- general-treatment and procedure-specific approved definitions;
- adult patient, guardian, interpreter, and witness variants;
- all required conditional blocks;
- missing guardian/interpreter/procedure/risk denial;
- Arabic/English counsel-approved content parity (not machine translation);
- version change preserves prior renders;
- no generated acceptance/signature evidence;
- QR contains no patient data and makes no signed-status claim;
- authorized patient/cross-clinic denial; and
- multi-page print/PDF parity with unsplit signature blocks.

## 12. Explicitly out of scope

- electronic signature or acceptance capture;
- consent status, withdrawal, re-consent, and agreement history;
- arbitrary clinic-authored legal text/HTML;
- patient portal or delivery;
- scanned-signature interpretation;
- legal-content authorship by ClinicFlow; and
- P7B visual design or P7C–P7E implementation.
