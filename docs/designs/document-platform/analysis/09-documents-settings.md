# 09 · Documents Settings

## Objective

Define the dedicated Documents Settings page: what it configures, how it stays extensible for
future document types, and how it reuses the existing settings infrastructure.

**Route:** `app/(protected)/settings/documents/` — a new tab alongside the existing settings
pages (`clinic`, `staff`, `services`, `customize`, …). **Primary-admin gated**, reusing
`lib/primary-admin.ts` (`isPrimaryClinicAdmin`) exactly as report/page permissions do.

---

## 1. Settings inventory

### 1.1 Watermark (per-type override + toggle) — founder decision
- A **global default** (applies to every type unless overridden): custom text, empty ⇒ clinic
  name.
- A **per-document-type override**: enable/disable toggle **+** custom text.
- Preview always shows `DRAFT` regardless (doc 03 §5, doc 05 §5).
- Stored in `document_settings` keyed by `(clinic_id, doc_type|null)` — `null` = global default.

### 1.2 Document numbering (view + prefix)
- View the current prefix and next sequence per type (read-mostly).
- **Editable prefix** per type; changes affect **future** allocations only and never rewrite
  history (doc 06 §5). The UI states this explicitly.
- Optional per-type toggle for **yearly reset** of the sequence.
- Resetting/rewinding a counter is intentionally **not** offered (would risk reuse; §11).

### 1.3 QR / verification behavior
- Enable/disable the QR per document type (some clinics may not want QR on internal reports).
- Display the (read-only) verification base URL (`clinicflow.fit/verify/…`) so admins know what
  the QR resolves to.

### 1.4 Default print options
- Default paper size (A4) and margins.
- **Include-attachments default** for Patient File / Staff File (off by default; the issue-time
  picker still lets the user choose per document — doc 08 §5).
- Default locale/direction for a document when issued outside a language context (falls back to
  the clinic locale).

### 1.5 Clinic-branding completeness (surfaced here, edited in Clinic Settings)
The header/footer need logo, name, address, phone, **email**, **website**, **license/
registration**, **tax/VAT identifier**, an optional **custom document footer**, and the
**extensible branding metadata bag** (doc 11 §5). The `clinics` table today has
name/phone/logo_url/address but **not** email/website/license/tax-VAT/footer/metadata. This page
**surfaces the gap** (a completeness checklist linking to Clinic Settings) so documents never render
with blank identity fields — and, in particular, **flags a missing tax/VAT identifier before an
Invoice ("Tax Invoice") is issued**. The fields themselves are edited in the existing Clinic Settings
page, not duplicated here.

### 1.6 Future document-specific settings
Any future per-type setting (e.g. a default signatory label, a per-type footer disclaimer)
attaches to the same per-type settings model with no schema change for additive JSON options.

---

## 2. Extensibility model

Settings are stored **keyed by `doc_type`** with a nullable `doc_type` meaning "global default":

```
document_settings (
  clinic_id  uuid,
  doc_type   text null,          -- null = clinic-wide default; else per-type override
  watermark_enabled boolean,
  watermark_text    text null,
  qr_enabled        boolean,
  numbering_prefix  text null,    -- override of the catalog default
  numbering_yearly_reset boolean,
  print_options     jsonb,        -- paper/margins/include-attachments/etc. (additive)
  updated_at timestamptz,
  primary key (clinic_id, coalesce(doc_type,''))
)
```

- **Resolution order** at render/issue: per-type override → clinic global default → catalog
  default. A new document type inherits sensible defaults **with no configuration and no
  migration** (correction #6): if no row exists, the catalog default applies.
- The settings **UI is generated from the catalog** — it iterates `DOCUMENT_CATALOG` and renders
  a row per type, exactly as `Settings → Customize` iterates `REPORT_CATALOG` today. Adding
  document #17 makes it appear here automatically.

---

## 3. Authorization & reuse

| Concern | Reused mechanism |
|---------|-----------------|
| Who can edit | `isPrimaryClinicAdmin` (`lib/primary-admin.ts`) — same gate as report permissions |
| Settings actions | `actions/documents-settings.ts` following `actions/settings.ts` / `report-permissions.ts` patterns (`requireMutationRole('admin')` + primary-admin check, `revalidatePath`) |
| i18n | next-intl `settings` + a new `documents` namespace |
| UI | existing shadcn form/switch/input/select primitives (`components/ui/*`) |
| Catalog-driven rows | mirrors `Settings → Customize` iterating a catalog |

---

## 4. What deliberately is **not** here

- Editing an already-issued document's number/watermark/data (issued documents are immutable —
  doc 05). Settings affect only future issuance.
- Clinical content templates for prescription/lab/sick-leave (those are future authoring forms,
  SHARED_REQUIREMENTS §14).
