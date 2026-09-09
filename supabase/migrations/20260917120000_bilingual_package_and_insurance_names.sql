-- Bilingual, clinic-authored display names for package templates and insurance
-- providers.
--
-- WHY
--
-- The second half of the same problem `20260916120000_bilingual_display_names`
-- solved for departments, services and staff. A clinic administers ClinicFlow
-- through an English admin UI, so its package catalog is stored as "Acne
-- Treatment Package" and its insurers as "AXA" — and an Arabic patient asking
-- «ايه الباكيدجات المتاحة؟» or «بتتعاملوا مع تأمينات ايه؟» gets either the
-- English string or an invented Arabic one. The first is honest and reads
-- badly; the second is not an option at all, because a machine-produced
-- rendering of a company name is a different company's name.
--
-- These columns are the third option: a name a person at the clinic typed, in
-- each language, beside the canonical one.
--
-- WHAT THIS IS NOT
--
--   * Not a rename. `package_templates.name` and `insurance_providers.name`
--     are untouched, stay NOT NULL, and remain what billing, the patient
--     package rows, the appointment insurance allocations, the audit trail and
--     every staff screen read. Nothing in this migration reads or writes them.
--   * Not a backfill. Every column lands NULL and stays NULL until somebody at
--     the clinic fills it in. There is no UPDATE statement here and there must
--     never be one: an AI-generated or transliterated value written into a
--     patient-facing name column is indistinguishable, a week later, from one a
--     person authored.
--   * Not a constraint. Nullable, no defaults, no checks beyond length, no
--     uniqueness. A clinic that fills in neither language keeps exactly the
--     behaviour it has today.
--
-- BLAST RADIUS
--
--   * Two ALTER TABLE ... ADD COLUMN IF NOT EXISTS statements on nullable
--     columns with no default. In PostgreSQL 11+ this is a catalog-only change:
--     no table rewrite, milliseconds on any size of table.
--   * No existing row changes. No index is created.
--   * No function, trigger, policy or view is redefined. In particular
--     `public.list_clinic_public_packages` is NOT touched — the patient
--     assistant reads `package_templates` directly for the localized catalog,
--     under the same visibility rule that function applies (active template,
--     active department), so the RPC keeps its exact current signature and
--     every existing caller keeps its exact current result.
--   * RLS is inherited from the tables, which already have it; new columns on
--     an RLS-protected table are covered by the existing policies.
--   * Reverse: four DROP COLUMN statements. The data in them is not referenced
--     by anything else.
--
-- FORWARD COMPATIBILITY
--
-- The application does not require these columns to exist. Every patient-facing
-- read that names them goes through `selectWithOptional`
-- (`lib/settings/display-names.ts`), which retries the select without them, so
-- the assistant keeps working on a database where this migration has not run.
-- The settings screens that let staff type the names are the part that needs
-- it applied.

alter table public.package_templates
  add column if not exists name_ar text,
  add column if not exists name_en text;

alter table public.insurance_providers
  add column if not exists name_ar text,
  add column if not exists name_en text;

-- Length only, and matched to the canonical column each one sits beside
-- (`package_templates.name` is 1..120, `insurance_providers.name` is 2..100).
-- Shape is a human's judgement and a check constraint that tried to police "is
-- this really Arabic?" would reject a clinic's own transliterated brand name.
alter table public.package_templates
  drop constraint if exists package_templates_display_name_length,
  add constraint package_templates_display_name_length check (
    (name_ar is null or char_length(btrim(name_ar)) between 1 and 120)
    and (name_en is null or char_length(btrim(name_en)) between 1 and 120)
  );

alter table public.insurance_providers
  drop constraint if exists insurance_providers_display_name_length,
  add constraint insurance_providers_display_name_length check (
    (name_ar is null or char_length(btrim(name_ar)) between 1 and 100)
    and (name_en is null or char_length(btrim(name_en)) between 1 and 100)
  );

comment on column public.package_templates.name_ar is
  'Clinic-authored Arabic display name shown to patients. Never machine-generated; NULL falls back to package_templates.name.';
comment on column public.package_templates.name_en is
  'Clinic-authored English display name shown to patients. Never machine-generated; NULL falls back to package_templates.name.';
comment on column public.insurance_providers.name_ar is
  'Clinic-authored Arabic display name shown to patients. Never machine-generated; NULL falls back to insurance_providers.name.';
comment on column public.insurance_providers.name_en is
  'Clinic-authored English display name shown to patients. Never machine-generated; NULL falls back to insurance_providers.name.';
