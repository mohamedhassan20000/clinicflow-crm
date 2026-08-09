# P7-7 Invoice + Delivery — Implementation Report

**Status:** COMPLETE

**Branch:** `feat/p7-document-platform`

**Scope:** Invoice document slice and its reuse of the existing manual invoice-delivery flow only.

**Date:** 2026-08-02

## Outcome

P7-7 completes the 16th and final document type — the **tax Invoice** (archetype E, financial) —
and wires its canonical serialized PDF into the **already-built** manual invoice delivery seam. No
parallel delivery system was created: Email and WhatsApp remain independent channels, each idempotent
on the existing `message_dispatches` ledger, and every attempt is still recorded on
`outbound_messages`.

No P7-8+ feature was implemented. No commit, push, branch switch, PR, or remote Supabase schema
operation was performed. All existing P7 working-tree changes were preserved.

## Implemented functionality

### Catalog and source boundary

- The `INVOICE` catalog entry (financial archetype, `INV` prefix, operational roles, appointment
  subject, `InvoiceTemplate`) was already registered by earlier P7 work and is left unchanged.
- Added a strict `{ appointmentId }` resolver whose only source of truth is the completed
  appointment's billing record and its persisted `appointment_services` line items, plus the
  tenant/patient/doctor/department records read through RLS. No amounts, line items, or payment facts
  are ever accepted from a browser payload.

### Immutable invoice snapshot

- Added a versioned (`version: 1`) snapshot freezing clinic branding/tax fields, format, document
  settings, patient identity (name, file number, department), responsible doctor, invoice status
  (paid / partially paid / unpaid), service line items, totals (subtotal, insurance coverage, amount
  due, total paid, outstanding), a de-duplicated per-method payment breakdown, and billing notes.
- Money is normalized to two decimals; the invoice status and outstanding balance are derived from
  the stored billing fields rather than fabricated.

### AR/EN template and renderer

- Added the bilingual `InvoiceDocument` template using only the frozen P7-1 primitives in the
  P7-2-approved conformance order: **IdentityHero → StatusBadge → TotalsSummary → DataTable →
  NotesCallout → FieldGrid → VerificationBlock → SignatureBlock** (status badge carried inside the
  IdentityHero; dual authorized/patient signatures).
- Added AR/EN copy (`documentPlatform.invoice`) and a server-only renderer producing the canonical
  PDF through the shared `renderDocumentPdf` path. The P7-6 shared header, footer, tenant-logo sizing,
  spacing, and QR behavior are untouched.
- Tax handling is data-driven: when the clinic has a `tax_id`, the invoice surfaces the tax
  registration number (making it a tax invoice); no VAT rate is invented where none is configured.

### Preview, issuance, snapshot, PDF, QR, history, reprint

- Added `/appointments/invoice/document` for AR/EN draft preview and issued-document display, mirroring
  the revenue document surface (locale switch, print draft, issue, reprint, history timeline).
- Issuance routes through the shared idempotent `issueDocumentFoundation`. The idempotency key is
  `invoice:<appointmentId>` (no random component), so an appointment maps to exactly **one** canonical
  invoice document, whether issued from the UI or lazily during delivery.
- Preview renders a labelled draft; issued output uses the existing opaque verification token and the
  canonical `https://clinicflow.fit/verify/{token}` QR behavior.
- Added issued-document history and canonical reprint (returns the stored PDF, increments
  `print_count`, appends a `reprinted` event) without mutating the issue snapshot.
- Added the `INVOICE` label to the public verification page and `documentPlatform.verification.invoice`
  copy.

### Delivery — reuse of the existing seam

- Extended the existing `lib/messaging/invoice-delivery.ts` seam (compose summary → render message →
  send) rather than creating a new one:
  - It now issues the canonical invoice document (idempotent per appointment) and **attaches the
    stored PDF to the email channel**, referencing the canonical invoice number in the message body.
  - A document-issuance or PDF-read failure **degrades gracefully** to the existing text-only summary
    rather than blocking delivery.
- Email and WhatsApp stay independent and idempotent through the unchanged
  `dispatchPatientMessage` → `message_dispatches` claim/finalize/release ledger, keyed on
  `invoice:<appointmentId>`. A succeeded channel is never re-sent; only a failed channel retries.
- Added optional binary attachment support to the shared send path
  (`MessageAttachment` on `OutboundMessageInput`/`ProviderMessage`, threaded through `sendMessage`,
  `dispatchPatientMessage`, and the Resend adapter). Attachments apply to email only; the WhatsApp
  adapters ignore them.
- The manual "Send to patient" action (`sendInvoiceToPatient`) now passes the acting user as the
  document issuer; its per-channel result reporting is unchanged.

### Delivery status / history / retry / audit

- Delivery status, history, retry, and audit reuse the existing infrastructure — `message_dispatches`
  (per-channel idempotency + retry) and `outbound_messages` (per-send status/provider/timestamps,
  repaired by the existing provider webhooks: sent/delivered/read/failed). No parallel audit was
  introduced.

## Migration

Added local migration `supabase/migrations/20260802140000_p77_invoice_document.sql`:

- Adds `record_invoice_document_reprint(uuid)`, restricted to `doc_type = 'INVOICE'`, the clinic
  scope, and the operational roles (admin/manager/receptionist). It is canonical and append-only
  (increments `print_count`, inserts a `reprinted` event; never touches storage or deletes rows).
- Does **not** redefine the shared `verify_document_token` public verification boundary (P7-3).

The migration was applied to the **local** Supabase instance for validation. It was **not** applied to
the remote Supabase project. The reprint RPC was hand-added to `types/database.ts` (consistent with the
existing per-archetype reprint typings).

## Files changed for P7-7

### New

- `lib/documents/resolvers/invoice.ts`
- `lib/documents/invoice-copy.ts`
- `lib/documents/renderers/invoice.tsx`
- `lib/documents/invoice-issuance.ts`
- `components/documents/templates/invoice.tsx`
- `components/documents/invoice-document-actions.tsx`
- `app/(protected)/appointments/invoice/document/page.tsx`
- `supabase/migrations/20260802140000_p77_invoice_document.sql`
- `tests/unit/lib/p77-invoice-document-contract.test.ts`
- `tests/unit/components/p77-invoice-document.test.tsx`
- `tests/unit/db/p77-invoice-document-migration.test.ts`
- `tests/unit/integration/p77-invoice-pdf-render.test.tsx`
- `docs/reports/P7-7_IMPLEMENTATION.md`

### Modified

- `actions/documents.ts` (invoice preview / issue / get / reprint actions)
- `actions/appointments.ts` (`sendInvoiceToPatient` passes the issuing actor)
- `lib/messaging/invoice-delivery.ts` (issue + PDF-attach adapter on the existing seam)
- `lib/messaging/automated-send.ts` (email attachment pass-through)
- `lib/messaging/send.ts` (email attachment pass-through)
- `lib/messaging/email-resend.ts` (Resend attachment mapping)
- `lib/messaging/types.ts` (`MessageAttachment`)
- `lib/supabase/admin.ts` (`downloadClinicDocumentPdf`)
- `app/(public)/verify/[token]/page.tsx` (INVOICE verification label)
- `messages/en.json`, `messages/ar.json` (invoice namespace, UI, verification, delivered event)
- `types/database.ts` (`record_invoice_document_reprint` typing)
- `tests/unit/lib/p3d-invoice-delivery.test.ts` (updated for the new signature + attachment coverage)

## Design verification

The invoice conformance mapping (Figma nodes AR `24:3936`, EN `24:4133`) was implemented against the
approved P7-2 primitive sequence for ordinal 16. Sample branding, patient data, services, amounts,
signatures, stamps, and QR artwork in the design are treated as dynamic slots, not production data.

## Validation results

- `pnpm typecheck`: passed.
- `pnpm lint`: passed; 0 errors, 24 pre-existing warnings (all outside P7-7).
- `pnpm lint:i18n`: passed; 386 files scanned, 41 documented exceptions.
- `pnpm lint:rtl`: passed; 566 files scanned, 10 documented exceptions.
- `pnpm i18n:missing`: passed; 3,642 base messages with valid locale parity.
- `pnpm test`: passed; 289 files, 2,110 tests.
- Focused P7-7 contract/template/migration/delivery tests: passed; 18 tests.
- P7-7 invoice PDF Chromium render: passed; 1 test (valid Arabic A4 `%PDF-`).
- P7-2 conformance gate + P7-0 catalog: passed (INVOICE included, 16/16 conformant).
- `pnpm build`: passed; 76 routes generated, including `/appointments/invoice/document`.
- Local migration application: passed; `record_invoice_document_reprint` registered on the local DB.

## Blockers and deviations

- Blockers: none.
- Deviations from approved scope: none. Tax handling surfaces the clinic's tax registration number
  when configured and does not compute a VAT rate the data model does not carry.
- WhatsApp carries the invoice via the existing approved template plus the canonical invoice number;
  the professional serialized PDF is attached on the email channel (WhatsApp template media hosting is
  out of P7-7 scope). Document Factory, Settings, Hardening, Patient File redesign, and later
  history/financial documents remain deferred to their assigned phases.
