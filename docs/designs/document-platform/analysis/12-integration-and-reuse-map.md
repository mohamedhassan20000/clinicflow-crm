# 12 · Integration & Reuse Map

## Objective

Show exactly what the document platform **reuses** from existing ClinicFlow infrastructure vs the
small set of **net-new** systems and dependencies — and trace every shared requirement to where it
is satisfied. The guiding rule (per the brief): avoid parallel systems where the platform already
solves the problem.

---

## 1. Reuse map

| Concern | Existing asset | How the platform uses it |
|---------|---------------|--------------------------|
| Authentication / session | `lib/supabase/server`, middleware | Unchanged; documents live under the existing protected/public segments |
| Roles & authorization | `lib/rbac.ts` (`requireRole`, `requireMutationRole`, `AuthedUser`) | Every document action guards with the catalog's `pageRoles`; issuance uses the billing-aware mutation guard |
| Page visibility | `lib/page-permissions.ts`, `user_page_permissions`, `lib/primary-admin.ts` | Add a `documents` page slug; primary-admin gates Documents Settings |
| Per-item visibility | `actions/report-permissions.ts`, `user_report_permissions` | Same catalog-driven pattern generalizes to per-document-type visibility if wanted |
| Catalog pattern | `lib/reports/catalog.ts` (`REPORT_CATALOG`) | `DOCUMENT_CATALOG` mirrors it; overlaps on report ids for docs 01/02/08–13 |
| Report data | `lib/reports/data.ts` + report RPCs (RLS-scoped) | Reused directly for **6 of the 8** analytical docs (01/02/08/09/12/13). Docs **10 Sales** and **11 Follow-up Analytics** have **no existing resolver** and are net-new data work (see §2 and doc 02 §5) |
| Audit trail | `activity_events` (append-only, SECURITY DEFINER, spoof-proof) | Security-relevant document actions (issue/void/regenerate) recorded here |
| i18n & direction | next-intl (en/ar), `localeDirection()`, `messages/*` | Document copy in a new `documents` namespace; `dir` from `localeDirection` |
| Fonts | `app/fonts.ts` — Thmanyah Sans + Manrope | Reused as-is; inlined `@font-face` for Chromium; **no new fonts** |
| Design system | shadcn + Tailwind v4, `components/ui/*` | Primitives + settings UI built on existing tokens/components |
| Formatting | `lib/datetime.ts`, `lib/currency/format.ts` | Wrapped by a Latin-digit-always document formatter (doc 03 §3) |
| Storage & signed URLs | `patient-assets` bucket + pattern in `actions/patient-documents.ts` | New `clinic-documents` bucket follows the same pattern |
| Attachments | `patient_documents` / staff-files records + buckets | Source for Patient/Staff File merge (doc 11 §6) |
| Tables & URL filters | `@tanstack/react-table`, `nuqs` | The Documents module list + filters |
| Forms & validation | `react-hook-form`, `zod` | The create/params forms |
| Email delivery | `resend` (+ `app/api/webhooks/resend`) | Invoice email delivery (§16) |
| WhatsApp delivery | existing messaging layer (`lib/messaging`, WhatsApp webhooks) | Invoice WhatsApp delivery (§16) |
| Charts | `recharts` | Progress/share bars in analytical reports (11, 13) if rendered as charts |
| Rate limiting | `lib/rate-limit` | Throttle the public verification page |
| Activity/security precedent | Phase-8 `activity_events` design | Blueprint for `document_events` invariants |

---

## 2. Net-new systems

| New system | Why it can't be reused | Doc |
|------------|------------------------|-----|
| Document rendering engine (`<DocumentPage>` + primitives + templates) | No document/print rendering exists today | 03, 04 |
| `DOCUMENT_CATALOG` | New vocabulary (16 doc types incl. non-report types) | 02 |
| `documents` / `document_events` / `document_counters` / `document_settings` | No document persistence exists | 06, 09, 10, 11 |
| PDF render runtime (headless Chromium) | No PDF generation exists (greenfield) | 03 §9 |
| Public verification route | No public verification exists | 07 |
| Latin-digit document formatter | App formatters honor the clinic's Arabic-digit setting; documents must not | 03 §3 |
| Documents module + Settings pages | New surfaces | 08, 09 |
| Sales + Follow-up Analytics resolvers | No `sales`/follow-up-analytics id exists in `REPORT_CATALOG`; each needs a new RLS-scoped resolver/RPC + data-honesty review + fixtures | 02 §5, 13 P7-4 |
| Expanded clinic branding schema (tax/VAT, custom footer, metadata bag) | Beyond the contact-line columns; required for the "Tax Invoice" and the P7C model | 11 §5 |

---

## 3. New dependencies (minimal, vetted — founder-approved policy)

| Dependency | Purpose | Notes |
|-----------|---------|-------|
| `puppeteer-core` + `@sparticuz/chromium` | Server-side HTML→PDF | Node/Fluid function; standard for design-rich PDFs on serverless |
| `qrcode` | Generate the verification QR | Small, widely used; server-side to inlined data-URI |
| `pdf-lib` | Merge Patient/Staff File attachments into the PDF | Pure JS; no native binary |

No new **fonts** and no new UI framework — the design system and fonts are reused.

---

## 4. Gaps to close (surfaced by this analysis)

1. **Clinic branding columns** — add `email`, `website`, `license_no`, **`tax_id` (VAT/TRN),
   `document_footer`, and a `branding_metadata jsonb` bag** to `clinics`, on top of the §3.2
   `fix_clinics_cross_tenant_policies` RLS hardening (doc 11 §5). Tax/VAT identity is required for the
   "Tax Invoice."
2. **Latin-digit formatter** — new document formatting layer (doc 03 §3).
3. **`documents` page slug** — add to the page-permission model (doc 08 §6).
4. **Sales + Follow-up Analytics resolvers** — no existing report resolver; net-new data pipelines
   (doc 02 §5), built and RLS-reviewed in Phase P7-4.
5. **Clinical authoring forms** (prescription/lab/sick-leave) — an **upstream future dependency**
   (SHARED_REQUIREMENTS §14); the platform renders/issues once the authored record exists but does
   not build the forms.
6. **Invoice delivery — reconcile with the already-built flow, not a parallel one.** Manual invoice
   delivery already exists (`AI_AGENT_PLAN.md` 2026-07-19 revision / P3D): a manual "Send to patient"
   action, independent Email/WhatsApp channels, the `compose summary → render message → send` seam
   (§7.3a), and the `message_dispatches` idempotency ledger (`lib/messaging/invoice-delivery.ts`).
   Phase P7-7 wires the rendered PDF into **that** seam and ledger; the SHARED_REQUIREMENTS §16
   post-completion prompt (WhatsApp/email/both/not-now) **augments** that manual flow rather than
   replacing it. Confirm the §16 prompt behavior with the founder (open question, doc 14).

---

## 5. Requirements traceability

Every shared requirement mapped to where it is satisfied.

### Global product requirements
| Requirement | Satisfied in |
|-------------|-------------|
| Existing Arabic + English fonts, no new fonts | doc 03 §9, doc 04 §2, doc 12 §1 |
| Latin digits always (incl. Arabic) | doc 03 §3 |
| Branding from Clinic Settings only | doc 03 §6, doc 11 §5 |
| Document identity (number, issue date, clinic, QR) | doc 03 §7–§8, docs 05–07 |
| Server-side numbering; preview ≠ number; reprint reuses; retire/never reuse | doc 06, doc 05 |
| QR → public verification page; safe metadata only | doc 07 |
| Watermark (default clinic name; toggle+text; behind content; AR/EN) | doc 03 §5, doc 09 §1.1 |
| Shared rendering engine (RTL/LTR, header/footer, page #, QR, branding, watermark, signatures, stamps, print, PDF) | docs 01, 03, 04 |
| Documents module (create/preview/print/export/regenerate/history/quick-access) | doc 08 |
| Filtering combinations, per-type relevant filters | doc 08 §3 |
| Documents Settings (watermark, numbering, QR, print options, extensible) | doc 09 |
| Document history (number, type, by, date, print/regen history, verification id) | doc 10 |
| Patient/Staff File optional attachments | doc 08 §5, doc 11 §6 |
| Integration/reuse of existing infra | this doc |

### `SHARED_REQUIREMENTS.md` §1–§16
| § | Topic | Satisfied in |
|---|-------|-------------|
| §1 | Separate AR/EN designs | doc 03 §2 |
| §2 | Remove Stitch chrome | doc 04 (only printable primitives), doc 03 |
| §3 | Consistent shared header/footer | doc 03 §7, doc 04 §5 |
| §4 | Shared document identity fields | doc 03 §6–§7, doc 11 §5 |
| §5 | Machine-readable mark; QR vs barcode | doc 07 §1 |
| §6 | Mark opens public verification page | doc 07 §3 |
| §7 | Strict disclosure limits | doc 07 §3 |
| §8 | Server-side, atomic, per-clinic, per-type numbering | doc 06 |
| §9 | Preview consumes no number | doc 05 §1/§3, doc 06 §4 |
| §10 | Reprints retain original identity | doc 05 §3, doc 06 §4 |
| §11 | Issued numbers never reused | doc 06 §4, doc 11 §7 |
| §12 | Admin-configurable watermark text | doc 09 §1.1 |
| §13 | Watermark behavior (+enable/disable open Q → decided) | doc 03 §5, doc 09 §1.1 |
| §14 | Clinical docs need future authoring forms | doc 02 §D, this doc §4 |
| §15 | Future patient-file redesign | doc 02 §C, doc 08 §5 |
| §16 | Invoice post-completion delivery prompt | this doc §4, doc 14 (open Q) |
