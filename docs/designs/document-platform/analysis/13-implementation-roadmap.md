# 13 · Implementation Roadmap

## Objective

Sequence the work so that **infrastructure and reusable systems come before document-specific
implementation**, de-risk the hardest unknown (PDF fidelity) early with one vertical slice, then
scale documents by archetype, and finish with the module, settings, history, and delivery.

Each phase lists: **objectives · scope · dependencies · order · deliverables · risks.** This is a
plan, not a schedule — no code is written by this task.

> **Phase naming (reconciled with the master roadmap).** These engineering phases live **inside
> Phase 7** of `docs/AI_AGENT_PLAN.md` §8 and are named **`P7-0` … `P7-10`** so they never collide
> with the project-level `P0–P7` phases or the completed `P7A`/`P7B` sub-phases. In master-roadmap
> terms this sequence **restructures and supersedes the old `P7C` (branding) + `P7D` (engine) +
> `P7E` (templates)** split into a de-risked, archetype-batched order. `P7A` (the requirements
> catalog) is done — but its scope is now the **16-document set** (doc 02), superseding the original
> 8-document committed catalog (see doc 02 §6 and `docs/documents/README.md`). `P7B` (approved
> visual designs) is satisfied by the 16 imported designs under `docs/designs/document-platform/`,
> subject to the **P7-2 conformance gate** below.

```
P7-0 Foundations ─▶ P7-1 Rendering engine ─▶ P7-2 Design→Engine conformance gate ─▶ P7-3 Vertical slice (1 doc e2e)
        └▶ P7-4 Analytical batch ─▶ P7-5 Roster+Profile ─▶ P7-6A Clinical authoring foundations ─▶ P7-6 Clinical ─▶ P7-7 Invoice+Delivery
                 └▶ P7-8 Documents module ─▶ P7-9 Documents settings ─▶ P7-10 Hardening
                 └▶ P7-11 Patient File redesign ─▶ P7-12 History & financial document types
```
Phases P7-4…P7-7 depend on P7-0…P7-3; the module (P7-8) can start in parallel once P7-3 lands.

> **2026-08-02 update — clinical authoring unblock + patient-file redesign.** P7-6 was **blocked**
> (`docs/reports/P7-6_IMPLEMENTATION.md`): the repo has no structured prescription/lab/sick-leave source
> record and no clinician-licence source. Three phases are added and one is expanded — authoritative detail
> in **`analysis/16-clinical-authoring-and-patient-file-redesign.md`**:
> - **P7-6A — Clinical Authoring Foundations (NEW):** the durable, auditable clinical records + clinician
>   credentials + drug/lab catalogs that P7-6 depends on (SHARED_REQUIREMENTS §14).
> - **P7-8 — Documents module (SCOPE EXPANDED):** `/documents/new` also launches the shared structured
>   clinical-authoring forms and supports administrative subject selection (incl. external subjects).
> - **P7-11 — Patient File redesign (NEW):** the SHARED_REQUIREMENTS §15 redesign — unified appointment
>   history, packages, deposits, documents integration, contextual clinical actions.
> - **P7-12 — History & financial document types (NEW):** `APPOINTMENT_HISTORY_REPORT` (required) +
>   `PACKAGE_HISTORY_REPORT` + `DEPOSIT_STATEMENT` + `PATIENT_FINANCIAL_SUMMARY`.

---

## Phase P7-0 — Foundations (data + numbering + branding)

- **Objectives:** the type-agnostic persistence and identity primitives everything else needs.
- **Scope:** `documents`, `document_events`, `document_counters`, `document_settings` tables +
  RLS; `allocate_document_number` RPC; the **idempotent issuance guard** (doc 05 §3.1 — dedupe key +
  render-failure rollback semantics); `clinics` branding columns (email/website/license **+ tax/VAT
  identifiers + custom footer + extensible metadata bag**, doc 11 §5); the `clinic-documents` storage
  bucket; the Latin-digit document formatter (`lib/documents/format.ts`) + bidi helpers;
  `DOCUMENT_CATALOG` skeleton (types + a couple of entries).
- **Dependencies:** none (pure infra). Confirm whether the P7C clinic-scoped RLS hardening
  (`fix_clinics_cross_tenant_policies`) is a prerequisite for the tax/VAT + license columns (they must
  not leak cross-tenant).
- **Order:** migrations → RPC + idempotency guard → formatter/bidi → catalog scaffold.
- **Deliverables:** schema + RLS, atomic numbering RPC (with concurrency test), **idempotent issue
  path (retry-safe, with rollback on render failure) proven by test**, branding fields (incl.
  tax/VAT + footer + metadata) live in Clinic Settings, formatter unit-tested for AR/EN Latin digits.
- **Risks:** RLS scope mistakes → mitigate by mirroring existing report/entity RLS; counter
  concurrency → covered by the locked upsert + unique constraint; partial-issue on render failure →
  covered by the idempotency guard + rollback (doc 05 §3.1).

## Phase P7-1 — Rendering engine (Layer 0 + Layer 1)

- **Objectives:** the shared chrome + primitive library, renderable on screen and to PDF.
- **Scope:** `<DocumentPage>` (A4, direction, watermark, page numbers, branding injection, render
  context); the ~15 Layer-1 primitives (doc 04 §1); the Chromium PDF renderer with inlined
  Thmanyah/Manrope `@font-face`; browser-print CSS; QR generation (`qrcode`) in `VerificationBlock`.
  **The Layer-1 primitive contract is frozen here** — it is the reference the P7-2 gate measures each
  design against.
- **Dependencies:** P7-0 (branding, formatter).
- **Order:** chrome → primitives → browser print → Chromium render → QR.
- **Deliverables:** a storybook-style harness rendering every primitive in AR + EN; a Chromium
  round-trip producing a pixel-faithful A4 PDF with correct Arabic fonts and Latin digits; a written
  primitive contract (props + pagination/`@page` + optional-field degradation rules).
- **Risks (highest of the project):** Arabic font fidelity + RTL in headless Chromium →
  neutralized by inlined local fonts and a fidelity check in this phase, before any document
  depends on it; serverless Chromium cold start/**bundle size** → use `@sparticuz/chromium` on a
  Node/Fluid function and make the function bundle-size limit an explicit **pass/fail gate**; keep
  browser-print as the interactive fallback if the serverless path regresses.

## Phase P7-2 — Design → Engine conformance gate (every document, before it is built)

- **Objectives:** guarantee that **each of the 16 imported designs is faithfully reproducible on the
  frozen primitive contract before any template is coded** — satisfying `AI_AGENT_PLAN.md` §8
  correction (b) ("design is engine-constrained, never free-form art that cannot be reproduced").
- **Scope:** for **every** document type (AR + EN):
  1. **Cleanup** — remove the non-printable Stitch chrome, backgrounds, browser frames, demo nav,
     floating controls, and the placeholder QR (SHARED_REQUIREMENTS §2, §5).
  2. **Token extraction** — read exact type/spacing/color tokens from **Figma (the source of truth;
     `FIGMA_REFERENCE.md` node ids)**, not the screenshots.
  3. **Primitive mapping** — map the design to Layer-1 primitives (doc 04 §7 archetype table); any
     region that no primitive covers must either compose existing primitives or **justify** a new one
     against the archetype gate (doc 14 §1). No new primitive is added silently.
  4. **Reproducibility sign-off** — a rendered engine mock of the design (AR + EN) is compared to the
     Figma frame; pagination, RTL balance, Latin digits, and bidi isolation are confirmed.
- **Dependencies:** P7-1 (frozen primitive contract).
- **Order:** run per document; a document does **not** enter its archetype batch (P7-3…P7-7) until it
  passes this gate. The gate for the vertical-slice document (Revenue Report) runs first.
- **Deliverables:** a per-document conformance sheet (cleaned design, extracted tokens, primitive
  map, sign-off) for all 16; a list of any newly justified primitives folded back into P7-1.
- **Risks:** a design that cannot be reproduced faithfully → caught here, cheaply, before a template
  is built on it; scope creep in the primitive library → the archetype gate is the control.

## Phase P7-3 — Vertical slice: one document end-to-end

- **Objectives:** prove the whole pipeline on **one** document before scaling.
- **Scope:** implement **Revenue Report (01)** end-to-end: catalog entry → data resolver (reuse
  `lib/reports/data.ts`, `revenue`) → template (Layer 2) → preview (DRAFT, no number) → issue
  (allocate + **idempotent** snapshot + PDF store) → reprint → verification page → history events → an
  actions module (`actions/documents.ts`).
- **Dependencies:** P7-0, P7-1, P7-2 (Revenue Report conformance sign-off).
- **Order:** catalog+resolver → template → preview → issue → verify → reprint → history.
- **Deliverables:** Revenue Report issuable in AR + EN, verifiable, reprintable; the reusable
  action/lifecycle skeleton every later document copies (incl. the idempotency/rollback pattern).
- **Risks:** hidden coupling in the lifecycle → this is exactly why it's a slice; fix the skeleton
  here where it's cheap.

## Phase P7-4 — Analytical batch (archetype A, remaining 7)

- **Objectives:** the bulk of the catalog on the proven slice — **but with honest data-layer sizing.**
- **Scope:** documents 02, 08, 09, 12, 13 — each = a catalog entry + a thin template + a **reused**
  report resolver (`followups`, `cancellations`, `no_shows`, `doctor_performance`,
  `receptionist_performance`). **Plus documents 10 (Sales) and 11 (Follow-up Analytics), which have
  NO existing report resolver in `REPORT_CATALOG` and are treated as net-new data work** (see doc 02
  §5, doc 12 §2): each needs a new RLS-scoped resolver/RPC, its own data-honesty review, and fixtures —
  not a thin template addition.
- **Dependencies:** P7-3; P7-2 conformance sign-off for each of the 7.
- **Order:** the 5 resolver-reuse documents first (cheap), then 10 Sales and 11 Follow-up Analytics
  (each carries a resolver-build sub-task before its template).
- **Deliverables:** 8/16 analytical documents complete; two new report resolvers (Sales, Follow-up
  Analytics) built and RLS-reviewed.
- **Sizing note:** this phase is **larger than a pure template batch** because 2 of its 8 documents
  are new data pipelines. Budget for two resolver builds + reviews, not seven near-copies.
- **Risks:** new Sales/Analytics resolvers widening data access → mirror existing report RLS and review
  each; wide tables/landscape (doc 12) and share-bar rendering (11, 13) → covered by primitive
  variants, no engine change.

## Phase P7-5 — Roster + Profile (archetypes B & C)

- **Objectives:** grouped-list and entity-profile documents, including attachments.
- **Scope:** 03 Patient List, 14 System Members (GroupedTables); 04 Patient File, 15 Staff File
  (IdentityHero + FieldGrid + schedule) **with the attachment picker + `pdf-lib` merge**.
- **Dependencies:** P7-3; P7-2 sign-off; attachment sources (`patient_documents`, staff-files) exist.
- **Order:** roster first (simpler), then profiles, then attachment merge.
- **Deliverables:** 12/16 complete; attachment-merged Patient/Staff File PDFs.
- **Risks:** PDF merge of heterogeneous attachments (image/PDF) → `pdf-lib`, MIME already
  constrained; large attachments → enforce the existing size limits + a total merged-size/page cap;
  source attachment later deleted must not break reprint (doc 11 §6 — the merged bytes are the record).

## Phase P7-6A — Clinical Authoring Foundations (NEW — the upstream data source P7-6 depends on)

- **Objectives:** create the durable, doctor-attributed, auditable clinical records + clinician
  credentials + reference catalogs that P7-6 renders from. This is the SHARED_REQUIREMENTS §14 dependency
  made real. Authoritative design: **doc 16**.
- **Scope:** clinician credentials + signature/stamp asset on `profiles`; clinic-managed drug/lab catalogs
  (department-scoped, optional, autocomplete + controlled-medicine block) + settings UI; the clinical
  tables `prescriptions`(+`prescription_medications`), `lab_requests`(+`lab_request_tests`),
  `sick_leaves` — each with `created_by` + `responsible_doctor_id` + patient/external-subject identity +
  optional `appointment_id` — with authorized-staff RLS; `actions/clinical/*` as the **sole** business-logic
  owner; `lib/validations/clinical.ts`; the shared `components/clinical/*` authoring forms; finalization +
  full audit; the `medical_notes.appointment_id` link.
- **Authoring policy (founder):** any authorized staff (Admin/Manager/Receptionist/Doctor/Assistant-when-
  enabled) may prepare a record; `responsible_doctor_id` is mandatory; clinical validity is asserted by the
  physician's signature/stamp on the issued document — see doc 16 §3.
- **Dependencies:** P7-0 (identity/RLS patterns), existing `patients`/`medical_notes` RLS, `departments`.
- **Order:** credentials + catalogs → clinical tables + RLS → `actions/clinical/*` + zod → shared forms.
- **Deliverables:** authored clinical records persist independently of any document; catalogs manageable;
  clinician credentials editable; `medical_notes.appointment_id` live.
- **Risks:** clinical data honesty → the record is authored by a human, never synthesized from notes/
  appointments/browser (doc 16 §2); tenant isolation → extend `validate_document_tenant_references()` for
  the new subject FKs + `responsible_doctor_id`.

## Phase P7-6 — Clinical documents (archetype D — now UNBLOCKED by P7-6A)

- **Objectives:** prescription, lab request, sick-leave — render + issue + verify **from the persisted
  clinical record's snapshot.**
- **Scope:** register the 3 declared codes; 05, 06, 07 templates (`DataTable` Rx, `ChecklistPanel`,
  `CertifyingProse`) + stamp/seal slots; resolvers read the P7-6A records; reprint RPCs; verify labels.
  **Mandatory rendering rules (doc 16 §6):** credential + signature/stamp snapshot on issue; a labelled
  blank signature/stamp area when the physician has no stored asset (all three types); the bilingual
  prescription validity note.
- **Dependencies:** P7-3; P7-2 sign-off; **and P7-6A (the clinical records + credentials) — now the real
  data source.** No clinical content is ever accepted from a browser payload or derived from notes.
- **Order:** prescription → lab → sick-leave.
- **Deliverables:** 15/16 complete.
- **Risks:** clinical/legal sensitivity → strict verification disclosure already enforced (doc 07);
  controlled medicines → blocked at issue until an approved compliance profile exists (doc 16 §4.4).

## Phase P7-7 — Invoice + delivery (archetype E)

- **Objectives:** the invoice (a **tax invoice** — see doc 11 §5 tax/VAT) and its WhatsApp/email
  delivery, built **on the existing delivery seam, not a parallel one.**
- **Scope:** 16 Invoice template (totals cards, line items, payment breakdown, tax/VAT where the clinic
  is configured, dual signatures); wiring the stored PDF into the **already-built** manual invoice
  delivery flow (`AI_AGENT_PLAN.md` §7.3a `compose summary → render message → send` seam, the manual
  "Send to patient" action, independent Email/WhatsApp channels, and the `message_dispatches`
  idempotency ledger). The SHARED_REQUIREMENTS §16 post-completion prompt (WhatsApp/email/both/not-now)
  is reconciled against that existing manual flow — it augments, it does not replace (doc 12 §4.5,
  doc 14 Q3).
- **Dependencies:** P7-3; existing billing (`lib/billing`), messaging (`lib/messaging/*` incl.
  `invoice-delivery.ts` + `message_dispatches`), and email layers; founder confirmation of the §16
  prompt behavior (doc 14 Q3).
- **Order:** invoice template → issue → reconcile with existing delivery seam → §16 prompt.
- **Deliverables:** 16/16 documents complete; invoice deliverable by WhatsApp/email through the
  unchanged delivery workflow, now carrying the rendered professional tax invoice.
- **Risks:** duplicating the existing delivery/idempotency layer → avoided by reusing the seam and
  ledger; tax/VAT correctness → gated on the branding tax fields from P7-0.

## Phase P7-8 — Documents module / Central Document Factory (can start after P7-3; clinical dispatch after P7-6A)

- **Objectives:** the central hub / document factory: history list, filters, actions, navigation, **and the
  centralized create flow that also launches structured clinical authoring.**
- **Scope:** `/documents` list (TanStack + nuqs), per-type relevant filters, `/documents/new`,
  `/documents/[id]` timeline, row actions, the `documents` page slug + nav entry, contextual deep-links
  from surfaces. **Scope expansion (doc 16 §7):** at `/documents/new`, **clinical types dispatch to the
  shared `components/clinical/*` authoring forms** (create/load a record, then issue) rather than a param
  form; report/history types keep the param form. Administrative subject selection (search/select any
  patient), plus a per-type **`allowsExternalSubject`** capability (default false) for preparing a document
  for a non-registered person via snapshot-only identity.
- **Dependencies:** P7-0 (tables), P7-3 (one issuable document to list); **P7-6A for the clinical-authoring
  dispatch**; grows as P7-4…P7-7 add types.
- **Order:** list+filters → detail/timeline → create flow (param) → clinical-authoring dispatch → contextual links.
- **Deliverables:** full module usable for all shipped types; clinical records authorable from the factory
  with no duplicated business logic (shared owner, doc 16 §5).
- **Risks:** filter combinatorics → catalog-driven `filterSchema` keeps it declarative; external-subject
  policy → gated by the `allowsExternalSubject` capability + founder confirmation (doc 14).

## Phase P7-9 — Documents Settings

- **Objectives:** watermark/numbering/QR/print settings, catalog-driven and extensible.
- **Scope:** `/settings/documents`, `document_settings` CRUD (primary-admin), branding-completeness
  surfacing (incl. tax/VAT + footer + metadata, doc 09 §1.5), per-type resolution (override → global →
  catalog default).
- **Dependencies:** P7-0 (settings table), P7-1 (watermark/QR consume settings).
- **Deliverables:** admins can configure per-type watermark toggle+text, prefixes (future-only),
  QR on/off, print defaults; branding completeness (incl. tax/VAT) is surfaced.
- **Risks:** prefix edits vs history → guarded by immutability + unique constraint (doc 06 §5).

## Phase P7-10 — Hardening

- **Objectives:** production-readiness.
- **Scope:** authorization tests (each type's `pageRoles`), verification enumeration/rate-limit
  tests, **idempotent-issue + render-failure-rollback tests**, AR/EN + Latin-digit + bidi visual QA
  per document, PDF fidelity regression, void/reprint/regenerate edge cases, performance of Chromium
  under load (with the bundle-size gate), storage retention, and `/verify` cache/`noindex` posture
  (doc 07, doc 14 Q5).
- **Dependencies:** all prior phases.
- **Deliverables:** the platform signed off against the requirements traceability matrix (doc 12 §5).
- **Risks:** regenerate policy still open → keep reprint-only until the founder confirms (doc 14).
- **Scope note:** P7-10 also adds clinical-authoring authz tests, finalized-record immutability tests, and
  external-subject audit tests introduced by P7-6A/P7-8.

## Phase P7-11 — Patient File redesign & unified history (NEW — SHARED_REQUIREMENTS §15)

- **Objectives:** make the Patient File the primary clinical workspace; group related information instead
  of scattering it. Authoritative design: **doc 16 §8**.
- **Scope:** unified appointment-history section (per appointment: details+status, follow-up, invoice/
  billing, the appointment's medical note via `medical_notes.appointment_id`, related clinical documents) —
  **latest 5** + "Full history" button; full appointment-history page (custom range + last week/month/year,
  scope-preserving); Packages section + dedicated page; Deposits section + dedicated page; keep + integrate
  the Documents section; contextual **New Prescription / Lab Request / Sick Leave** buttons opening the
  shared authoring forms (patient + encounter preselected); decompose the 868-line monolith into per-section
  server components.
- **Dependencies:** P7-6A (`medical_notes.appointment_id`, clinical records + contextual authoring forms);
  P7-12 for the print buttons' document types (or ship UI first, wire print when P7-12 lands).
- **Order:** medical-note link + unified section → full history page → packages/deposits pages → contextual
  clinical actions → decomposition.
- **Deliverables:** grouped, scope-safe Patient File; a full history page ready to print via the engine.
- **Risks:** must preserve the `isScopedClinical` role-gated fetching + doctor no-financials rule at both
  query and RLS layers (doc 16 §8); no new financial schema — reuse the existing billing computation.

## Phase P7-12 — History & financial document types (NEW)

- **Objectives:** the printable history/financial documents the redesign feeds. Authoritative design:
  **doc 16 §9**.
- **Scope:** `APPOINTMENT_HISTORY_REPORT` (**required**), `PACKAGE_HISTORY_REPORT`, `DEPOSIT_STATEMENT`,
  `PATIENT_FINANCIAL_SUMMARY` — engine slices (catalog entry + resolver + template + renderer + copy +
  actions + reprint RPC) reusing the P7-11 unified queries and the existing billing computation.
- **Dependencies:** P7-11 (unified appointment/packages/deposits queries); the engine (P7-1…P7-3).
- **Order:** appointment history → package history → deposit statement → financial summary.
- **Deliverables:** patient history/financial documents issuable, verifiable, reprintable in AR + EN.
- **Risks:** financial correctness → resolvers reuse the audited billing computation, no re-implementation;
  `PATIENT_FINANCIAL_SUMMARY` scope/identity → patient-scoped only (doc 14).

---

## Ordering rationale

1. **Infra before documents** (P7-0…P7-1) — nothing renders without the engine + persistence.
2. **Conformance before templates** (P7-2) — every design is proven reproducible on the frozen
   primitive contract before a single template is built on it (§8 correction (b)).
3. **One vertical slice** (P7-3) — the hardest risk (PDF/RTL/font fidelity, lifecycle + idempotency
   correctness) is proven on one document where mistakes are cheap, before it multiplies across 16.
4. **Batch by archetype** (P7-4…P7-7) — each archetype shares a body composition, so documents inside
   a batch are near-copies — **except** the two net-new analytical resolvers (Sales, Follow-up
   Analytics), which are sized as data work, and the clinical batch, which is gated on upstream forms.
5. **Module/settings alongside** (P7-8…P7-9) — the hub grows with the catalog rather than blocking it.
6. **Harden last** (P7-10) — against the explicit requirements matrix.
