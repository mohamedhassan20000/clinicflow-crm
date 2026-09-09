-- Bilingual, clinic-authored display names for departments, services and staff.
--
-- WHY
--
-- An Arabic-speaking clinic administers ClinicFlow through an English admin UI,
-- so its departments are stored as "Dermatology", its services as "Acne
-- Treatment Session" and its doctors under their Latin-script names. The
-- patient assistant then has two bad options in an Arabic conversation: show
-- the English string, or invent an Arabic one. It has always done the first,
-- which is the honest option and still reads badly; the second is not an option
-- at all, because a machine-produced rendering of a doctor's name is a
-- different doctor's name.
--
-- These columns are the third option: a name a person at the clinic typed, in
-- each language, beside the canonical one.
--
-- WHAT THIS IS NOT
--
--   * Not a rename. `departments.name`, `services.name` and
--     `profiles.full_name` are untouched, stay NOT NULL where they already
--     were, and remain what search, invoices, exports, the audit trail and
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
--   * Three ALTER TABLE ... ADD COLUMN IF NOT EXISTS statements on nullable
--     columns with no default. In PostgreSQL 11+ this is a catalog-only change:
--     no table rewrite, no full-table lock held for the scan, milliseconds on
--     any size of table.
--   * No existing row changes. No index is created, so no write amplification.
--   * No function, trigger, policy or view is redefined, so nothing that is
--     currently running can start behaving differently because of this file.
--   * RLS is inherited from the tables, which already have it; new columns on
--     an RLS-protected table are covered by the existing policies.
--   * Reverse: three DROP COLUMN statements. The data in them is not referenced
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

alter table public.departments
  add column if not exists name_ar text,
  add column if not exists name_en text;

alter table public.services
  add column if not exists name_ar text,
  add column if not exists name_en text;

-- `display_name_*` rather than `full_name_*`: a doctor's file carries their
-- legal full name and this is the name patients are shown, which is not always
-- the same string even within one language.
alter table public.profiles
  add column if not exists display_name_ar text,
  add column if not exists display_name_en text;

-- Length only. Shape is a human's judgement and a check constraint that tried
-- to police "is this really Arabic?" would reject a clinic's own transliterated
-- brand name.
alter table public.departments
  drop constraint if exists departments_display_name_length,
  add constraint departments_display_name_length check (
    (name_ar is null or char_length(btrim(name_ar)) between 1 and 120)
    and (name_en is null or char_length(btrim(name_en)) between 1 and 120)
  );

alter table public.services
  drop constraint if exists services_display_name_length,
  add constraint services_display_name_length check (
    (name_ar is null or char_length(btrim(name_ar)) between 1 and 160)
    and (name_en is null or char_length(btrim(name_en)) between 1 and 160)
  );

alter table public.profiles
  drop constraint if exists profiles_display_name_length,
  add constraint profiles_display_name_length check (
    (display_name_ar is null or char_length(btrim(display_name_ar)) between 1 and 120)
    and (display_name_en is null or char_length(btrim(display_name_en)) between 1 and 120)
  );

comment on column public.departments.name_ar is
  'Clinic-authored Arabic display name shown to patients. Never machine-generated; NULL falls back to departments.name.';
comment on column public.departments.name_en is
  'Clinic-authored English display name shown to patients. Never machine-generated; NULL falls back to departments.name.';
comment on column public.services.name_ar is
  'Clinic-authored Arabic display name shown to patients. Never machine-generated; NULL falls back to services.name.';
comment on column public.services.name_en is
  'Clinic-authored English display name shown to patients. Never machine-generated; NULL falls back to services.name.';
comment on column public.profiles.display_name_ar is
  'Clinic-authored Arabic display name shown to patients. Never machine-generated; NULL falls back to profiles.full_name. The honorific is added by the presentation layer, not stored here.';
comment on column public.profiles.display_name_en is
  'Clinic-authored English display name shown to patients. Never machine-generated; NULL falls back to profiles.full_name.';
