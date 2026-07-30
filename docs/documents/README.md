# P7A Document Requirements Catalog

**Status:** P7A requirements baseline
**Roadmap:** [`docs/AI_AGENT_PLAN.md`](../AI_AGENT_PLAN.md) §8, P7A
**Applies to:** the committed P7 system-template set only
**Does not implement:** visual design, branding schema, rendering, numbering storage, authoring UI, delivery integration, or legal-acceptance capture

## 1. Purpose

This catalog is the business-requirements source of truth for the premium document system. It fixes what every committed document must mean and contain before P7B designs it or P7C–P7E engineer it.

The catalog is deliberately bounded. It covers:

1. invoice;
2. receipt;
3. prescription;
4. medical report;
5. sick-leave certificate;
6. referral;
7. lab request; and
8. consent-form family.

A later document type must follow the [additive extension pattern](EXTENDING_THE_CATALOG.md). It must not enlarge an existing contract until it means something different or force a redesign of the shared engine.

## 2. Reading order

1. [Shared requirements](SHARED_REQUIREMENTS.md) — common data envelope, localization, privacy, lifecycle, numbering, QR, signatures, delivery, and degradation rules.
2. [Legal-validation gates](LEGAL_VALIDATION.md) — jurisdiction and counsel review required before a template can claim compliance.
3. The applicable document specification below.
4. [Extending the catalog](EXTENDING_THE_CATALOG.md) — definition contract and acceptance checklist for future types.

## 3. Committed document matrix

| Definition id | Specification | Default paper | Issuer / generation actor | Numbering class | P7 delivery requirement |
|---|---|---:|---|---|---|
| `invoice` | [Invoice](invoice.md) | A4 portrait | Existing billing-completion actors; manual send by current invoice-delivery actors | Fiscal, gap-free per clinic | Existing manual Email + WhatsApp workflow |
| `receipt` | [Receipt](receipt.md) | A5 portrait | Actor authorized for the successful payment mutation | Fiscal, gap-free per clinic | Preview, print, download; no new send workflow |
| `prescription` | [Prescription](prescription.md) | A5 portrait | Authorized doctor only | Clinical traceability | Preview, print, download |
| `medical_report` | [Medical report](medical-report.md) | A4 portrait | Authorized doctor only | Clinical traceability | Preview, print, download |
| `sick_leave` | [Sick leave](sick-leave.md) | A4 portrait | Authorized doctor only | Clinical traceability | Preview, print, download |
| `referral` | [Referral](referral.md) | A4 portrait | Authorized doctor only | Clinical traceability | Preview, print, download |
| `lab_request` | [Lab request](lab-request.md) | A4 portrait | Authorized doctor only | Clinical traceability | Preview, print, download |
| `consent_form` | [Consent-form family](consent-form.md) | A4 portrait | Authorized staff prepares; the form remains unsigned in ClinicFlow | Definition code + version; optional render reference | Preview, print, download |

## 4. Scope boundary and dependencies

P7A creates documentation only.

- **P7B** owns document-design tokens, grid, type scale, concrete layout primitives, pagination design, and approved per-document visual designs.
- **P7C** owns the missing clinic-branding fields, asset storage, settings UI, and RLS.
- **P7D** owns the registry, typed contracts, immutable snapshots, numbering allocation, rendering, QR primitive, and PDF/print parity.
- **P7E** owns authoring/generation surfaces, committed templates, any required document-domain persistence, and the invoice attachment integration with the unchanged P3 dispatcher.

P7A does not authorize P7B or later work. In particular, no schema, component, route, action, message, or renderer is introduced here.

## 5. Current-data honesty

The repository can currently supply:

- clinic name, phone, logo URL, address, country, timezone, currency, formatting locale, and digit preference;
- patient identity/contact fields, file number, date of birth, national ID, insurance provider, assigned doctor, and department;
- appointment, clinician, department, service-line snapshot, package, payment, insurance, deposit, and outstanding-balance data;
- free-text medical notes and their attachments; and
- payment records for deposits and later outstanding settlements.

The repository does **not** currently contain:

- immutable document instances or rendered snapshots;
- document serials or a gap-free allocation ledger;
- clinic website/email/social/tax-VAT/licence/custom-footer metadata;
- clinician professional licence numbers or signature assets;
- structured medications, allergies, diagnoses, referrals, lab orders, sick-leave certificates, or consent definitions/instances;
- a tax calculation/snapshot model;
- a secure public document-verification service; or
- electronic-signature or legal-acceptance capture.

Every specification labels those gaps. P7C–P7E must add explicit, authorized inputs or block issuance; they must never invent values from unrelated data.

## 6. P7A acceptance checklist

- [x] Every committed document has a purpose and non-purpose.
- [x] Every committed document has a generation point, actor, trigger, and preconditions.
- [x] Paper size, orientation, and output formats are fixed.
- [x] Dynamic and optional fields are enumerated, including their source status.
- [x] Sections, tables, signatures, QR behavior, numbering, localization, RTL/LTR, branding, delivery, and legal gates are specified.
- [x] Missing current data is explicit.
- [x] Optional-field degradation is deterministic.
- [x] Consent rendering is separated from acceptance/e-signature capture.
- [x] The extension pattern is additive and registry-oriented.
