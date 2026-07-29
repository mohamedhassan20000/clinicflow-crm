# Legal and Regulatory Validation Gates

**Important:** this catalog is a product and engineering requirements document, not legal advice. A template may be technically complete and still be legally invalid for a particular clinic, profession, document type, or country.

## 1. Release gate

Before a P7E document definition is enabled for issuance in a country, the product owner must obtain and record review by qualified local healthcare/legal/tax counsel covering:

1. mandatory document fields and language;
2. who may issue and reissue it;
3. whether a clinic, clinician, facility, regulator, or tax licence number is mandatory;
4. signature, stamp, QR, serial, and verification requirements;
5. permitted backdating, duration, cancellation, correction, and retention;
6. whether digital/PDF output is recognized;
7. whether Email, WhatsApp, download, or print delivery is permitted;
8. rules for minors, guardians, interpreters, and witnesses;
9. controlled-drug and prescription-dispensing restrictions;
10. tax calculation, tax invoice, receipt, and currency rules; and
11. patient-data minimization and cross-border transfer.

The approval artifact must identify the jurisdiction, source/version/date reviewed, approved definition version, reviewer, decision, and unresolved limitations. P7 must fail closed when a required country/document approval is absent.

## 2. Kuwait baseline evidence and boundaries

The following official sources establish validation needs; they do not by themselves provide a complete implementation opinion:

- Kuwait Ministry of Health lists electronic sick leave and medical reports as official e-services and publishes a patient guide describing downloadable PDF sick-leave reports and QR verification by official bodies:
  - <https://www.moh.gov.kw/en/pages/MOHApp.aspx>
  - <https://www.moh.gov.kw/UserGuides/Guideline.pdf>
- Kuwait Ministry of Health’s Drug Control department lists Ministerial Decree 256/2019 on information required in prescriptions, Decree 14/2020 on prescribing practices, and Decree 12/2022 on prescription dispensing:
  - <https://www.moh.gov.kw/en/Pages/DCC.aspx>
- Kuwait CITRA publishes Data Privacy Protection Regulation Decision 26/2024:
  - <https://www.citra.gov.kw/sites/en/LegalReferences/Data_Privacy_Protection_Regulation.pdf>

Consequences for the P7 requirements baseline:

- ClinicFlow must not represent a privately rendered sick-leave certificate or medical report as an MOH-issued document.
- A ClinicFlow QR must not copy MOH visual identity or imply access to MOH verification.
- The prescription definition cannot be enabled for Kuwait merely because the visible fields in this catalog are implemented; the decrees and current professional rules must be reviewed and mapped field by field.
- Patient documents and verification endpoints must apply minimization, restricted access, secure transmission, and documented retention.

## 3. Tax and fiscal documents

P7C’s tax/VAT identifier is branding metadata, not a tax engine. An invoice may render:

- line amounts and payment allocation already captured by the billing transaction; and
- a clinic tax-registration identifier only when configured and legally appropriate.

It may not invent a tax rate, taxable base, exemption reason, discount, rounding adjustment, or tax total. If the selected jurisdiction requires those values, compliant invoice issuance remains disabled until an immutable tax calculation/snapshot model exists and has been legally reviewed.

“Invoice” and “receipt” remain separate definitions:

- invoice = statement of charges and allocation/outstanding position at issue;
- receipt = evidence of one completed payment event.

## 4. Clinical documents

Prescription, medical report, sick leave, referral, and lab request require:

- a real authorized clinician;
- a professional-licence value from an approved source when required;
- clinician review of every clinical field;
- an immutable issued snapshot; and
- correction by replacement/void, never silent mutation.

The engine must not infer diagnoses, medications, allergies, work incapacity, tests, or clinical findings from appointment status, department, billing lines, or free-text notes.

## 5. Consent forms

P7 renders forms only. It does not prove that a patient:

- saw the form;
- understood it;
- signed it;
- accepted a particular version;
- had capacity;
- was represented by an authorized guardian; or
- later withdrew consent.

Those facts require a future acceptance/e-signature design aligned with `docs/AI_AGENT_PLAN.md` §3.7. A scanned signed form uploaded to `patient_documents` may be a file in the clinical record, but it is not structured acceptance history and must not be described as such.

## 6. Country expansion

A new country is an additive legal profile, not a forked renderer. Each profile maps:

- definition id and approved version;
- required/forbidden fields;
- numbering and QR rules;
- issuer qualifications;
- delivery and retention permissions; and
- approved localized legal text.

Absent a reviewed profile, the safe behavior is preview-only with a clear “not approved for issuance in this jurisdiction” state.

