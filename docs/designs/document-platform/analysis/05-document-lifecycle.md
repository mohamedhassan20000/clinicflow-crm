# 05 · Document Lifecycle

## Objective

Define the states an issued document moves through and the rules that govern each transition,
so that numbering, verification, history, and reprint/regenerate all agree on one model.

---

## 1. States

| State | Meaning | Has number? | Has stored PDF? | Verifies as |
|-------|---------|-------------|-----------------|-------------|
| **Preview** | A rendering for review; not a document | No (`PREVIEW` placeholder) | No | n/a (no token) |
| **Issued** | A permanent, numbered, verifiable document | Yes (immutable) | Yes (canonical) | `valid` |
| **Void** | Issued then invalidated (error/cancellation) | Yes (retired) | Yes (retained) | `void` / `cancelled` |

There is no "draft persisted" state: a document either is a transient preview or is issued.

---

## 2. State machine

```
                 preview(params)                 issue(params)
   [ surface ] ─────────────────▶ (Preview) ───────────────────▶ (Issued)
        ▲            no number         │  allocate number             │
        │            DRAFT mark        │  freeze snapshot             │  print / reprint
        │                              │  render + store PDF          │  (no state change)
        │                              │                              │
        │                              └── discard (no trace) ◀───────┘
        │                                                             │ void
        │        regenerate = new issue (new number, current data)    ▼
        └──────────────────────────────────────────────────────  (Void / Cancelled)
```

---

## 3. Transition rules

### Preview → (nothing persisted)
- Rendered from live params/data with the **DRAFT** watermark and a `PREVIEW` number.
- **Never consumes a number** (SHARED_REQUIREMENTS §9). No `documents` row is written.
- Requires read authorization (`requireRole`) but not a mutation guard.

### Preview/Surface → Issued
- `requireMutationRole(...)` (billing-aware, matching every other mutating action).
- **Allocate** the permanent number atomically (per-clinic + per-type; doc 06). Allocation
  happens exactly once, here.
- **Freeze the snapshot:** persist the fully-resolved dataset (`snapshot jsonb`) **and** the
  input `params`, so the document can be re-rendered identically forever.
- **Render + store** the canonical PDF (Chromium) to the documents bucket.
- Write the `documents` row (number, opaque verification token, snapshot, pdf path, locale,
  effective watermark) and a `document.issued` lifecycle event (+ `activity_events`).

### Idempotent issuance & rollback (issue is retry-safe)

Issue is a multi-step mutation (allocate number → resolve data → render PDF → persist row) that can be
retried by a double-click, a client network retry, or a Chromium timeout-then-retry. It must be
**idempotent** so a retry never burns a number or creates a duplicate document, and must **roll back
cleanly** if a later step fails — matching P7A's requirement that issuance be "transactional,
concurrency-safe, and idempotent," and the codebase precedent of the `message_dispatches` /
`dedupeKey` ledger used for invoice delivery.

- **Idempotency key.** `issue()` accepts (or derives) an idempotency key — a client-supplied token,
  or a natural key such as `(clinic_id, doc_type, source_ref, params_hash, locale)`. A completed issue
  for that key returns the **existing** document instead of allocating again. This is the guard against
  duplicate documents for the same logical record + inputs.
- **Ordering & rollback.** The safe order is: **(1)** resolve data and render the PDF to a temporary
  location (the failure-prone, retryable steps) **before** touching the counter; **(2)** then, in a
  single transaction, allocate the number, persist the `documents` row, finalize the PDF path, and
  write the `document.issued` event. If the transaction fails, **no number is consumed**. If the PDF
  render fails, no number is consumed and the operation is safely retryable.
  - If a design constraint forces allocation before render (e.g. the number must appear inside the
    rendered PDF), then on render failure the half-issued row is marked `failed`/rolled back and the
    number is **retired, not reused** (§11) — a gap is acceptable (doc 06 §4). The idempotency key
    still prevents a retry from allocating a second number.
- **Never a partial issue.** A `documents` row is only visible as `issued` once it has a number, a
  snapshot, and a stored PDF. Intermediate failures leave either nothing (preferred) or a retired
  number, never a usable document missing its snapshot/PDF.

### Issued → printed / reprinted (no state change)
- **Reprint = re-serve the stored canonical PDF** from the immutable snapshot (correction #5).
  Same number, same QR, byte-identical figures. Increments print count; logs `printed` /
  `reprinted` event.
- Browser print of the on-screen issued view also logs a print event.

### Issued → Void / Cancelled
- Marks the document `void`/`cancelled`. The number is **retired, never reused**
  (SHARED_REQUIREMENTS §11). The PDF and snapshot are **retained** for audit.
- The verification page then reports `void`/`cancelled` (doc 07).
- Logs a `voided` event (+ `activity_events`, as a security-relevant action).

### Regenerate (deliberately **not finalized** — correction #5)
- Conceptually: produce a **new** document from **current** data → **new number**, new
  snapshot, new PDF. It never mutates the original.
- Open questions (see doc 14): does regenerate auto-void the prior issue or leave both valid?
  Is it allowed for all types or only where "latest data" is meaningful (reports/invoice, not a
  signed sick-leave)? Who may regenerate? These are decided with the founder before build.
- The roadmap builds **reprint first** (unambiguous) and treats regenerate as a scoped
  follow-up once its policy is confirmed.

---

## 4. Why snapshot-at-issue is non-negotiable

Most documents are **period-scoped aggregates** (revenue, sales, performance, follow-up
analytics) or **point-in-time financials** (invoice). If a reprint re-ran the query later:
- Yesterday's "Revenue Report — June" would silently change as new June data trickles in or as
  records are edited/voided — a legal/accounting hazard.
- Two prints of "the same" numbered document could disagree.

Freezing the resolved data (and the PDF) at issue guarantees an issued document is a permanent,
immutable record. This single decision is what makes "reprint reuses the number" safe and gives
"regenerate" a clean, separate meaning.

Trade-off: storage of a JSON snapshot + a PDF per issued document. This is cheap and bounded,
and is the correct cost for immutable records. (Alternative: store only params and re-resolve —
rejected; it reintroduces drift.)

---

## 4a. Clinical documents — two-layer lifecycle (record ↔ issued snapshot)

Clinical documents (prescription/lab/sick-leave) add an **authoring layer upstream of issuance** (P7-6A,
doc 16). The document lifecycle above is unchanged; a **separate clinical record** is the source of truth.

```
CLINICAL RECORD (Layer 1, doc 16 §2)              ISSUED DOCUMENT (Layer 2, this doc)
draft ──▶ finalized (locked) ─────────────────▶  Preview → Issued → Void
  • prepared by authorized staff                    • snapshot frozen from the finalized record
  • created_by + responsible_doctor_id              • number at issue only; preview consumes none
  • patient/external subject + encounter link       • credentials + signature/stamp snapshotted
  • full audit                                       • idempotency key derived from the record id
```

- The engine resolver reads the **persisted** clinical record and snapshots it — it never accepts clinical
  content from a browser payload or synthesizes it from notes/appointments.
- **Preparer vs physician:** the record permanently stores `created_by` (the authenticated preparer, any
  authorized staff role) and a mandatory `responsible_doctor_id` (the physician of record). Clinical
  **validity** is asserted by that physician's signature/stamp on the issued document, not by an in-app
  doctor-only gate (doc 16 §3).
- **Credential + signature snapshot:** issuing a clinical document freezes the responsible physician's
  credentials (name, licence, specialty, title, signature/stamp asset) into `snapshot`, so reprints stay
  faithful if the profile later changes. When no signature/stamp asset exists, every render shows a labelled
  blank signature/stamp area (doc 16 §6).
- **Finalization vs void:** a finalized record is the clinical source; amendment policy after issuance
  (immutable + correction-as-new-record, or editable) is a founder decision (doc 14) tied to regenerate.

## 5. Lifecycle ↔ watermark ↔ verification (one coherent model)

| Lifecycle | Watermark | Verification status |
|-----------|-----------|--------------------|
| Preview | `DRAFT` (always) | no token / not verifiable |
| Issued | per-type setting (custom text or clinic name; or off) | `valid` |
| Void / Cancelled | retained as issued | `void` / `cancelled` |

Preview being watermarked `DRAFT` regardless of settings makes it structurally impossible to
pass a preview off as an issued document.
