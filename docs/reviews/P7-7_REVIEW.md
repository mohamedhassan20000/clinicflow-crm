# P7-7 Review — Invoice + Delivery (tax invoice, archetype E)

**Reviewer:** Claude (independent review)
**Date:** 2026-08-02
**Branch:** `feat/p7-document-platform`
**Scope reviewed:** P7-7 — the 16th and final document type, the tax **Invoice** (financial archetype);
the `{appointmentId}` resolver reading only the completed appointment's persisted billing record +
`appointment_services`; the immutable versioned snapshot; the AR/EN template + renderer on the frozen
P7-1 primitives; server-resolved preview, canonical issuance, PDF, QR, public verification label,
issued-document history, and canonical reprint; the reprint RPC migration
`20260802140000_p77_invoice_document.sql`; and the reuse of the existing manual invoice-delivery seam
(`lib/messaging/invoice-delivery.ts` + `message_dispatches` + `outbound_messages`) with an email-only
PDF attachment.

**Method:** Read the authoritative plan (`AI_AGENT_PLAN.md`), the roadmap (doc 13, P7-7), the shared
requirements (§3–§16), the P7-7 implementation report, and the APPROVED P7-6 review. Read every P7-7
file: `lib/documents/resolvers/invoice.ts`, `lib/documents/invoice-issuance.ts`,
`lib/documents/renderers/invoice.tsx`, `lib/documents/invoice-copy.ts`,
`components/documents/templates/invoice.tsx`, `components/documents/invoice-document-actions.tsx`,
`app/(protected)/appointments/invoice/document/page.tsx`, the invoice slice of `actions/documents.ts`,
the `sendInvoiceToPatient` change in `actions/appointments.ts`, the migration, and all P7-7 tests.
Re-read the frozen engine (`lib/documents/issuance.ts`), the reused delivery ledger
(`lib/messaging/automated-send.ts`, `send.ts`, `email-resend.ts`, `types.ts`), the admin service
boundary (`lib/supabase/admin.ts`), the existing completed-appointment billing representation
(`actions/appointments.ts` billing block), and the catalog. Inspected the approved Invoice Figma
variants (AR `24:3936`, EN `24:4133`) via Figma MCP. Independently ran `tsc`, five focused unit
suites, the conformance gate, the headless-Chromium invoice PDF render, and an AR/EN i18n parity check.

Findings use stable IDs for the Claude→Codex handoff contract.

---

## Verdict summary

P7-7 completes the catalog with a pure slice (catalog entry + resolver + template + renderer + copy +
actions + reprint RPC + verify label) and a **faithful reuse** of the already-built manual delivery
seam. It adds no engine-core change and introduces no parallel delivery system.

The source boundary holds: `resolveInvoiceDocumentSnapshot` reads only the tenant-scoped completed
`appointments` row, its persisted `appointment_services` line items, and clinic/patient/doctor/
department/settings rows through the RLS user client; it accepts **no** amounts, line items, or payment
facts from any browser payload (the issued `params` is `{version, appointmentId}` only). Every money
figure is derived from persisted billing columns — subtotal from line items (fallback `total_amount`),
insurance from `insurance_amount`, amount-due from `patient_responsibility`, paid total from the
de-duplicated payment breakdown, and outstanding from the persisted `outstanding_amount` — matching the
completion flow's `collected = paid + insurance + secondary + deposit` model with no double-counting and
no invented totals. Tax handling is data-driven: the title stays a generic "Invoice"/"الفاتورة", the tax
registration number is surfaced **only** when the clinic has a `tax_id`, and **no VAT rate is computed**
where the data model carries none.

Canonicalization is correct: the idempotency key is `invoice:<appointmentId>` with no random or locale
component, so an appointment maps to exactly **one** immutable invoice document — issued identically from
the UI or lazily during delivery, with a reused number/snapshot/PDF on retry. Preview consumes no number
and renders no verification block; issuance/PDF/QR/verification/history/reprint all route through the
frozen `issueDocumentFoundation` guard and the shared renderer. The reprint RPC is INVOICE-only,
clinic-scoped, restricted to admin/manager/receptionist (matching the catalog `pageRoles`), append-only,
and leaves the snapshot/PDF immutable; it does not redefine the shared verification boundary.

Delivery reuses the seam intact: email and WhatsApp remain independent channels, each claim/finalize/
release-idempotent on `message_dispatches` keyed `invoice:<appointmentId>`, each recorded on
`outbound_messages`. The email-only PDF attachment is base64-serialized, threaded through the existing
`sendMessage` path (WhatsApp adapters ignore it), and is **not** persisted into `outbound_messages`
(only the redacted body preview is). A document-issuance or PDF-read failure degrades to the existing
text-only summary without blocking or duplicating the send; on channel failure the claim is released so
only the failed channel retries, re-preparing the (idempotent) attachment.

Visual output matches the approved AR/EN Figma frames — shared header, tenant logo, footer, spacing, and
the generated QR (replacing the Stitch placeholder square) are preserved through the frozen
`DocumentPage`. No P7-8+ scope leaked (no `/documents/new`, no module list, no history/financial types,
no regenerate path). Tests are meaningful and fail closed.

Five non-blocking observations (O1–O5) remain; none is a correctness, security, data-honesty, or
fidelity blocker.

**Verdict: APPROVED.**

---

## Required verifications

### 1. Resolver uses only persisted completed-appointment billing data — ✅ PASS

`resolveInvoiceDocumentSnapshot` ([resolver L164-325](../../lib/documents/resolvers/invoice.ts#L164-L325))
queries `appointments` filtered `.eq("clinic_id", clinicId).eq("id", appointmentId).is("deleted_at", null)`
via the RLS `createClient()`, rejects any row whose `status !== "completed"`, and reads line items from
`appointment_services` (clinic-scoped) plus clinic branding/settings. No amounts or line items are ever
accepted from a caller — the params schema is `{ appointmentId: uuid }` only
([L19-21](../../lib/documents/resolvers/invoice.ts#L19-L21)). The contract test asserts the schema
rejects a non-UUID and that the snapshot is `version === 1`.

### 2. Money is derived, not invented — ✅ PASS

Subtotal = persisted line-item sum (fallback `total_amount`); insuranceCoverage = `insurance_amount`;
amountDue = `patient_responsibility` (fallback `total − insurance`); paidTotal = sum of the de-duplicated
payment breakdown; outstanding = persisted `outstanding_amount` (fallback `amountDue − paidTotal`)
([L253-270](../../lib/documents/resolvers/invoice.ts#L253-L270)). `buildPaymentBreakdown` folds
`paid_amount + secondary_amount + deposit_amount` per method and **excludes** insurance — consistent with
the completion flow's `collected = paid + insurance + secondary + deposit`
([actions/appointments.ts L861-865](../../actions/appointments.ts#L861-L865)), so there is no
double-counting and insurance is shown as coverage, not a patient payment. Status is derived from the
persisted outstanding/paid figures. See **O5** on deposit method attribution.

### 3. One canonical invoice per appointment — ✅ PASS

`issueInvoiceDocument` keys `issueDocumentFoundation` with `idempotencyKey: invoice:${appointmentId}`
and no random/locale component ([issuance L39](../../lib/documents/invoice-issuance.ts#L39)). The DB
reservation owns dedupe + numbering; a second call returns `reused: true` with the same document. The
contract test locks the key literal and asserts the file contains no `allocate_document_number`. See
**O1** — the locale of the single canonical invoice is fixed at first issuance (correct for a legal
financial artifact).

### 4. Preview / issuance / snapshot / PDF / QR / verification / history / reprint follow the engine — ✅ PASS

- **Preview** re-resolves live and renders `lifecycle="preview"` (DRAFT, no number, no verification
  block) — asserted by the component test.
- **Issuance** routes through the frozen `issueDocumentFoundation` guard (render → store → complete with
  rollback), passing `renderIssuedInvoicePdf` as the render seam.
- **Snapshot** is a `z.literal(1)` immutable freeze of branding/format/settings/patient/appointment/
  status/lineItems/totals/payments/notes; issued display parses `documents.snapshot`, reprint returns
  the stored PDF.
- **PDF** builds the same `InvoiceDocument` tree through `renderDocumentPdf`; the Chromium render test
  produces a valid `%PDF-` artifact.
- **QR** is generated only when `qrEnabled` and `lifecycle === "issued"`, encoding the opaque
  verification token; preview renders none.
- **Verification** adds the `INVOICE` label at
  [verify page L121](../../app/(public)/verify/[token]/page.tsx#L121) under the unchanged
  `SAFE_VERIFICATION_DISCLOSURE` boundary.
- **History** lists `document_events` with resolved actor names + `print_count`.
- **Reprint** calls `record_invoice_document_reprint` (INVOICE-only, clinic-scoped, operational roles,
  append-only), signs the stored PDF for 5 min, and mutates no snapshot.

### 5. Invoice numbering & idempotency are correct — ✅ PASS

Numbering is `INV` prefix, `yearlyReset: true`, `sequencePadding: 4`
([catalog L305-317](../../lib/documents/catalog.ts#L305-L317)), resolved through effective document
settings (type → global → catalog default) and passed to the reservation. The `periodKey` is the issue
year only when yearly reset is on. Idempotency and number allocation are owned by the reserved P7-0 RPC;
the slice never allocates directly.

### 6. Tax/VAT data is not invented — ✅ PASS

The title is generic (`"Invoice"` / `"الفاتورة"`) — it does **not** unconditionally claim "Tax Invoice".
The tax-registration NotesCallout renders only when `snapshot.branding.taxId` is present
([template L229-235](../../components/documents/templates/invoice.tsx#L229-L235)), surfacing the stored
number verbatim. No VAT percentage or tax line is computed anywhere. This is a deliberate, correct
divergence from the Figma sample (which assumed a taxed clinic). See **O3** on the callout label.

### 7. The existing manual delivery seam is reused — no parallel system — ✅ PASS

`deliverIssuedInvoice` extends the same `compose → render → send` seam
([invoice-delivery.ts](../../lib/messaging/invoice-delivery.ts)), calling the unchanged
`dispatchPatientMessage`. The contract test asserts the file uses `dispatchPatientMessage(`,
`dedupeKey: invoice:${appointmentId}`, and contains no `claim_message_dispatch`. The manual "Send to
patient" action only adds `actorId: user.id`.

### 8. Email and WhatsApp remain independent & per-channel idempotent — ✅ PASS

`dispatchPatientMessage` claims each channel on `message_dispatches` before sending, finalizes on
success, and releases only on definite failure so a succeeded channel is never re-sent and only the
failed channel retries ([automated-send L115-208](../../lib/messaging/automated-send.ts#L115-L208)).
P7-7 adds only an optional `emailAttachments` field; the WhatsApp branch is untouched.

### 9. Email attachment behavior is safe and retry-safe — ✅ PASS

`MessageAttachment.content` is base64 (a plain serializable string across the send boundary);
`sendMessage` forwards attachments **only** when `selected.channel === "email"`
([send.ts L362-363](../../lib/messaging/send.ts#L362-L363)); the Resend adapter maps them to
`Buffer.from(content,'base64')` and omits the field when empty. Attachments are **not** written to
`outbound_messages` (only `body_preview` is), so no PDF bytes leak into the ledger. On retry the
attachment is re-prepared from the idempotent canonical document.

### 10. PDF generation failure degrades safely without duplicate sends — ✅ PASS

`prepareInvoiceAttachment` is best-effort: issuance or download failure is captured to Sentry and returns
`{ attachment: null, documentNumber: null }`, so `deliverIssuedInvoice` proceeds with the existing
text-only summary ([invoice-delivery L165-203](../../lib/messaging/invoice-delivery.ts#L165-L203)). The
send still occurs exactly once per channel (single dispatch, unchanged idempotency). The delivery test
asserts the text-only fallback path leaves `emailAttachments` undefined and still sends once.

### 11. Delivery status / history / retry / audit reuse the existing ledgers — ✅ PASS

No new audit surface: per-channel idempotency + retry is `message_dispatches`; per-send status/provider/
timestamps are `outbound_messages` (repaired by the existing provider webhooks). The migration adds only
the invoice reprint RPC.

### 12. Visual output matches the approved AR/EN Figma design — ✅ PASS

Inspected AR `24:3936` and EN `24:4133`. The implemented primitive order — IdentityHero (with the
StatusBadge) → TotalsSummary (Invoice Total / Insurance Coverage / Amount Due, last emphasized) →
DataTable (Service / Unit price / Qty / Total) → NotesCallout (Billing Notes) → FieldGrid (Subtotal /
Insurance share / Total Paid / per-method breakdown / Outstanding) → tax NotesCallout → VerificationBlock
→ dual SignatureBlock (Authorized + Patient) — matches both frames. The shared header (tenant logo, name,
address, license, contact + INVOICE title/number/date), footer, spacing, and QR presentation are
preserved through the frozen `DocumentPage`; the Stitch placeholder QR square is correctly replaced by
the generated QR. RTL/LTR and Latin digits are asserted by the component and Chromium tests. See **O2**.

### 13. No P7-8 or later scope leaked — ✅ PASS

Grep across the P7-7 files finds no `/documents/new`, no Documents-module list, no Patient File redesign,
and no `PACKAGE_HISTORY_REPORT`/`DEPOSIT_STATEMENT`/`APPOINTMENT_HISTORY_REPORT`/`PATIENT_FINANCIAL_SUMMARY`
/`regenerate` work. The only new route is `/appointments/invoice/document`; the actions are preview/issue/
get/reprint plus the delivery attachment.

### 14. Tests are meaningful and fail closed — ✅ PASS (see O4)

- **Contract** — schema accept/reject, snapshot `version === 1`, catalog registration, and file-level
  assertions of the idempotency key, render seam, and no `allocate_document_number` / no
  `claim_message_dispatch`.
- **Component** — exact primitive order, preview draft (no number, no verification block), issued RTL
  snapshot with canonical number + real QR src, warning-tone status badge, dual signature slots, and a
  negative regex against Arabic-Indic digits.
- **Migration** — reprint is INVOICE-only, clinic-scoped, append-only (no `delete`, no
  `update storage.objects`), operational-role gated, and does not redefine `verify_document_token`.
- **Delivery** — issues + attaches the canonical PDF (asserts filename/contentType + number in the body),
  degrades to text-only on issuance failure, and stays best-effort (null, no send) when the appointment
  is missing.
- **PDF render** — headless-Chromium round-trip producing a valid Arabic A4 `%PDF-`.

Negative paths return `errorCode`/`notFound`/`null` rather than leaking. See **O4** on the structural
string-match assertions.

---

## Findings

### O1 — Observation · The single canonical invoice's locale is fixed at first issuance

The idempotency key `invoice:<appointmentId>` deliberately omits locale, so — unlike the clinical batch
(P7-6 O2) — an appointment yields exactly one invoice. If staff issue the invoice in one locale via the
UI and delivery later runs under the other clinic locale, `issueInvoiceDocument` reuses the first
document, so the emailed PDF carries the first-issued locale. This is the **correct** choice for a tax
invoice (one immutable legal artifact per appointment) and directly satisfies the "one canonical invoice
per appointment" requirement; noted only so a future UI makes the fixed locale explicit.

### O2 — Observation · Line-item "reference" renders the raw `service_id` UUID

`reference: row.service_id ?? null` ([resolver L247](../../lib/documents/resolvers/invoice.ts#L247)) is a
UUID FK to `services.id`, so the invoice shows `REF: <uuid>` where the Figma sample shows a human code
(`DR-CP-001`). This is data-honest — `appointment_services` carries no human reference code — but a raw
UUID reads unprofessionally on a patient-facing document. Consider suppressing the ref line when the
value is a UUID, or joining a `services` short code in a later phase. Analogous to P7-6 O1 (persisted
data lacks the design's sample structure). Non-blocking.

### O3 — Observation · Tax callout is labeled with the document title

The tax-registration NotesCallout uses `label={copy.title}` ("Invoice"/"الفاتورة"), producing a callout
headed "Invoice" whose body is "Tax registration number: …". A dedicated "Tax details" label would read
more clearly. Cosmetic; the data (the number, shown only when configured) is correct.

### O4 — Observation · Two P7-7 suites are structural string-matches

The contract test's idempotency/delivery cases and the migration test assert substrings in source/SQL
rather than behavior, so a semantically wrong but string-matching change would pass them. The behavioral
component, delivery, and Chromium PDF tests cover the important paths, so this is redundancy, not a gap —
consistent with the P7-6 O4 note.

### O5 — Observation · Deposit is attributed to the primary payment-method slot

`buildPaymentBreakdown` folds `deposit_amount` into `row.payment_method` (fallback cash) because the
deposit's original tender is not persisted per appointment
([resolver L155-157](../../lib/documents/resolvers/invoice.ts#L155-L157)). The paid total is unaffected;
only the per-method attribution is an honest approximation. Non-blocking.

---

## Independent validation run

- `pnpm typecheck` (`tsc --noEmit`) — **clean** (exit 0).
- `pnpm vitest run` on `p77-invoice-document-contract`, `p77-invoice-document` (component),
  `p77-invoice-document-migration`, `p3d-invoice-delivery`, `p70-document-catalog` — **21 passed / 5
  files**.
- `pnpm vitest run tests/unit/integration/p77-invoice-pdf-render.test.tsx` (headless Chromium) —
  **1 passed** (valid Arabic A4 `%PDF-`).
- `pnpm vitest run tests/unit/components/p72-document-conformance.test.tsx` — **5 passed** (INVOICE
  included in the conformance gate).
- AR/EN i18n parity for `documentPlatform.invoice` — **40/40 keys, no drift**.
- Figma MCP inspection of Invoice AR `24:3936` and EN `24:4133` — implemented hierarchy matches the
  approved composition; placeholder QR replaced by the generated QR.

No production code was modified during this review. No commit was made.

---

**Verdict: APPROVED.**
