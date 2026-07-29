# Invoice Requirements

**Definition id:** `invoice`
**Prefix:** `INV`
**Paper:** ISO A4, portrait
**Formats:** authenticated preview, print, PDF download; manual Email and WhatsApp delivery through the existing P3 workflow
**Numbering:** fiscal sequence

This specification inherits [shared requirements](SHARED_REQUIREMENTS.md).

## 1. Purpose and non-purpose

An invoice is the immutable statement of services charged for one completed appointment, the allocations recorded when billing completed, and the outstanding amount at issue.

It is not:

- proof that every amount was paid;
- a receipt for a later settlement;
- a mutable live account statement;
- a tax invoice unless the jurisdiction’s tax requirements and immutable tax inputs are satisfied; or
- an appointment reminder or dunning message.

## 2. Generation point, actor, trigger, and preconditions

### Generation point

- Draft preview: the appointment billing-completion surface, before confirmation.
- Issue: the successful `complete_appointment_billing` or `complete_appointment_billing_with_previous_settlement` transaction that changes the appointment to `completed` and persists `appointment_services`.
- Reprint/download: the completed invoice view on the appointment/patient financial history.
- Delivery: the existing manual “Send to patient” confirmation action.

### Actors

- Issue follows the current billing-completion authorization: admin, receptionist, manager, and assistant where the existing mutation permits them.
- Manual P3 delivery retains its current narrower authorization: admin, receptionist, and manager.
- Reprint/download must use current revenue/patient/appointment authorization and RLS; this catalog does not widen it.

### Preconditions

- appointment belongs to the authenticated clinic and is in a state the existing billing RPC may complete;
- active, authorized patient and appointment records exist;
- at least one valid service line exists;
- total is greater than zero;
- payment/deposit/insurance allocations do not exceed total;
- clinic canonical currency and timezone resolve;
- all jurisdictionally required fiscal/branding fields exist; and
- the issue transaction can atomically allocate the invoice number and persist the immutable snapshot.

Delivery remains a separate, explicit action after issuance. Issuance never auto-sends.

## 3. Current source-of-truth assessment

| Requirement area | Current source | Gap |
|---|---|---|
| Appointment/patient/doctor/department | `appointments` and related rows | Names/labels must be snapshotted at issue. |
| Service lines | `appointment_services` (`name`, `price`, `quantity`) | Sufficient for the current non-tax line model. |
| Totals/allocations | appointment `total_amount`, `paid_amount`, `insurance_amount`, `secondary_amount`, `deposit_amount`, `outstanding_amount` | Values are mutable through later workflows unless snapshotted. |
| Payment methods/note | appointment payment fields | The note is optional and must not be treated as structured tax/payment evidence. |
| Later settlements | `outstanding_settlements` | Must not mutate the issued invoice snapshot; receipts represent later payments. |
| Serial/snapshot/void state | None | P7D/E required. |
| Tax calculation | None | A configured tax id alone is insufficient; jurisdictional tax mode must fail closed. |

## 4. Complete field catalog

In addition to the shared envelope and branding placeholders:

### Document and parties

| Field | Requirement | Source / rule |
|---|---|---|
| `invoice_number` | Required | P7D fiscal sequence `INV-YYYY-000001`. |
| `issue_date_time` | Required | Billing completion/issue transaction timestamp in clinic timezone. |
| `supply_or_service_date` | Required | Appointment `scheduled_at`, clinic timezone. |
| `patient_full_name` | Required | Patient snapshot. |
| `patient_file_number` | Required | Patient snapshot; primary printed patient reference. |
| `patient_national_id` | Conditional | Off by default; only if a reviewed legal profile requires it. |
| `patient_address` | Conditional | Not available today; only if a reviewed fiscal profile requires it. |
| `insurance_provider_name` | Conditional | Required when `insurance_amount > 0` or invoice is insurance-billed. |
| `doctor_full_name` | Required | Appointment doctor name snapshot. |
| `department_name` | Optional | Appointment department name snapshot. |
| `appointment_reference` | Optional | Human-safe appointment reference; never expose raw UUID by default. |

### Line-item table

| Field | Requirement | Source / rule |
|---|---|---|
| `line_number` | Required | Render order, starting at 1. |
| `service_name` | Required | `appointment_services.name` snapshot. |
| `service_code` | Optional | Future explicit code only; never use UUID. |
| `description` | Optional | P7E invoice-specific input; must not contain clinical notes/diagnoses. |
| `quantity` | Required | Positive `appointment_services.quantity`. |
| `unit_price` | Required | Canonical clinic currency. |
| `line_subtotal` | Required | `quantity × unit_price`, deterministic currency rounding. |
| `discount_amount` / `discount_reason` | Unsupported in current P7 baseline | No current billing source; omit rather than display zero or infer. |
| `tax_rate`, `taxable_amount`, `tax_amount`, `tax_category` | Conditional external gate | Render only from an immutable approved tax snapshot. |
| `line_total` | Required | Current baseline equals line subtotal; tax profile may version this contract later. |

An empty line table blocks issue.

### Totals and allocation

| Field | Requirement | Source / rule |
|---|---|---|
| `subtotal` | Required | Sum of line subtotals. |
| `discount_total` | Unsupported in current baseline | No source; omit. |
| `tax_total` | Conditional external gate | Immutable tax snapshot only. |
| `invoice_total` | Required | Appointment total snapshot; must reconcile to line totals. |
| `deposit_applied` | Optional | Render when greater than zero. It is allocation of a prior deposit, not a new receipt. |
| `primary_paid_amount` | Optional | Render with method when greater than zero. |
| `primary_payment_method` | Conditional | Required when primary paid amount is greater than zero. |
| `secondary_paid_amount` | Optional | Render when greater than zero. |
| `secondary_payment_method` | Conditional | Required when secondary amount is greater than zero. |
| `insurance_amount` | Optional | Render when greater than zero. |
| `amount_allocated_at_issue` | Required | Sum of payment, insurance, secondary, and deposit allocations. |
| `outstanding_at_issue` | Required | Immutable issue-time outstanding amount. |
| `payment_status_at_issue` | Required | `paid` when outstanding is zero, otherwise `partially_paid` or `unpaid`. |
| `payment_note` | Optional | Trimmed issue-time note. |

Later settlement rows do not alter these fields. A separate account view may show current balance, but it is not part of this issued artifact.

## 5. Section and table order

1. branding/header;
2. document title, invoice number, issue date, and status;
3. bill-to patient identity and appointment/clinician context;
4. service-line table;
5. totals and payment-allocation block;
6. outstanding-at-issue notice when greater than zero;
7. optional payment note;
8. fiscal/legal identifiers and approved legal text;
9. optional verification QR; and
10. footer and page numbering.

Long line-item tables paginate. Totals stay together after the final table row and must not be stranded without their labels.

## 6. Numbering and lifecycle

- Fiscal sequence: `INV-<clinic-local YYYY>-<six digits>`.
- Number and immutable snapshot are committed in the same transaction as issue.
- Billing retries return the existing issued invoice for the same successful billing event; they do not allocate another number.
- An undo/replacement workflow must void or replace the invoice snapshot without deleting it or reusing its number.
- A corrected invoice receives a new number and references the replaced invoice.
- Credit notes/refund documents are not committed P7 types. Until separately specified, the product must not imply that voiding an invoice performs accounting reversal.

## 7. Signature and QR

- No patient signature.
- Fiscal issuer block shows the issuing staff name/role only when approved by the legal profile; the clinic is the document issuer.
- Wet signature/stamp line is conditional on legal profile.
- Optional ClinicFlow verification QR follows the shared opaque-token rule. No amount, patient identity, or appointment id appears in the QR payload.

## 8. Localization, branding, and degradation

- System labels render in Arabic or English; free-text line descriptions/payment notes are not auto-translated.
- Currency is the canonical clinic currency, never the viewing user’s approximate display currency.
- In Arabic, item descriptions follow RTL while quantities, amounts, invoice number, and tax identifiers remain isolated LTR runs.
- Missing optional logo/contact/social/custom-footer fields collapse under the shared rules.
- Missing legally required address, tax id, or licence blocks issue for that legal profile.
- Insurance and payment-method rows with zero values are omitted rather than rendered as zero-value noise.

## 9. Delivery

P7E replaces the P3 plain invoice summary with the issued PDF/reference behind the existing `compose summary → render message → send` seam:

- employee still clicks “Send to patient” and confirms;
- Email and WhatsApp remain independent;
- existing `invoice:<appointment_id>` per-channel idempotency remains authoritative;
- every attempt remains recorded in `outbound_messages`; and
- a delivery failure never changes invoice issue state.

The message body remains minimal. Attachment/link security, provider support, expiry, and identity behavior must be finalized before the PDF leaves ClinicFlow.

## 10. Legal gates

Apply [shared legal validation](LEGAL_VALIDATION.md), especially:

- fiscal fields and tax treatment;
- invoice versus receipt distinction;
- clinic issuer identity and licence/tax identifiers;
- correction/void/retention rules; and
- digital delivery validity.

## 11. Fixtures and acceptance

- current self-pay, split-payment, deposit-applied, insurance, partial, and fully unpaid invoices;
- long bilingual service names and multi-page line table;
- KWD minor-unit precision and another configured currency;
- later settlement does not mutate the issued invoice;
- missing tax snapshot cannot enter a tax-invoice mode;
- concurrent issue allocates unique, gap-free invoice numbers;
- billing retry does not allocate twice;
- void/replacement retains the original;
- manual Email/WhatsApp dispatch uses the issued instance and remains idempotent; and
- preview, print, and PDF contain identical issued content.

## 12. Explicitly out of scope

- tax engine, discounts, credit notes, refunds, account statements;
- automatic invoice delivery;
- patient portal;
- invoice editing after issue;
- AI-generated line descriptions; and
- P7B visual design or P7C–P7E implementation.
