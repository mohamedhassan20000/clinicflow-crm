# Receipt Requirements

**Definition id:** `receipt`
**Prefix:** `RCT`
**Paper:** ISO A5, portrait
**Formats:** authenticated preview, print, PDF download
**Numbering:** fiscal sequence

This specification inherits [shared requirements](SHARED_REQUIREMENTS.md).

## 1. Purpose and non-purpose

A receipt proves that the clinic recorded one successful payment event, identifies how much was received and by which method(s), and shows what the payment was allocated to.

It is not:

- an invoice or full statement of services;
- proof of a payment that merely remains due;
- proof that an insurer paid unless a real insurer-payment event was recorded;
- a receipt for applying an earlier patient deposit to an invoice; or
- a mutable summary of every payment on a patient account.

## 2. Generation point, actor, trigger, and preconditions

### Supported payment events

1. a new patient deposit inserted into `patient_deposits`;
2. a later outstanding settlement inserted into `outstanding_settlements`; and
3. new money collected during successful appointment billing completion.

### Actor and trigger

- The receipt is issued only after the authorized payment transaction commits.
- The issuer is the authenticated actor authorized by that existing mutation.
- Preview may be shown before confirmation, but it is marked `DRAFT` and has no permanent number.
- A retry of the same payment event returns the same receipt.

### Preconditions

- positive collected amount;
- one immutable payment-event identity;
- server-resolved clinic, patient, actor, timestamp, and canonical currency;
- valid payment method for each amount;
- allocations do not exceed the payment event; and
- jurisdictionally required receipt/clinic fields resolve.

## 3. Current source-of-truth assessment

| Payment path | Current source | Gap |
|---|---|---|
| Patient deposit | `patient_deposits` has id, amount, method, note, actor, timestamp | No receipt number/snapshot. |
| Outstanding settlement | `outstanding_settlements` has id, appointment/source references, amount, method, note, actor, timestamp | Split settlement may create multiple rows; P7E must bind them into one payment event. |
| Appointment-completion collection | Payment amounts/methods live on `appointments` | No immutable payment-event row; P7E must add an event/snapshot rather than infer on every render. |
| Deposit applied to invoice | `appointments.deposit_amount` | Not a new payment; no new receipt. The original deposit event owns the receipt. |
| Insurance allocation | `appointments.insurance_amount` | Allocation alone does not prove insurer remittance; excluded unless a real payment event exists. |

## 4. Complete field catalog

### Header and parties

| Field | Requirement | Source / rule |
|---|---|---|
| `receipt_number` | Required | `RCT-YYYY-000001` fiscal sequence. |
| `received_at` | Required | Committed payment-event timestamp, clinic timezone. |
| `patient_full_name` | Required | Patient snapshot. |
| `patient_file_number` | Required | Patient snapshot. |
| `patient_national_id` | Conditional | Only when approved legal profile requires it. |
| `received_by_name` | Required | Authenticated actor snapshot. |
| `received_by_role` | Required | Authenticated actor snapshot. |
| `payer_name` | Optional | Explicit input when payer differs; never assume patient. |
| `payer_relationship` | Conditional | Required when a payer name is supplied and profile requires it. |

### Payment and allocation

| Field | Requirement | Source / rule |
|---|---|---|
| `payment_event_id` | Required internal | Stable idempotency key; not raw browser input. |
| `payment_kind` | Required | `patient_deposit`, `appointment_collection`, or `outstanding_settlement`. |
| `payment_components[]` | Required, at least one | Each component has method, positive amount, and optional provider/reference. |
| `component_method` | Required | Current payment vocabulary. |
| `component_amount` | Required | Canonical currency. |
| `transaction_reference` | Optional | Explicit provider/cheque/bank/card-safe reference; never full card/account data. |
| `amount_received` | Required | Sum of components. |
| `amount_in_words` | Optional | Only from a tested deterministic locale/currency formatter. |
| `currency` | Required | Canonical clinic currency snapshot. |
| `allocation_lines[]` | Required | Identifies deposit balance or invoice/outstanding allocation. |
| `allocation_reference` | Required | Human receipt/invoice/appointment reference; raw UUID not printed by default. |
| `allocation_amount` | Required | Positive and reconciles to amount received. |
| `remaining_balance` | Optional | Snapshot after the payment; label makes clear whether patient deposit or invoice balance. |
| `payment_note` | Optional | Payment-event note, not clinical content. |

An amount received without an allocation line blocks issue.

## 5. Section and table order

1. compact branding/header;
2. receipt title, number, and received date/time;
3. received-from/patient identity;
4. prominent amount received and currency;
5. payment-method component table;
6. allocation table;
7. optional remaining-balance and note;
8. collector/issuer attestation;
9. optional verification QR; and
10. legal footer.

When content exceeds A5, the renderer may paginate on A5; it must not silently switch to A4.

## 6. Numbering and lifecycle

- Fiscal sequence: `RCT-<clinic-local YYYY>-<six digits>`.
- One committed payment event maps to at most one active receipt.
- Split methods are components of one receipt when they are committed as one user transaction.
- Void preserves the number and does not reverse the underlying payment. Reversal/refund requires a separately specified financial workflow/document.
- Reprint always uses the original snapshot.

## 7. Signature and QR

- Printed collector name/role and issue timestamp are required.
- Wet stamp/sign line is conditional on legal profile.
- Patient/payer signature is not required by the P7 baseline; if law requires acknowledgement, issuance must remain blocked until that workflow is separately approved.
- Optional ClinicFlow QR verifies status and receipt reference only; it contains no payer/patient or amount.

## 8. Localization, branding, and degradation

- Arabic/English system copy; no auto-translation of payment notes.
- Canonical clinic currency and correct minor units.
- Receipt number and transaction references remain LTR-isolated.
- A missing payer name falls back semantically to the patient, without rendering an empty “payer” row.
- Empty transaction reference, note, remaining balance, logo, and optional contact fields collapse.

## 9. Delivery

P7 commits preview, print, and PDF download only. It adds no automatic or manual messaging action for receipts. A future secure delivery feature consumes the issued receipt reference and receives its own privacy/idempotency review.

## 10. Legal gates

Apply [shared legal validation](LEGAL_VALIDATION.md), including:

- mandatory fiscal fields and receipt language;
- whether a signature/stamp is required;
- payment-provider reference masking;
- receipt retention and reversal rules; and
- whether insurer allocation may be described as “received.”

## 11. Fixtures and acceptance

- cash deposit, card/bank payment with safe reference, split payment, and later settlement;
- deposit application produces no second receipt;
- insurance allocation without payment event produces no receipt;
- allocation sums reconcile exactly;
- concurrent events allocate unique gap-free receipt numbers;
- retry returns the existing receipt;
- void preserves number and payment data;
- A5 long-content pagination; and
- English/Arabic, complete/minimum, print/PDF parity.

## 12. Explicitly out of scope

- refunds, reversals, chargebacks, credit notes;
- cash-drawer reconciliation;
- automatic insurer remittance recognition;
- receipt messaging;
- signature capture; and
- P7B visual design or P7C–P7E implementation.
