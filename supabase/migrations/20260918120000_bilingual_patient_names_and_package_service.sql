-- Bilingual patient names, and a package template's service items.
--
-- ================================ WHY =====================================
--
--   1. **A patient record holds one name.** A clinic administers ClinicFlow in
--      English and its patients write on WhatsApp in Arabic, so «علي الزناتي»
--      and "Ali Alzanaty" are the same person written twice and the record can
--      only keep one of them. The assistant already asks for both — the Arabic
--      the patient typed and the English spelling they confirm (see
--      `latinNameOutcome` in `lib/ai/v2/flows.ts`) — and had nowhere to put the
--      pair.
--
--   2. **A package template names a department and nothing narrower.** Staff
--      building "10-session Rehabilitation Package" have to retype prices, and
--      nothing records *what is in* the package, so the assistant cannot tell a
--      patient which services a package covers or what each of them costs.
--
-- =========================== WHAT THIS IS NOT ==============================
--
--   * **Not a rename.** `patients.full_name`, `ai_patient_intakes.full_name`
--     and `package_templates.department_id` are untouched, stay NOT NULL, and
--     remain what search, billing, the audit trail, identity folding
--     (`fold_patient_name`) and every staff screen read.
--   * **Not identity.** The two name columns are *display* names. Nothing in
--     this file, and nothing in the application, matches a patient on them.
--     `find_clinic_patient_by_identity` is not touched and still folds
--     `patients.full_name` against an exact national id — a bilingual name is
--     not proof of anything and must never become one.
--   * **Not one service per package.** An earlier draft of this migration put
--     a single `package_templates.service_id` on the header. A package is a
--     *basket*: zero, one or many services from the package's department, each
--     with its own session count and its own package price. That is a child
--     table, and section 3 is it. There is no `service_id` on the header, no
--     repeated `service_1_id` columns and no JSON blob.
--   * **Not a backfill.** Every new column lands NULL and stays NULL, and the
--     new table lands empty. There is no UPDATE and no INSERT at the top level
--     of this file, and there must never be one: a transliterated value in a
--     patient-facing name column is indistinguishable, a week later, from one
--     a person authored, and an item row invented for an existing package is a
--     price nobody at the clinic agreed to.
--   * **Not a requirement.** Every existing package keeps working with zero
--     item rows. A department-only package is a supported, permanent shape.
--
-- ============================= BLAST RADIUS ================================
--
--   * Four `alter table ... add column if not exists` on nullable columns with
--     no default. In PostgreSQL 11+ that is a catalog-only change: no table
--     rewrite, milliseconds on any size of table.
--   * Two new unique indexes, on `services (clinic_id, department_id, id)` and
--     `package_templates (clinic_id, department_id, id)`. `id` is already the
--     primary key of both, so neither index adds a uniqueness rule the table
--     did not already have — they exist so the item table's foreign keys can
--     carry the clinic *and the department*, and therefore cannot be satisfied
--     by another clinic's or another department's row.
--   * One new table, `package_template_items`, with RLS enabled and policies
--     that mirror `package_templates` exactly (clinic members read; admins
--     write).
--   * One new SECURITY **INVOKER** function, `set_package_template_items`. It
--     is deliberately not a definer: RLS on both tables is the authorization,
--     and a definer here would be a second, weaker copy of the policies above.
--   * Three SECURITY DEFINER functions replaced. **See section 6 — that is
--     the part that needs a human decision.**
--   * One trigger function replaced (`enforce_ai_pending_booking_policy`) and
--     one small read-only predicate added
--     (`ai_conversation_booking_beneficiary_matches`), so that an approved
--     third-party booking can name the beneficiary while the conversation
--     keeps naming the sender. **See section 9.** No `create trigger` is
--     re-issued and no trigger changes shape.
--   * Reverse: drop the function and table from sections 3-5, drop the four
--     columns and two indexes, restore the two intake functions from
--     `20260824120000_p10_assistant_style_and_booking_identity.sql`,
--     `stage_matched_third_party_intake` from
--     `20260911120000_existing_patient_identity_discovery.sql`, and
--     `enforce_ai_pending_booking_policy` from
--     `20260822190000_ai_patient_intake_booking_followup.sql`, then drop
--     `ai_conversation_booking_beneficiary_matches`.
--
-- ========================= FORWARD COMPATIBILITY ===========================
--
-- The application does not require any of this to exist:
--
--   * every settings and patient read that names the new columns goes through
--     `selectWithOptional` (`lib/settings/display-names.ts`), which retries
--     without them;
--   * every write drops a blank display name from the payload entirely
--     (`stripBlankDisplayNames`), so a clinic that authors none sends
--     byte-for-byte the payload it sent before;
--   * the package item reads and writes tolerate a missing table and a missing
--     RPC (`PGRST202`/`PGRST205`) and degrade to exactly today's
--     header-only package;
--   * `stagePatientIntakeFromConversation` (`lib/supabase/admin.ts`) calls the
--     wide RPC once and falls back to the pre-migration argument list on
--     `PGRST202`, so an intake is still staged — without the display names —
--     on a database where this has not been applied.

-- ---------------------------------------------------------------------------
-- 1. Patient display names, in each language
-- ---------------------------------------------------------------------------

alter table public.patients
  add column if not exists full_name_ar text,
  add column if not exists full_name_en text;

-- Length only, matched to the canonical column beside them
-- (`patients.full_name` is validated 2..100 by `patientSchema`). Shape is a
-- human's judgement: a check that tried to police "is this really Arabic?"
-- would reject a patient's own transliterated name.
alter table public.patients
  drop constraint if exists patients_display_name_length,
  add constraint patients_display_name_length check (
    (full_name_ar is null or char_length(btrim(full_name_ar)) between 2 and 100)
    and (full_name_en is null or char_length(btrim(full_name_en)) between 2 and 100)
  );

comment on column public.patients.full_name_ar is
  'Optional Arabic display name. Never used for search, matching or identity; NULL falls back to patients.full_name.';
comment on column public.patients.full_name_en is
  'Optional English display name. Never used for search, matching or identity; NULL falls back to patients.full_name.';

-- ---------------------------------------------------------------------------
-- 2. The same pair on the staging table, so an authored name survives review
-- ---------------------------------------------------------------------------

alter table public.ai_patient_intakes
  add column if not exists full_name_ar text,
  add column if not exists full_name_en text;

alter table public.ai_patient_intakes
  drop constraint if exists ai_patient_intakes_display_name_length,
  add constraint ai_patient_intakes_display_name_length check (
    (full_name_ar is null or char_length(btrim(full_name_ar)) between 2 and 100)
    and (full_name_en is null or char_length(btrim(full_name_en)) between 2 and 100)
  );

comment on column public.ai_patient_intakes.full_name_ar is
  'Arabic name as the patient typed it. Display only; approval copies it to patients.full_name_ar.';
comment on column public.ai_patient_intakes.full_name_en is
  'English spelling the patient confirmed. Display only; approval copies it to patients.full_name_en.';

-- ---------------------------------------------------------------------------
-- 3. The services a package template contains
-- ---------------------------------------------------------------------------
--
-- ## Why a child table
--
-- "Package" is a basket the clinic priced: «باكيدج التأهيل» is 5 rehabilitation
-- sessions at 1300 plus 3 sports-injury sessions at 1800. One `service_id` on
-- the header can hold the first line and loses the second. Repeated columns
-- cap the basket at whatever number was guessed, and a JSON blob puts the
-- clinic's prices somewhere no constraint, no foreign key and no index can
-- reach them. So: one row per line, which is what a line is.
--
-- ## What the database guarantees, rather than the dropdown
--
-- Two composite foreign keys, and between them they make three whole classes
-- of wrong row unrepresentable:
--
--   * **same clinic** — both keys carry `clinic_id`, so an item can name
--     neither another clinic's package nor another clinic's service;
--   * **package ownership** — the item's `package_template_id` must be a
--     package in this clinic, and the key cascades on delete so a package
--     takes its own lines with it;
--   * **same department** — both keys carry `department_id`, and the item
--     stores it once. A row therefore only exists if the package's department
--     and the service's department are *the same* department. Cross-department
--     integrity is not left to the form filtering the dropdown; a hand-written
--     INSERT cannot produce it either.
--
-- ## Deleting a service
--
-- `on delete restrict` on the service key, and that is deliberate. The product
-- has no hard delete for a service — `softDeleteService` sets `deleted_at`,
-- and a soft-deleted service leaves every package that contains it completely
-- intact, because the item row carries the clinic's own agreed
-- `price_per_session` and never reads the service's current price. So RESTRICT
-- exists for the one path the product does not offer: a hand-written
-- `delete from services`. Refusing it is right. The alternative rules are both
-- worse — `cascade` would silently delete a priced line and quietly change a
-- package's total, and `set null` cannot apply to a column the package's
-- integrity depends on. Nothing here deletes, or can delete, a package.
--
-- ## Prices are stored, never derived
--
-- `price_per_session` on the item is the clinic's package price for that
-- service, seeded from the service's price the moment a person picks it in the
-- form and independent of it for ever afterwards. It is not a discount, not a
-- multiplier and not a reference — it is the number the clinic agreed to. A
-- later price change on the service catalog does not, and must not, reprice a
-- package, and editing a package price does not, and must not, write back to
-- `services.price`.

-- Referenceable by (clinic_id, department_id, id) so the item's foreign keys
-- can carry both. `id` is already the primary key of each table, so neither
-- index introduces a uniqueness rule that did not already hold.
create unique index if not exists services_clinic_department_id_key
  on public.services (clinic_id, department_id, id);

create unique index if not exists package_templates_clinic_department_id_key
  on public.package_templates (clinic_id, department_id, id);

create table if not exists public.package_template_items (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  package_template_id uuid not null,
  -- Denormalized so the two foreign keys below can both carry it, which is
  -- what makes "the service is in the package's department" a database rule
  -- rather than a convention. It is never edited on its own: the write
  -- function takes it from the package.
  department_id uuid not null,
  service_id uuid not null,
  sessions integer not null
    check (sessions > 0 and sessions <= 10000),
  -- numeric(12,2), matching `services.price` and `package_templates`' own two
  -- money columns. Money in this schema is never a float.
  price_per_session numeric(12,2) not null
    check (price_per_session >= 0 and price_per_session <= 99999999.99),
  sort_order integer not null default 0
    check (sort_order >= 0 and sort_order <= 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint package_template_items_template_fkey
    foreign key (clinic_id, department_id, package_template_id)
    references public.package_templates (clinic_id, department_id, id)
    on update cascade
    on delete cascade,
  constraint package_template_items_service_fkey
    foreign key (clinic_id, department_id, service_id)
    references public.services (clinic_id, department_id, id)
    on update restrict
    on delete restrict,
  -- One line per service. A package that wants "10 sessions" of a service says
  -- so in `sessions`; two lines for the same service are two prices for the
  -- same thing and the patient-facing total would depend on which one was read
  -- first.
  constraint package_template_items_service_once
    unique (package_template_id, service_id)
);

create index if not exists package_template_items_template_idx
  on public.package_template_items (package_template_id, sort_order);

create index if not exists package_template_items_service_idx
  on public.package_template_items (clinic_id, service_id);

comment on table public.package_template_items is
  'The services one package template contains: zero, one or many, each with its own session count and its own clinic-agreed package price. Zero rows is a department-only package and is fully supported. Prices here are authoritative and are never recomputed from services.price.';
comment on column public.package_template_items.department_id is
  'The package''s department, denormalized so both foreign keys carry it. This is what makes "the service belongs to the package''s department" a database rule.';
comment on column public.package_template_items.price_per_session is
  'The clinic''s package price per session for this service. Seeded from services.price at authoring time and independent of it afterwards; changing it never writes to services.price.';

drop trigger if exists trg_package_template_items_updated_at on public.package_template_items;
create trigger trg_package_template_items_updated_at
before update on public.package_template_items
for each row
execute function public.set_updated_at();

drop trigger if exists trg_audit_package_template_items on public.package_template_items;
create trigger trg_audit_package_template_items
after insert or delete or update on public.package_template_items
for each row
execute function public.write_audit_log();

-- ---------------------------------------------------------------------------
-- 4. RLS on the item table, mirroring the parent exactly
-- ---------------------------------------------------------------------------
--
-- The same four policies `package_templates` carries, with the same predicates:
-- a clinic member reads their clinic's rows, and only an admin writes. An item
-- is part of a package and must not be reachable by anyone who could not reach
-- the package itself.

alter table public.package_template_items enable row level security;

drop policy if exists "clinic_members_read_package_template_items" on public.package_template_items;
create policy "clinic_members_read_package_template_items"
  on public.package_template_items
  for select
  to authenticated
  using (clinic_id = public.auth_clinic_id());

drop policy if exists "admin_insert_package_template_items" on public.package_template_items;
create policy "admin_insert_package_template_items"
  on public.package_template_items
  for insert
  to authenticated
  with check (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = 'admin'::public.user_role
  );

drop policy if exists "admin_update_package_template_items" on public.package_template_items;
create policy "admin_update_package_template_items"
  on public.package_template_items
  for update
  to authenticated
  using (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = 'admin'::public.user_role
  )
  with check (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = 'admin'::public.user_role
  );

drop policy if exists "admin_delete_package_template_items" on public.package_template_items;
create policy "admin_delete_package_template_items"
  on public.package_template_items
  for delete
  to authenticated
  using (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = 'admin'::public.user_role
  );

grant all on table public.package_template_items to authenticated;
grant all on table public.package_template_items to service_role;
revoke all on table public.package_template_items from anon;

-- ---------------------------------------------------------------------------
-- 5. Replacing a package's item set, atomically
-- ---------------------------------------------------------------------------
--
-- ## Why this is a function and not three PostgREST calls
--
-- Editing a package's contents is "these are the lines now" — a delete and a
-- set of inserts that are only correct together. Three round trips can be
-- interrupted between any two of them and leave a package with half its lines
-- and a total that matches neither shape. One statement, one transaction.
--
-- ## Why SECURITY INVOKER
--
-- Because the authorization already exists and is already right: RLS on
-- `package_templates` and `package_template_items` says a clinic member reads
-- their own clinic and only an admin writes. Running as the invoker means those
-- policies *are* the check. A SECURITY DEFINER here would bypass them and then
-- have to re-implement them in PL/pgSQL, which is how the copy drifts from the
-- original. There is no privilege to contain here, so none is taken.
--
-- ## The one direction of derivation
--
-- Items are the input; the header's roll-up is computed from them. Never the
-- reverse, and never both — `list_patient_ai_packages`, the booking write and
-- the session-consumption path all read `package_templates.total_sessions`, so
-- that number has to keep agreeing with the lines beneath it. An item-less
-- package is not touched at all: its numbers are what a person typed, a
-- deliberately discounted total included.

create or replace function public.set_package_template_items(
  p_template_id uuid,
  p_items jsonb default '[]'::jsonb
)
returns table (item_count integer, total_sessions integer, items_total numeric)
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_template public.package_templates%rowtype;
  v_count integer;
  v_sessions integer;
  v_total numeric;
  v_single numeric;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'PACKAGE_ITEMS_INVALID' using errcode = '22023';
  end if;
  -- A basket, not a catalog. Fifty lines is far past any package a clinic
  -- sells and well short of anything that would make this statement slow.
  if jsonb_array_length(p_items) > 50 then
    raise exception 'PACKAGE_ITEMS_TOO_MANY' using errcode = '22023';
  end if;

  -- No clinic argument, deliberately: RLS decides which row this is allowed to
  -- see and write, so there is no tenant id a caller could get wrong.
  select t.* into v_template
  from public.package_templates t
  where t.id = p_template_id
  for update;
  if not found then
    raise exception 'PACKAGE_TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Shape first, so a malformed line is a named error rather than a check
  -- violation from three statements later.
  --
  -- `service_id` is matched against the UUID text form *before* anything casts
  -- it. `'abc'::uuid` raises `invalid input syntax for type uuid` — a raw
  -- PostgreSQL error that names a type rather than the field, reaches the
  -- caller as an unmapped failure, and differs in wording between server
  -- versions. A caller sending a malformed id deserves the same controlled,
  -- named refusal as one sending a negative session count. The pattern is the
  -- canonical 8-4-4-4-12 hex form, which is exactly what `::uuid` accepts here:
  -- PostgreSQL also tolerates a braced or unhyphenated spelling, and rejecting
  -- those is correct rather than strict — every id in this system is generated
  -- by `gen_random_uuid()` and serialized in the canonical form, so an
  -- alternative spelling is a hand-assembled payload, not a client.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as e(item)
    where (e.item ->> 'service_id') is null
       or (e.item ->> 'sessions') is null
       or (e.item ->> 'price_per_session') is null
       or (e.item ->> 'service_id')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (e.item ->> 'sessions') !~ '^[0-9]+$'
       or (e.item ->> 'sessions')::integer not between 1 and 10000
       or (e.item ->> 'price_per_session') !~ '^[0-9]+(\.[0-9]+)?$'
       or (e.item ->> 'price_per_session')::numeric > 99999999.99
  ) then
    raise exception 'PACKAGE_ITEM_INVALID' using errcode = '22023';
  end if;

  -- One line per service, refused by name rather than by constraint.
  --
  -- `package_template_items_service_once` would catch this anyway, but as a
  -- `unique_violation` naming an index — which tells a caller nothing about
  -- which field was wrong, and would arrive only after the delete had already
  -- removed the package's existing lines inside this transaction. Two lines for
  -- one service are two prices for the same thing, and the package total would
  -- depend on which was read first. The constraint stays: this is the message,
  -- and the constraint is the guarantee.
  if (
    select count(distinct e.item ->> 'service_id')
    from pg_catalog.jsonb_array_elements(p_items) as e(item)
  ) <> pg_catalog.jsonb_array_length(p_items) then
    raise exception 'PACKAGE_ITEM_DUPLICATE_SERVICE' using errcode = '22023';
  end if;

  -- Every line must name a service this clinic still sells, in *this package's*
  -- department. The foreign keys below already make a cross-clinic and a
  -- cross-department row unrepresentable; this adds the two things a key
  -- cannot express — still active, not soft-deleted — and turns the whole set
  -- into one named error instead of a raw constraint violation.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as e(item)
    where not exists (
      select 1 from public.services s
      where s.id = (e.item ->> 'service_id')::uuid
        and s.clinic_id = v_template.clinic_id
        and s.department_id = v_template.department_id
        and s.is_active
        and s.deleted_at is null
    )
  ) then
    raise exception 'PACKAGE_ITEM_SERVICE_INVALID' using errcode = '23514';
  end if;

  delete from public.package_template_items i
  where i.package_template_id = v_template.id;

  insert into public.package_template_items (
    clinic_id, package_template_id, department_id, service_id,
    sessions, price_per_session, sort_order
  )
  select v_template.clinic_id,
         v_template.id,
         v_template.department_id,
         (e.item ->> 'service_id')::uuid,
         (e.item ->> 'sessions')::integer,
         pg_catalog.round((e.item ->> 'price_per_session')::numeric, 2),
         (e.ord - 1)::integer
  from pg_catalog.jsonb_array_elements(p_items) with ordinality as e(item, ord);

  select count(*)::integer,
         coalesce(sum(i.sessions), 0)::integer,
         coalesce(sum(i.sessions * i.price_per_session), 0)::numeric
    into v_count, v_sessions, v_total
  from public.package_template_items i
  where i.package_template_id = v_template.id;

  if v_count > 0 then
    -- The header's own constraints, checked by name here so a clinic that asks
    -- for something the header cannot hold is told which limit it hit.
    if v_sessions > 10000 then
      raise exception 'PACKAGE_ITEMS_SESSIONS_TOO_MANY' using errcode = '22003';
    end if;
    if v_total > 99999999.99 then
      raise exception 'PACKAGE_ITEMS_TOTAL_TOO_LARGE' using errcode = '22003';
    end if;

    -- A single-service package still has one meaningful price per session, and
    -- the packages table shows it. A multi-service package has several, so the
    -- header holds none rather than one of them chosen arbitrarily.
    select case when count(*) = 1 then min(i.price_per_session) else null end
      into v_single
    from public.package_template_items i
    where i.package_template_id = v_template.id;

    update public.package_templates t
    set total_sessions = v_sessions,
        price_per_session = v_single,
        total_price = v_total,
        updated_at = now()
    where t.id = v_template.id;
  end if;

  return query select v_count, v_sessions, v_total;
end;
$function$;

-- `authenticated` and nobody else.
--
-- This function is SECURITY INVOKER: its entire authorization is the RLS on
-- `package_templates` and `package_template_items`, which asks who the caller
-- is. `service_role` bypasses RLS, so granting it EXECUTE would hand it a
-- writer with *no* check at all — every policy above silently skipped — and the
-- function would go from "RLS is the authorization" to "RLS is the
-- authorization unless you hold the service key". Nothing needs that: the only
-- caller is the Settings mutation, which runs on the signed-in admin's own
-- session client, and `createClinicScopedAdminClient` classifies
-- `package_template_items` read-only precisely so the service role cannot write
-- a package price by another route.
--
-- The revoke names `service_role` explicitly rather than relying on the
-- `public` revoke to reach it, so the intent survives a future default grant.
revoke all on function public.set_package_template_items(uuid, jsonb)
  from public, anon, service_role;
grant execute on function public.set_package_template_items(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- 6. FUNCTIONS — the part that needs a human decision
-- ---------------------------------------------------------------------------
--
-- Three SECURITY DEFINER functions are replaced. All three replacements are
-- built from the **currently deployed bodies**, read back out of Production
-- with `pg_get_functiondef` rather than copied from an older migration file,
-- so the diff below is a diff against what is actually running.
--
--   * `stage_patient_intake_from_conversation` gains two optional text
--     arguments and writes them to the two new intake columns. Because the
--     argument list changes, `create or replace` would create a *second*
--     overload and leave PostgREST unable to choose, so the old signature is
--     dropped first. **That drop is the one irreversible-looking statement in
--     this file** — it is immediately followed by the create, in the same
--     transaction.
--
--   * `approve_ai_patient_intake` keeps its signature exactly (`uuid, uuid`)
--     and is a plain `create or replace`.
--
--   * `stage_matched_third_party_intake` (section 8) keeps its signature and
--     is otherwise untouched by the bilingual work. It is replaced here only
--     because it is the *other* writer of a third-party intake, and the
--     requester invariant below has to hold for both or it does not hold at
--     all. Folding it in keeps the intended end state atomic: one migration,
--     one transaction, no window in which one writer enforces the invariant
--     and the other does not.
--
-- All three also carry the shared-phone correction described next; the first
-- and third carry the requester invariant described with it.
--
-- ================== THE THIRD-PARTY REQUESTER INVARIANT ===================
--
-- **An intake with `is_third_party = true` names the patient who asked for
-- it.** `requested_by_patient_id` is the only column that records who asked
-- the clinic to open or reuse a file for somebody who never messaged it, and
-- both staging functions derived it from `conversations.patient_id` while
-- accepting a null one. An unlinked sender could therefore file a named third
-- person — national id, date of birth, contact number — attributed to nobody,
-- and no application guard prevented it (the booking flow's beneficiary
-- question runs at `identity: "none"`).
--
-- Both writers now require, for a third-party staging only, that the
-- conversation is linked to a patient that exists, belongs to this clinic and
-- is not deleted, and raise `THIRD_PARTY_REQUESTER_NOT_LINKED` otherwise. An
-- exception rather than a new `status` value, because the v2 assistant's
-- `stageIntake` boundary reads only the RPC's error and not the returned
-- status — a status row would be read as a successful staging and the flow
-- would continue to a booking with no file behind it.
--
-- Archived is deliberately not a rejection condition: `is_archived` is a
-- filing state, an archived patient is still a patient of this clinic, and no
-- existing guard in either function treats it as absence.
--
-- Self-intake is untouched: an unlinked stranger registering themselves still
-- stages with `requested_by_patient_id` null, which is what that column means
-- on a self-intake.
--
-- ===================== THE SHARED-PHONE CORRECTION ========================
--
-- A phone number in this schema is a **contact** number. It is not, and has
-- never been declared to be, an identity: `patients.phone` has no unique
-- constraint (only `idx_patients_phone`, a plain index), and families share a
-- number all the time — a parent booking for a child, a husband for a wife.
-- Two patient records on one number are two people, and the schema is right
-- to permit them.
--
-- Two places did not agree with the schema, and both are corrected here.
--
-- **1. Approval treated a shared number as proof of identity.**
-- `approve_ai_patient_intake` counted the patients on the intake's phone and,
-- at a count of one, *reused that patient's file* if the national id and date
-- of birth agreed — with no name check — and raised
-- `INTAKE_DUPLICATE_REVIEW_REQUIRED` otherwise. Both halves are wrong:
--
--   * the reuse is a merge decided partly by a number two people can share;
--   * the refusal makes a third-party intake **impossible to approve**. A
--     third-party intake only exists on a conversation whose sender is already
--     a linked patient, so the sender's own file is on that number; the count
--     was therefore always at least one, the third party's national id never
--     matched the sender's, and every such approval raised.
--
-- The branch is now decided by proven identity alone — the folded national id
-- — and the phone is not consulted. A national id this clinic already holds
-- goes to a human (unchanged); no match creates the file (now reachable). The
-- one behaviour lost is the silent phone+dob reuse, which was the defect.
--
-- **2. Staging punished a new patient for a shared number.** In the self path,
-- one patient on the sender's number whose details did not match counted as a
-- failed identity verification and, five times over, locked the conversation
-- for thirty minutes. For a genuinely new patient messaging from a relative's
-- phone that is a lockout they can never get past. That case is now
-- recognised for what it is — a different person on a shared number, proved by
-- *this clinic holding no patient at all* under the national id they gave —
-- and staged as the new intake it is, which staff review as they review every
-- intake. The anti-impersonation guard is untouched for the case it was built
-- for: a caller whose national id matches the phone's owner, or matches any
-- other file in the clinic, still goes through exactly today's comparison and
-- exactly today's lockout.
--
-- What is **not** changed by either correction:
--   - the third-party contact-phone fallback stays. When a requester does not
--     give the patient a number of their own, the conversation's verified
--     `participant_address` is the contact number for that patient, because it
--     is the number the clinic can actually reach them on. It is a contact
--     detail and nothing reads it as ownership: the phone-matching block below
--     runs only `if not coalesce(p_for_third_party, false)`, so a third-party
--     intake is never linked to a patient by phone, and approval no longer
--     consults phone at all.
--   - `patients.phone` and `ai_patient_intakes.phone` stay NOT NULL. Nothing
--     in this file relaxes either, and no column is made nullable.
--   - the identity rules themselves: exact folded national id, folded
--     canonical `full_name`, date of birth. Neither display name is an
--     argument to any comparison.
--
-- Security posture, unchanged and restated so a reviewer can check it:
--   - both stay `security definer` with `set search_path to ''`;
--   - the staging function still refuses anything but `service_role`;
--   - the approval function still requires `p_actor_id = auth.uid()` and an
--     admin/manager/receptionist role;
--   - grants are re-applied to match exactly what the functions carry today —
--     staging: `service_role` only (never `authenticated`);
--     approval: `authenticated` and `service_role`.

drop function if exists public.stage_patient_intake_from_conversation(
  uuid, uuid, text, text, date, text, uuid, uuid, boolean, text, text, text
);

create or replace function public.stage_patient_intake_from_conversation(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_full_name text,
  p_national_id text,
  p_date_of_birth date,
  p_email text,
  p_department_id uuid,
  p_doctor_id uuid,
  p_for_third_party boolean default false,
  p_phone text default null::text,
  p_blood_type text default null::text,
  p_full_name_original text default null::text,
  p_full_name_ar text default null::text,
  p_full_name_en text default null::text
)
returns table(status text, intake_id uuid, attempts_remaining integer)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_conversation public.conversations%rowtype;
  v_phone text;
  v_phone_match public.patients%rowtype;
  v_phone_count integer;
  v_id_match_id uuid;
  v_id_count integer;
  v_failures integer;
  v_intake_id uuid;
  v_requested_by uuid;
  v_blood public.blood_type;
  v_original text;
  v_name_ar text;
  v_name_en text;
  -- True when the one patient on this number is demonstrably somebody else:
  -- a relative on a shared phone. Not an identity failure, and not a link.
  v_phone_is_other_person boolean := false;
begin
  attempts_remaining := null;
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  select c.* into v_conversation
  from public.conversations c
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id
    and c.channel = 'whatsapp'::public.message_channel
    and c.status = 'open'::public.conversation_status
  for update;
  if not found then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  if v_conversation.ai_paused_at is not null then
    raise exception 'HUMAN_TAKEOVER_ACTIVE' using errcode = '42501';
  end if;
  if v_conversation.patient_id is not null and not exists (
    select 1 from public.patients p
    where p.id = v_conversation.patient_id
      and p.clinic_id = p_clinic_id
      and not p.is_deleted and p.deleted_at is null
  ) then
    update public.conversations c
    set patient_id = null, patient_link_status = 'unlinked'
    where c.id = p_conversation_id and c.clinic_id = p_clinic_id;
    update public.inbound_messages m
    set patient_id = null
    where m.conversation_id = p_conversation_id
      and m.clinic_id = p_clinic_id
      and m.patient_id = v_conversation.patient_id;
    update public.inbound_message_attachments a
    set patient_id = null
    where a.conversation_id = p_conversation_id
      and a.clinic_id = p_clinic_id
      and a.patient_id = v_conversation.patient_id;
    v_conversation.patient_id := null;
  end if;

  -- ===================================================================
  -- A third-party intake has a requester, or it is not staged.
  -- ===================================================================
  --
  -- `requested_by_patient_id` is the whole accountability record of a
  -- third-party intake: it is the only column that says *who* asked the clinic
  -- to open a file for somebody who never messaged it. The deployed body
  -- derived it from the conversation and accepted a null — so an unlinked
  -- sender answering "for someone else" staged a named third person, with
  -- their national id, their date of birth and a contact number, attributed to
  -- nobody. Nothing in the application prevented it: the booking flow's
  -- beneficiary question runs at `identity: "none"`, and the `register_patient`
  -- tool's only linkage check refuses a linked sender registering *themselves*.
  --
  -- So the requester is a precondition rather than an outcome: the conversation
  -- must be linked to a live patient of *this* clinic. The stale-link repair
  -- immediately above has already unlinked a conversation whose patient was
  -- deleted, so a surviving `patient_id` here is a real, in-clinic, undeleted
  -- file; the existence check is repeated all the same, because an invariant
  -- this column depends on should not be an inference about the block above it.
  --
  -- Archived is deliberately not a rejection: `is_archived` is a filing state,
  -- an archived patient is still a patient of this clinic, and no other guard
  -- in this function treats it as absence.
  --
  -- Self-intake is untouched. An unlinked sender registering *themselves* is
  -- the ordinary stranger path and still stages exactly as before, with
  -- `requested_by_patient_id` null — which is what that column means on a
  -- self-intake. This guard is reached only when `p_for_third_party` is true.
  --
  -- An exception rather than a new `status` value, because the v2 assistant's
  -- `stageIntake` boundary reads only the RPC's error and not the returned
  -- status: a status row would be read as a successful staging and the flow
  -- would continue to a booking with no file behind it.
  if coalesce(p_for_third_party, false) and (
    v_conversation.patient_id is null
    or not exists (
      select 1 from public.patients p
      where p.id = v_conversation.patient_id
        and p.clinic_id = p_clinic_id
        and not p.is_deleted and p.deleted_at is null
    )
  ) then
    raise exception 'THIRD_PARTY_REQUESTER_NOT_LINKED';
  end if;

  if v_conversation.patient_id is not null and not coalesce(p_for_third_party, false) then
    status := 'already_linked'; intake_id := null; return next; return;
  end if;
  if v_conversation.identity_verification_locked_until > clock_timestamp()
     and not coalesce(p_for_third_party, false) then
    status := 'identity_locked'; intake_id := null; attempts_remaining := 0; return next; return;
  end if;

  -- The patient's **contact** number, and only that.
  --
  -- For a third party the number the requester gave is preferred, and the
  -- conversation's verified `participant_address` is the fallback: when a
  -- parent books for a child and gives no separate number, the parent's phone
  -- is genuinely how the clinic reaches that child. It is a contact detail, it
  -- is not ownership, and nothing treats it as ownership — the phone-matching
  -- block below is gated on `not p_for_third_party`, so a third-party intake
  -- is never linked to an existing patient by phone, and
  -- `approve_ai_patient_intake` no longer consults phone at all. Two patient
  -- records sharing one number is a family, which `patients.phone` has always
  -- permitted: it carries a plain index and no unique constraint.
  v_phone := case
    when coalesce(p_for_third_party, false)
      then coalesce(
        nullif(btrim(coalesce(p_phone, '')), ''),
        nullif(btrim(coalesce(v_conversation.participant_address, '')), '')
      )
    else nullif(btrim(coalesce(v_conversation.participant_address, '')), '')
  end;
  if v_phone is null
     or p_full_name is null or char_length(btrim(p_full_name)) not between 2 and 100
     or p_national_id is null or public.fold_national_id(p_national_id) is null
     or char_length(public.fold_national_id(p_national_id)) not between 5 and 32
     or p_date_of_birth not between date '1900-01-01' and current_date
     or p_email is null or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'INVALID_PATIENT_DETAILS';
  end if;
  -- An unreadable blood type is dropped rather than raised: it is an optional
  -- convenience field and refusing the whole intake over it would lose a name,
  -- a national id and a date of birth the patient has already given.
  begin
    v_blood := nullif(btrim(coalesce(p_blood_type, '')), '')::public.blood_type;
  exception when others then
    v_blood := null;
  end;
  v_original := nullif(btrim(coalesce(p_full_name_original, '')), '');
  if v_original is not null and char_length(v_original) not between 2 and 100 then
    v_original := null;
  end if;
  -- The two display names get exactly the treatment the blood type gets: an
  -- optional convenience field is dropped when it is unusable, never raised
  -- over. Losing a display name must not lose an intake.
  v_name_ar := nullif(btrim(coalesce(p_full_name_ar, '')), '');
  if v_name_ar is not null and char_length(v_name_ar) not between 2 and 100 then
    v_name_ar := null;
  end if;
  v_name_en := nullif(btrim(coalesce(p_full_name_en, '')), '');
  if v_name_en is not null and char_length(v_name_en) not between 2 and 100 then
    v_name_en := null;
  end if;
  if not exists (
    select 1 from public.departments d
    where d.id = p_department_id and d.clinic_id = p_clinic_id
      and d.is_active and d.deleted_at is null
  ) or not exists (
    select 1 from public.profiles p
    where p.id = p_doctor_id and p.clinic_id = p_clinic_id
      and p.department_id = p_department_id
      and p.role = 'doctor'::public.user_role
      and p.is_active and not p.is_deleted and p.deleted_at is null
  ) then raise exception 'INVALID_INTAKE_ASSIGNMENT'; end if;

  select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
    into v_id_match_id, v_id_count
  from public.patients p
  where p.clinic_id = p_clinic_id and not p.is_deleted and p.deleted_at is null
    and public.fold_national_id(p.national_id) = public.fold_national_id(p_national_id);

  if not coalesce(p_for_third_party, false) then
    -- ===================================================================
    -- Identity is the folded national id. The phone is a second factor.
    -- ===================================================================
    --
    -- The deployed body decided this block from `count(patients on this
    -- number)`, and every branch of that was a phone-uniqueness assumption:
    -- two patients on one number returned `duplicate_ambiguous`, and one
    -- patient on one number whose details did not match counted as a failed
    -- identity verification — five of which lock the conversation for half an
    -- hour. Families share a number, so both refused a legitimate caller for
    -- somebody else's record: a son messaging from his father's phone could
    -- never register, and once a family had two files on a number nobody on it
    -- could ever be linked again, including the number's own owner.
    --
    -- So identity chooses the file, and the phone is only ever asked one
    -- question afterwards: *is this the registered number of the file the
    -- national id already picked?* That keeps the protection the phone was
    -- really providing — an automatic link, which hands a sender access to a
    -- patient's record, still requires the conversation's verified number to be
    -- that patient's own — while making how many relatives share the number
    -- irrelevant, which is what it always should have been.
    select count(*)::integer into v_phone_count
    from public.patients p
    where p.clinic_id = p_clinic_id and p.phone = v_phone
      and not p.is_deleted and p.deleted_at is null;

    if v_id_count = 1 then
      select p.* into v_phone_match from public.patients p
      where p.id = v_id_match_id and p.clinic_id = p_clinic_id
        and not p.is_deleted and p.deleted_at is null;

      -- A real identity conflict: the clinic holds this national id, and the
      -- name or the date of birth given with it is not the one on that file.
      -- Unchanged, and deliberately so — the comparison is against `full_name`,
      -- folded. The two display names are not part of it and must never be;
      -- see the "Not identity" note at the top of this file.
      if v_phone_match.date_of_birth is distinct from p_date_of_birth
         or public.fold_patient_name(v_phone_match.full_name)
            is distinct from public.fold_patient_name(p_full_name) then
        update public.conversations c
        set identity_verification_failures = least(c.identity_verification_failures + 1, 5),
            identity_verification_locked_until = case
              when c.identity_verification_failures + 1 >= 5
                then clock_timestamp() + interval '30 minutes'
              else c.identity_verification_locked_until end
        where c.id = p_conversation_id and c.clinic_id = p_clinic_id
        returning c.identity_verification_failures into v_failures;
        status := case when v_failures >= 5 then 'identity_locked' else 'identity_mismatch' end;
        intake_id := null; attempts_remaining := greatest(5 - v_failures, 0);
        return next; return;
      end if;

      -- Proven, and from that patient's own registered number. However many
      -- relatives also use it.
      if v_phone_match.phone is not distinct from v_phone then
        update public.conversations c
        set patient_id = v_phone_match.id, patient_link_status = 'automatic'
        where c.id = p_conversation_id and c.clinic_id = p_clinic_id;
        update public.conversations c
        set identity_verified_at = clock_timestamp(), identity_verification_failures = 0,
            identity_verification_locked_until = null
        where c.id = p_conversation_id and c.clinic_id = p_clinic_id;
        update public.inbound_messages m set patient_id = v_phone_match.id
        where m.conversation_id = p_conversation_id and m.clinic_id = p_clinic_id and m.patient_id is null;
        update public.inbound_message_attachments a set patient_id = v_phone_match.id
        where a.conversation_id = p_conversation_id and a.clinic_id = p_clinic_id and a.patient_id is null;
        update public.conversations c
        set ai_collected_data = coalesce(c.ai_collected_data, '{}'::jsonb)
          || jsonb_build_object(
            'department_id', p_department_id,
            'doctor_id', p_doctor_id
          )
        where c.id = p_conversation_id and c.clinic_id = p_clinic_id;
        status := 'linked_existing'; intake_id := null; return next; return;
      end if;

      -- Proven identity, but not from that file's own number, so there is no
      -- second factor and nothing is linked automatically. Falls through to
      -- `duplicate_review` below, which is a person at the clinic — exactly
      -- where this case went before.

    elsif v_id_count = 0 and v_phone_count > 0 and exists (
      select 1 from public.patients p
      where p.clinic_id = p_clinic_id and p.phone = v_phone
        and not p.is_deleted and p.deleted_at is null
        and public.fold_patient_name(p.full_name)
            = public.fold_patient_name(p_full_name)
    ) then
      -- The impersonation shape, and the reason the lockout exists: somebody on
      -- this number already carries this name, and the national id offered
      -- alongside it belongs to nobody at this clinic. A relative registering
      -- themselves gives their *own* name and does not reach this branch.
      v_phone_is_other_person := false;
      update public.conversations c
      set identity_verification_failures = least(c.identity_verification_failures + 1, 5),
          identity_verification_locked_until = case
            when c.identity_verification_failures + 1 >= 5
              then clock_timestamp() + interval '30 minutes'
            else c.identity_verification_locked_until end
      where c.id = p_conversation_id and c.clinic_id = p_clinic_id
      returning c.identity_verification_failures into v_failures;
      status := case when v_failures >= 5 then 'identity_locked' else 'identity_mismatch' end;
      intake_id := null; attempts_remaining := greatest(5 - v_failures, 0);
      return next; return;
    else
      -- Nobody here holds the national id given, and nobody on this number
      -- carries the name given: a different person on a shared phone, which is
      -- a new patient and is staged as one. Recorded so the audit trail says
      -- so rather than leaving it to be inferred.
      v_phone_is_other_person := v_phone_count > 0;
    end if;
  end if;

  if v_id_count > 0 then
    status := 'duplicate_review'; intake_id := null; return next; return;
  end if;

  v_requested_by := case
    when coalesce(p_for_third_party, false) then v_conversation.patient_id
    else null
  end;
  -- Unreachable given the guard above, and asserted rather than trusted: no
  -- later edit to this function may reach the insert with a third-party intake
  -- that has no requester.
  if coalesce(p_for_third_party, false) and v_requested_by is null then
    raise exception 'THIRD_PARTY_REQUESTER_NOT_LINKED';
  end if;

  insert into public.ai_patient_intakes (
    clinic_id, conversation_id, full_name, date_of_birth, phone, email,
    national_id, department_id, doctor_id, is_third_party, requested_by_patient_id,
    blood_type, full_name_original, full_name_ar, full_name_en
  ) values (
    p_clinic_id, p_conversation_id, btrim(p_full_name), p_date_of_birth, v_phone,
    lower(btrim(p_email)), btrim(p_national_id),
    p_department_id, p_doctor_id, coalesce(p_for_third_party, false), v_requested_by,
    v_blood, v_original, v_name_ar, v_name_en
  )
  on conflict (clinic_id, conversation_id) do update
    set full_name = excluded.full_name,
        date_of_birth = excluded.date_of_birth,
        phone = excluded.phone,
        email = excluded.email,
        national_id = excluded.national_id,
        department_id = excluded.department_id,
        doctor_id = excluded.doctor_id,
        is_third_party = excluded.is_third_party,
        requested_by_patient_id = excluded.requested_by_patient_id,
        -- A later call that carries no blood type must not erase one an earlier
        -- turn already collected.
        blood_type = coalesce(excluded.blood_type, ai_patient_intakes.blood_type),
        full_name_original = coalesce(
          excluded.full_name_original, ai_patient_intakes.full_name_original
        ),
        -- Same rule, same reason: a turn that re-stages without a display name
        -- must not erase one an earlier turn collected.
        full_name_ar = coalesce(excluded.full_name_ar, ai_patient_intakes.full_name_ar),
        full_name_en = coalesce(excluded.full_name_en, ai_patient_intakes.full_name_en),
        updated_at = clock_timestamp()
    where ai_patient_intakes.review_status = 'pending_review'
  returning id into v_intake_id;
  if v_intake_id is null then
    status := 'already_reviewed'; intake_id := null; return next; return;
  end if;

  insert into public.audit_logs (
    clinic_id, action, table_name, record_id, actor_type, source, new_data
  ) values (
    p_clinic_id, 'AI_PATIENT_INTAKE_STAGED', 'ai_patient_intakes', v_intake_id,
    'ai', 'ai_assistant', jsonb_build_object(
      'review_status', 'pending_review', 'department_id', p_department_id,
      'doctor_id', p_doctor_id, 'conversation_id', p_conversation_id,
      'is_third_party', coalesce(p_for_third_party, false),
      'blood_type_supplied', v_blood is not null,
      -- Visible in the trail rather than inferred from it: this intake was
      -- staged past a number an existing patient also uses.
      'shared_contact_phone', v_phone_is_other_person
    )
  );
  update public.conversations c
  set ai_collected_data = coalesce(c.ai_collected_data, '{}'::jsonb)
    || jsonb_build_object(
      'department_id', p_department_id,
      'doctor_id', p_doctor_id
    )
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id;
  status := 'staged'; intake_id := v_intake_id; return next;
end;
$function$;

-- Exactly the grants the dropped function carried: service_role only. The
-- assistant reaches this through the admin client and no signed-in user may
-- call it directly.
revoke all on function public.stage_patient_intake_from_conversation(
  uuid, uuid, text, text, date, text, uuid, uuid, boolean, text, text, text, text, text
) from public;
grant execute on function public.stage_patient_intake_from_conversation(
  uuid, uuid, text, text, date, text, uuid, uuid, boolean, text, text, text, text, text
) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Approval carries the two display names onto the file it creates
-- ---------------------------------------------------------------------------
--
-- Signature unchanged, every guard unchanged. Two differences from the
-- deployed body, and only two: the two extra columns in the `insert into
-- public.patients`, and the shared-phone correction described in section 6.
--
-- In particular the `matched_patient_id` branch is untouched: an intake that
-- continues an existing file writes nothing to it, because overwriting a name
-- a person at the clinic curated with one a conversation produced is not
-- something an approval should do silently. Neither display name reaches a
-- comparison anywhere in this function.

create or replace function public.approve_ai_patient_intake(
  p_intake_id uuid,
  p_actor_id uuid
)
returns table(patient_id uuid, appointment_id uuid, already_processed boolean)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_intake public.ai_patient_intakes%rowtype;
  v_conversation public.conversations%rowtype;
  v_matched public.patients%rowtype;
  v_id_count integer;
  v_patient_id uuid;
  v_request public.ai_appointment_requests%rowtype;
  v_appointment_id uuid;
  v_next integer;
  v_file text;
  v_previous_approval_id text;
  v_previous_approval_actor text;
  v_has_active_patient_booking boolean := false;
  -- Who this intake is *for*, and who asked for it. See the ownership audit in
  -- section 9.
  v_third_party boolean := false;
  v_requester_linked boolean := false;
begin
  if p_actor_id is distinct from auth.uid()
     or coalesce(public.auth_role()::text, '') not in ('admin', 'manager', 'receptionist')
  then raise exception 'INTAKE_REVIEW_FORBIDDEN' using errcode = '42501'; end if;
  select i.* into v_intake from public.ai_patient_intakes i
  where i.id = p_intake_id and i.clinic_id = public.auth_clinic_id() for update;
  if not found then raise exception 'INTAKE_NOT_FOUND'; end if;
  if v_intake.review_status = 'approved' then
    select r.appointment_id into v_appointment_id
    from public.ai_appointment_requests r
    where r.intake_id = v_intake.id and r.clinic_id = v_intake.clinic_id
      and r.status = 'linked' limit 1;
    return query select v_intake.approved_patient_id, v_appointment_id, true;
    return;
  end if;
  if v_intake.review_status <> 'pending_review' then
    raise exception 'INTAKE_ALREADY_REVIEWED';
  end if;
  if not exists (
    select 1 from public.departments d
    where d.id = v_intake.department_id and d.clinic_id = v_intake.clinic_id
      and d.is_active and d.deleted_at is null
  ) or not exists (
    select 1 from public.profiles p
    where p.id = v_intake.doctor_id and p.clinic_id = v_intake.clinic_id
      and p.department_id = v_intake.department_id
      and p.role = 'doctor'::public.user_role
      and p.is_active and not p.is_deleted and p.deleted_at is null
  ) then raise exception 'INTAKE_ASSIGNMENT_STALE'; end if;

  select c.* into v_conversation from public.conversations c
  where c.id = v_intake.conversation_id and c.clinic_id = v_intake.clinic_id
  for update;
  if not found then raise exception 'CONVERSATION_NOT_FOUND'; end if;

  -- The beneficiary is not the requester, and this approval writes for both.
  --
  -- `v_patient_id`, resolved just below, is the *beneficiary* — the person the
  -- intake describes. On a self-intake that is also the sender, and every write
  -- in this function may use it. On a third-party intake it is somebody who has
  -- never messaged this clinic, and the sender remains the patient the
  -- conversation is linked to. Section 9 classifies every write; these two
  -- flags are what the classification is read through.
  --
  -- `v_requester_linked` is deliberately not "the intake has a requester": it
  -- is "the conversation is *still* linked to that requester". A third-party
  -- intake staged before the requester invariant existed carries a null
  -- requester, and a conversation can be re-linked between staging and review.
  -- In both cases the booking's provenance no longer holds and section 9's
  -- database guard would refuse the appointment; the request is dismissed
  -- instead, which is what this function already does to a booking it cannot
  -- honour. The patient file is still created or reused either way, because it
  -- is the review's actual subject.
  v_third_party := coalesce(v_intake.is_third_party, false);
  v_requester_linked := v_third_party
    and v_intake.requested_by_patient_id is not null
    and v_conversation.patient_id = v_intake.requested_by_patient_id;

  -- Item #3 — an intake that already points at a file this clinic holds.
  -- `matched_patient_id` is the server's finding from
  -- `find_clinic_patient_by_identity`, written when the intake was staged. It
  -- is a hint, never an authority, and it is re-proved here from scratch under
  -- this transaction's lock with exactly the rules discovery used.
  if v_intake.matched_patient_id is not null then
    select p.* into v_matched from public.patients p
    where p.id = v_intake.matched_patient_id
      and p.clinic_id = v_intake.clinic_id
      and not p.is_deleted
      and p.deleted_at is null;
    if not found then
      raise exception 'INTAKE_MATCHED_PATIENT_REVIEW_REQUIRED';
    end if;

    if v_intake.national_id_folded is null
       or char_length(v_intake.national_id_folded) not between 5 and 32
       or public.fold_national_id(v_matched.national_id)
            is distinct from v_intake.national_id_folded
       or public.fold_patient_name(v_matched.full_name)
            is distinct from public.fold_patient_name(v_intake.full_name)
    then
      raise exception 'INTAKE_MATCHED_PATIENT_REVIEW_REQUIRED';
    end if;

    select count(*)::integer into v_id_count from public.patients p
    where p.clinic_id = v_intake.clinic_id
      and public.fold_national_id(p.national_id) = v_intake.national_id_folded
      and not p.is_deleted and p.deleted_at is null;
    if v_id_count <> 1 then
      raise exception 'INTAKE_MATCHED_PATIENT_REVIEW_REQUIRED';
    end if;

    -- Proved. Reuse the existing file; create nothing, and change nothing
    -- about the name already on it.
    v_patient_id := v_matched.id;
  else
    -- Proven identity, and nothing else.
    --
    -- This branch used to count the patients sharing the intake's phone and
    -- decide from that: at a count of one it reused that patient's file when
    -- the national id and date of birth agreed — no name check — and raised
    -- otherwise. Phone is a contact detail that families share, so both halves
    -- were wrong. The reuse was a record merge decided partly by a number two
    -- people can hold, and the refusal made a third-party intake impossible to
    -- approve at all: a third-party intake only exists on a conversation whose
    -- sender is already a linked patient, so the sender's own file always sat
    -- on that number, the third party's national id never matched the
    -- sender's, and the raise was unconditional.
    --
    -- The folded national id is the identity, as it is everywhere else in this
    -- file. `phone` is not read here, and a shared number therefore neither
    -- merges two people nor blocks a legitimate new file. A national id this
    -- clinic already holds still goes to a human — unchanged, and the reason
    -- the `matched_patient_id` branch above exists for the case that *has*
    -- been proved.
    select count(*)::integer into v_id_count from public.patients p
    where p.clinic_id = v_intake.clinic_id
      and public.fold_national_id(p.national_id) = v_intake.national_id_folded
      and not p.is_deleted and p.deleted_at is null;
    if v_id_count > 0 then
      raise exception 'INTAKE_DUPLICATE_REVIEW_REQUIRED';
    else
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_intake.clinic_id::text || ':patient-file-number', 0)
      );
      select coalesce(max((substring(p.file_number from 4))::integer), 0) + 1 into v_next
      from public.patients p
      where p.clinic_id = v_intake.clinic_id and p.file_number ~ '^CF-\d+$';
      v_file := 'CF-' || lpad(v_next::text, 4, '0');
      insert into public.patients (
        clinic_id, full_name, national_id, date_of_birth, phone, email,
        department_id, assigned_doctor_id, file_number, created_by, blood_type,
        full_name_ar, full_name_en
      ) values (
        v_intake.clinic_id, v_intake.full_name, v_intake.national_id,
        v_intake.date_of_birth, v_intake.phone, v_intake.email,
        v_intake.department_id, v_intake.doctor_id, v_file, p_actor_id, v_intake.blood_type,
        v_intake.full_name_ar, v_intake.full_name_en
      ) returning id into v_patient_id;
    end if;
  end if;

  -- The caller remains the real authenticated staff member. These local,
  -- intake-bound markers authorize only the guarded writes performed by this
  -- reviewed transaction.
  v_previous_approval_id := current_setting('clinicflow.ai_intake_approval_id', true);
  v_previous_approval_actor := current_setting('clinicflow.ai_intake_approval_actor', true);
  perform pg_catalog.set_config(
    'clinicflow.ai_intake_approval_id', v_intake.id::text, true
  );
  perform pg_catalog.set_config(
    'clinicflow.ai_intake_approval_actor', p_actor_id::text, true
  );

  -- ===================================================================
  -- Conversation ownership belongs to the sender, not to the beneficiary.
  -- ===================================================================
  --
  -- Every write in this block is *requester*-scoped: it says who this WhatsApp
  -- thread belongs to, who its messages belong to, and whose identity the
  -- clinic has verified on it. On a self-intake the beneficiary is the sender
  -- and all four are correct with `v_patient_id`; that path is unchanged.
  --
  -- On a third-party intake they are all wrong. A father linked to this thread
  -- registers his daughter; approving her file must not move his conversation
  -- onto her record, must not restate his verification state as hers, and must
  -- not hand her the messages and attachments *he* sent. The clinic would lose
  -- the only record of who it is actually talking to, `requested_by_patient_id`
  -- would name a patient the thread no longer belongs to, and the boundary the
  -- assistant maintains between the sender and the person the appointment is
  -- for (`lib/ai/booking-beneficiary.ts`) would be erased at review time.
  --
  -- So on a third-party approval this block does nothing at all. The thread
  -- keeps its patient, its `patient_link_status`, its `identity_verified_at`,
  -- its `identity_verification_failures` and its
  -- `identity_verification_locked_until` — none of which is a statement about
  -- the beneficiary, and none of which an approval of somebody else's file has
  -- any standing to rewrite. The messages and attachments already carry the
  -- sender, or carry nothing; a null one is *his* unattributed message, and
  -- attributing it to her would be a fabrication.
  if not v_third_party then
    update public.conversations c
    set patient_id = v_patient_id, patient_link_status = 'manual'
    where c.id = v_intake.conversation_id and c.clinic_id = v_intake.clinic_id;
    update public.conversations c
    set identity_verified_at = clock_timestamp(), identity_verification_failures = 0,
        identity_verification_locked_until = null
    where c.id = v_intake.conversation_id and c.clinic_id = v_intake.clinic_id;
    update public.inbound_messages m set patient_id = v_patient_id
    where m.conversation_id = v_intake.conversation_id
      and m.clinic_id = v_intake.clinic_id and m.patient_id is null;
    update public.inbound_message_attachments a set patient_id = v_patient_id
    where a.conversation_id = v_intake.conversation_id
      and a.clinic_id = v_intake.clinic_id and a.patient_id is null;
  end if;

  select r.* into v_request from public.ai_appointment_requests r
  where r.intake_id = v_intake.id and r.clinic_id = v_intake.clinic_id
    and r.status = 'pending' for update;
  if found then
    if v_request.expires_at <= clock_timestamp()
       or not public.ai_requested_slot_is_available(
         v_request.clinic_id, v_request.doctor_id,
         v_request.scheduled_at, v_request.duration_minutes
       ) then
      update public.ai_appointment_requests
      set status = 'expired', updated_at = clock_timestamp()
      where id = v_request.id;
    elsif v_third_party and not v_requester_linked then
      -- A third-party booking whose requester is not (or is no longer) the
      -- patient this conversation belongs to. The file is approved; the booking
      -- is not attributable, and section 9's guard would refuse it. Dismissed
      -- exactly as an unhonourable booking already is, and staff book manually.
      update public.ai_appointment_requests
      set status = 'dismissed', updated_at = clock_timestamp()
      where id = v_request.id;
    else
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'p5a-ai-booking:' || v_request.clinic_id::text, 0
        )
      );
      select exists (
        select 1 from public.appointments a
        where a.clinic_id = v_request.clinic_id
          and a.patient_id = v_patient_id
          and a.status = 'pending'::public.appointment_status
          and a.deleted_at is null and a.expires_at > clock_timestamp()
          and (
            a.ai_patient_conversation_id is not null
            or a.ai_workflow_run_id is not null
            or a.ai_action_receipt_id is not null
          )
      ) into v_has_active_patient_booking;

      if v_has_active_patient_booking then
        update public.ai_appointment_requests
        set status = 'dismissed', updated_at = clock_timestamp()
        where id = v_request.id;
      else
        begin
          insert into public.appointments (
            clinic_id, patient_id, doctor_id, department_id, service_id,
            scheduled_at, duration_minutes, status, created_by,
            ai_patient_conversation_id
          ) values (
            v_request.clinic_id, v_patient_id, v_request.doctor_id,
            v_request.department_id, v_request.service_id, v_request.scheduled_at,
            v_request.duration_minutes, 'pending'::public.appointment_status, null,
            v_request.conversation_id
          ) returning id into v_appointment_id;
          update public.ai_appointment_requests
          set status = 'linked', appointment_id = v_appointment_id,
              updated_at = clock_timestamp()
          where id = v_request.id;
        exception
          when unique_violation or exclusion_violation then
            v_appointment_id := null;
            update public.ai_appointment_requests
            set status = 'dismissed', updated_at = clock_timestamp()
            where id = v_request.id;
        end;
      end if;
    end if;
  end if;

  perform pg_catalog.set_config(
    'clinicflow.ai_intake_approval_id',
    coalesce(v_previous_approval_id, ''),
    true
  );
  perform pg_catalog.set_config(
    'clinicflow.ai_intake_approval_actor',
    coalesce(v_previous_approval_actor, ''),
    true
  );

  update public.ai_patient_intakes
  set review_status = 'approved', reviewed_at = clock_timestamp(),
      reviewed_by = p_actor_id, approved_patient_id = v_patient_id,
      updated_at = clock_timestamp()
  where id = v_intake.id;
  insert into public.audit_logs (
    clinic_id, actor_id, actor_type, source, action, table_name, record_id, new_data
  ) values (
    v_intake.clinic_id, p_actor_id, 'user', 'ai_assistant_review',
    'AI_PATIENT_INTAKE_APPROVED', 'ai_patient_intakes', v_intake.id,
    jsonb_build_object(
      'patient_id', v_patient_id, 'appointment_id', v_appointment_id,
      'is_third_party', v_third_party,
      'requested_by_patient_id', v_intake.requested_by_patient_id
    )
  );
  return query select v_patient_id, v_appointment_id, false;
end;
$function$;

-- Restated to match exactly what the function carries today.
revoke all on function public.approve_ai_patient_intake(uuid, uuid) from public;
grant execute on function public.approve_ai_patient_intake(uuid, uuid) to authenticated;
grant execute on function public.approve_ai_patient_intake(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 8. The other third-party writer keeps the same invariant
-- ---------------------------------------------------------------------------
--
-- `stage_matched_third_party_intake` is the sibling staging path from
-- `20260911120000_existing_patient_identity_discovery.sql`: a beneficiary who
-- already has a file here is pointed at that file instead of being proposed as
-- a duplicate. Every row it writes carries `is_third_party = true`, so it is
-- the second — and, per the audit in this migration's companion review, the
-- last — path capable of producing a third-party intake with no requester.
--
-- Three differences from the deployed body, and only three:
--
--   1. the requester guard, identical in rule and in message to the one in
--      section 6. It carries its own existence check rather than relying on a
--      repair: unlike `stage_patient_intake_from_conversation`, this function
--      has never unlinked a conversation whose patient was deleted, so a
--      `patient_id` here is not otherwise known to be live.
--   2. `requested_by_patient_id` is added to the `on conflict do update` set.
--      The deployed body sets `is_third_party = true` on conflict but leaves
--      the requester column alone, so a self-intake already staged on this
--      conversation would be *flipped* to third-party while keeping its null
--      requester — the invariant defeated by an update rather than an insert.
--   3. the assertion before the insert, so no later edit can reach the write
--      with a third-party row and no requester.
--
-- Nothing else moves: the service-role gate, the conversation lock, the
-- human-takeover refusal, the re-proved identity through
-- `find_clinic_patient_by_identity`, the `no_match` return, the assignment
-- validation, the clinic's-own-details rule, the audit row, the
-- `already_reviewed` return and the `staged_existing` status are the deployed
-- ones.

create or replace function public.stage_matched_third_party_intake(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_full_name text,
  p_national_id text,
  p_phone text,
  p_department_id uuid,
  p_doctor_id uuid
)
returns table (status text, intake_id uuid, matched_patient_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_patient public.patients%rowtype;
  v_match uuid;
  v_intake_id uuid;
  v_requested_by uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select c.* into v_conversation
  from public.conversations c
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id
    and c.channel = 'whatsapp'::public.message_channel
    and c.status = 'open'::public.conversation_status
  for update;
  if not found then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  if v_conversation.ai_paused_at is not null then
    raise exception 'HUMAN_TAKEOVER_ACTIVE' using errcode = '42501';
  end if;

  -- Every row this function writes is a third-party intake, so the requester
  -- is a precondition of calling it at all — checked before the identity is
  -- proved, because an unattributable request is refused whether or not the
  -- beneficiary turns out to have a file here, and proving the identity first
  -- would let a caller with no standing use `no_match` as an oracle for
  -- whether a given national id is registered at this clinic.
  --
  -- Archived is not absence; deleted is. Same rule as section 6.
  select p.id into v_requested_by
  from public.patients p
  where p.id = v_conversation.patient_id
    and p.clinic_id = p_clinic_id
    and not p.is_deleted and p.deleted_at is null;
  if v_requested_by is null then
    raise exception 'THIRD_PARTY_REQUESTER_NOT_LINKED';
  end if;

  -- The identity is re-proved here, from the same function and the same rule.
  -- An argument saying "this is patient X" would be a way to file an
  -- appointment onto any record whose uuid a caller could name.
  select f.patient_id into v_match
  from public.find_clinic_patient_by_identity(p_clinic_id, p_national_id, p_full_name) f
  limit 1;
  if v_match is null then
    status := 'no_match'; intake_id := null; matched_patient_id := null;
    return next; return;
  end if;
  select p.* into v_patient from public.patients p where p.id = v_match;

  if not exists (
    select 1 from public.departments d
    where d.id = p_department_id and d.clinic_id = p_clinic_id
      and d.is_active and d.deleted_at is null
  ) or not exists (
    select 1 from public.profiles pr
    where pr.id = p_doctor_id and pr.clinic_id = p_clinic_id
      and pr.department_id = p_department_id
      and pr.role = 'doctor'::public.user_role
      and pr.is_active and not pr.is_deleted and pr.deleted_at is null
  ) then raise exception 'INVALID_INTAKE_ASSIGNMENT'; end if;

  -- Unreachable given the guard above, and asserted rather than trusted.
  if v_requested_by is null then
    raise exception 'THIRD_PARTY_REQUESTER_NOT_LINKED';
  end if;

  insert into public.ai_patient_intakes (
    clinic_id, conversation_id, full_name, date_of_birth, phone, email,
    national_id, department_id, doctor_id, is_third_party, matched_patient_id,
    requested_by_patient_id
  ) values (
    p_clinic_id, p_conversation_id, v_patient.full_name, v_patient.date_of_birth,
    coalesce(nullif(btrim(coalesce(p_phone, '')), ''), v_patient.phone),
    v_patient.email, v_patient.national_id, p_department_id, p_doctor_id, true, v_match,
    v_requested_by
  )
  on conflict (clinic_id, conversation_id) do update
    set full_name = excluded.full_name,
        date_of_birth = excluded.date_of_birth,
        email = excluded.email,
        national_id = excluded.national_id,
        department_id = excluded.department_id,
        doctor_id = excluded.doctor_id,
        is_third_party = true,
        matched_patient_id = excluded.matched_patient_id,
        -- Written on conflict too: a row being turned into a third-party
        -- intake must gain the requester in the same statement, or an earlier
        -- self-intake on this conversation would keep its null one.
        requested_by_patient_id = excluded.requested_by_patient_id,
        updated_at = clock_timestamp()
    where ai_patient_intakes.review_status = 'pending_review'
  returning id into v_intake_id;
  if v_intake_id is null then
    status := 'already_reviewed'; intake_id := null; matched_patient_id := v_match;
    return next; return;
  end if;

  -- The file's own details are what is filed, not what the sender typed. The
  -- sender proved the id and the name; they are not the source of truth for the
  -- beneficiary's date of birth or email, and copying their version over the
  -- clinic's would let a third party edit somebody else's record by proxy.
  insert into public.audit_logs (
    clinic_id, action, table_name, record_id, actor_type, source, new_data
  ) values (
    p_clinic_id, 'AI_PATIENT_INTAKE_MATCHED_EXISTING', 'ai_patient_intakes', v_intake_id,
    'ai', 'ai_assistant', jsonb_build_object(
      'review_status', 'pending_review', 'department_id', p_department_id,
      'doctor_id', p_doctor_id, 'conversation_id', p_conversation_id,
      'matched_patient_id', v_match
    )
  );
  update public.conversations c
  set ai_collected_data = coalesce(c.ai_collected_data, '{}'::jsonb)
    || jsonb_build_object('department_id', p_department_id, 'doctor_id', p_doctor_id)
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id;

  status := 'staged_existing'; intake_id := v_intake_id; matched_patient_id := v_match;
  return next;
end;
$$;

comment on function public.stage_matched_third_party_intake(uuid, uuid, text, text, text, uuid, uuid) is
  'Item #3 — stages a third-party intake that points at an existing patient file instead of proposing a duplicate. Re-proves the identity itself through find_clinic_patient_by_identity; a caller cannot name a patient id. Requires the conversation to be linked to a live patient of this clinic, which becomes requested_by_patient_id. Files the clinic''s own stored details, never the sender''s version of them.';

-- Restated to match exactly what the function carries today.
revoke all on function public.stage_matched_third_party_intake(uuid, uuid, text, text, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.stage_matched_third_party_intake(uuid, uuid, text, text, text, uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 9. The ownership audit: which writes are the beneficiary's, and which the
--    requester's
-- ---------------------------------------------------------------------------
--
-- Sections 6-8 established that a third-party intake names the patient who
-- asked for it. This section is the other half of that boundary: **approval
-- must not hand the requester's conversation to the beneficiary.**
--
-- The deployed `approve_ai_patient_intake` writes `v_patient_id` — the
-- beneficiary — into eight places, unconditionally. Classified:
--
--   beneficiary-scoped (unchanged, still B)
--     1. the `insert into public.patients` that creates the new file;
--     2. `v_matched.id`, the existing file a proved match reuses;
--     3. the active-pending-booking probe, which is a cap on *B's* bookings;
--     4. `insert into public.appointments (... patient_id ...)` — the
--        appointment is for the beneficiary, and that is the whole point of a
--        third-party booking;
--     5. `ai_patient_intakes.approved_patient_id`;
--     6. the returned `patient_id`.
--
--   requester-scoped (now left alone on a third-party approval)
--     7. `conversations.patient_id` / `patient_link_status` — who this thread
--        belongs to. It belongs to the sender, who did not stop being the
--        sender by asking for somebody else;
--     8. `conversations.identity_verified_at`,
--        `identity_verification_failures`, `identity_verification_locked_until`
--        — the clinic's verification state *for the sender*. An approval of a
--        different person's file proves nothing about him, and resetting his
--        failure counter and lockout on the strength of it would clear an
--        anti-impersonation state that was recorded about him. Note the pair is
--        also correct as a no-op: a third-party intake can only be staged on a
--        conversation already linked to a live patient, which is a conversation
--        that has already passed identity;
--     9. `inbound_messages.patient_id` and
--        `inbound_message_attachments.patient_id`, filled in where they were
--        null. Those are the *sender's* messages and the sender's media; a null
--        one is an unattributed message of his, not an unattributed message of
--        hers.
--
-- ======================= WHY THE TRIGGER MOVES TOO =========================
--
-- `enforce_ai_pending_booking_policy` refuses any AI-provenance pending
-- appointment whose `patient_id` differs from
-- `conversations.patient_id`. That rule is the reason approval switched the
-- conversation in the first place: with the switch removed, every third-party
-- booking would raise `AI_BOOKING_CONVERSATION_IDENTITY_MISMATCH`, and the
-- boundary above would be bought by making third-party booking impossible.
--
-- So the rule gains exactly one exemption, and it is proved from stored rows
-- rather than asserted by the transaction: this clinic holds a third-party
-- intake **on this conversation** whose `requested_by_patient_id` is the
-- patient the conversation is linked to *right now*, and whose beneficiary is
-- the appointment's patient. Father A's thread may carry a pending booking for
-- daughter B only because the clinic's own intake says A asked for B.
--
-- "Whose beneficiary" is two clauses, because the appointment is inserted
-- *during* the review, before the intake can name the beneficiary at all:
-- `ai_patient_intakes_review_shape_check` forbids an `approved_patient_id` on a
-- `pending_review` row, so nothing may pre-write it.
--
--   * **After the review** — `approved_patient_id = <the appointment's
--     patient>`. Durable, written by no function but the staff-gated approval,
--     and the clause that keeps working when the trigger runs again on a later
--     edit of that same pending appointment.
--
--   * **During the review** — the approval of *this exact intake* must be
--     running in this transaction, proved by the existing capability check
--     `ai_intake_approval_context_matches` plus `i.id` equal to the marked
--     intake. The folded national id sits inside that branch as an identity
--     consistency check on what the transaction is doing; it is **not** an
--     authorization condition of its own. A pending intake and a matching
--     national id, with no approval in flight, authorise nothing at all —
--     otherwise the assistant's own service-role booking path could file an
--     appointment for a beneficiary on the requester's thread before any human
--     had reviewed anything.
--
-- A rejected or dismissed intake satisfies neither clause: it has a null
-- `approved_patient_id`, and the capability check requires `pending_review`.
--
-- The exemption is stated as data rather than as approval-transaction context
-- deliberately. The trigger also runs on later UPDATEs of that same pending
-- row — a reschedule keeps it pending — and a context-bound exemption would
-- pass the insert and then refuse every subsequent edit of the row it just
-- allowed.
--
-- Everything else in the trigger is restated byte-for-byte from
-- `20260822190000_ai_patient_intake_booking_followup.sql`: the minimum notice,
-- the no-op UPDATE short-circuit, the clinic lookup, the null-conversation and
-- `created_by` refusals, the action-receipt check, the advisory lock, the
-- expiry, the patient cap and the slot cap. The `create trigger` is not
-- re-issued; the trigger already points at this function by name.

create or replace function public.ai_conversation_booking_beneficiary_matches(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_patient_id uuid
)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_marked_intake uuid;
  v_in_approval boolean := false;
begin
  if p_clinic_id is null or p_conversation_id is null or p_patient_id is null then
    return false;
  end if;

  -- The transaction-bound branch is resolved before a row is read, so stored
  -- data can never be the only thing consulted for it.
  --
  -- `ai_intake_approval_context_matches` is the existing capability check and
  -- carries the whole of the authorization: the local markers must be set, the
  -- actor marker must equal `auth.uid()`, the executing user must be the owner
  -- of `approve_ai_patient_intake` (so the statement is running *inside* that
  -- function, not merely in a session that called `set_config`), the marked
  -- intake must still be `pending_review` on this clinic and this conversation,
  -- and the actor must be a live admin/manager/receptionist of that clinic.
  -- Outside a real approval it is false and the branch below is unreachable.
  --
  -- The marker is read a second time here only to pin the *row*: the capability
  -- check proves an approval of some intake on this conversation is in flight,
  -- and `i.id = v_marked_intake` proves it is this one. A second intake on the
  -- same thread, or this intake reached through another thread, matches nothing.
  begin
    v_marked_intake := nullif(
      pg_catalog.current_setting('clinicflow.ai_intake_approval_id', true), ''
    )::uuid;
  exception when invalid_text_representation then
    v_marked_intake := null;
  end;
  if v_marked_intake is not null then
    v_in_approval := public.ai_intake_approval_context_matches(
      p_clinic_id, p_conversation_id
    );
  end if;

  return exists (
    select 1
    from public.ai_patient_intakes i
    join public.conversations c
      on c.id = i.conversation_id and c.clinic_id = i.clinic_id
    where i.clinic_id = p_clinic_id
      and i.conversation_id = p_conversation_id
      and i.is_third_party
      and i.requested_by_patient_id is not null
      and c.patient_id = i.requested_by_patient_id
      and (
        -- After the review: the approval named this beneficiary itself, and
        -- `approved_patient_id` is written by no function but that staff-gated
        -- approval. This is the only *durable* exemption, and it is the one
        -- that lets the appointment be edited later — a reschedule keeps the
        -- row pending, so the trigger runs again long after the approval
        -- transaction is gone.
        i.approved_patient_id = p_patient_id
        -- During the review, and only during it. `approved_patient_id` cannot
        -- be written yet: `ai_patient_intakes_review_shape_check` forbids it on
        -- a `pending_review` row. So the beneficiary is named by the approval
        -- transaction, which is authorized above, and the folded national id is
        -- an identity *consistency* check on what that transaction is doing —
        -- never the thing that grants the exemption. Without `v_in_approval`
        -- and the row pin, "a pending intake and a matching national id" would
        -- be enough to book on somebody else's thread with no staff review
        -- anywhere in it, which is not an authorization rule.
        or (
          v_in_approval
          and i.id = v_marked_intake
          and i.review_status = 'pending_review'
          and i.national_id_folded is not null
          and exists (
            select 1 from public.patients p
            where p.id = p_patient_id
              and p.clinic_id = p_clinic_id
              and not p.is_deleted and p.deleted_at is null
              and public.fold_national_id(p.national_id) = i.national_id_folded
          )
        )
      )
  );
end;
$$;

comment on function public.ai_conversation_booking_beneficiary_matches(uuid, uuid, uuid) is
  'True when this clinic holds a third-party intake on this conversation whose requester is the patient the conversation is linked to and whose beneficiary is the given patient - either because the approval already recorded it (approved_patient_id), or because the staff approval of that exact intake is running in this transaction. The one case in which an AI pending appointment may name a patient other than the conversation''s own.';

revoke all on function public.ai_conversation_booking_beneficiary_matches(uuid, uuid, uuid)
  from public, anon;
-- Called from `enforce_ai_pending_booking_policy` and nowhere else. That is an
-- invoker-security trigger, so the grant covers exactly the roles that can
-- reach an insert or update of an AI-provenance appointment: `service_role`
-- (the assistant's own booking path) and `authenticated` (staff, and the
-- approval transaction's caller). Deliberately **not** `anon`: no policy on
-- `public.appointments` lets `anon` write one, so it never reaches this
-- trigger, and a security-boundary helper is not exposed to a role with no
-- concrete need of it. The sibling `ai_intake_approval_context_matches` keeps
-- its broader grant because it is also called from
-- `protect_patient_ai_identity_state` on `public.conversations`, a different
-- actor surface. A role that somehow reached the trigger without this grant
-- would get a permission error, not a bypass.
grant execute on function public.ai_conversation_booking_beneficiary_matches(uuid, uuid, uuid)
  to authenticated, service_role;

create or replace function public.enforce_ai_pending_booking_policy()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_slot_cap integer;
  v_ttl_minutes integer;
  v_patient_pending integer;
  v_slot_pending integer;
  v_conversation_patient uuid;
  v_receipt public.ai_action_receipts%rowtype;
  v_is_ai boolean;
  v_is_intake_approval boolean := false;
  v_old_is_active boolean := false;
begin
  v_is_ai := new.ai_patient_conversation_id is not null
    or new.ai_workflow_run_id is not null
    or new.ai_action_receipt_id is not null;
  v_is_intake_approval := public.ai_intake_approval_context_matches(
    new.clinic_id, new.ai_patient_conversation_id
  );

  if not v_is_ai or new.status <> 'pending'::public.appointment_status
     or new.deleted_at is not null then
    return new;
  end if;

  if new.scheduled_at < clock_timestamp() + interval '24 hours' then
    raise exception 'AI_BOOKING_MINIMUM_NOTICE' using errcode = '22023';
  end if;

  if tg_op = 'UPDATE' then
    v_old_is_active := (
      (
        old.ai_patient_conversation_id is not null
        or old.ai_workflow_run_id is not null
        or old.ai_action_receipt_id is not null
      )
      and old.status = 'pending'::public.appointment_status
      and old.deleted_at is null
    );
    if v_old_is_active
       and old.patient_id = new.patient_id
       and old.doctor_id = new.doctor_id
       and old.scheduled_at = new.scheduled_at
       and old.ai_patient_conversation_id is not distinct from new.ai_patient_conversation_id
       and old.ai_workflow_run_id is not distinct from new.ai_workflow_run_id
       and old.ai_action_receipt_id is not distinct from new.ai_action_receipt_id then
      return new;
    end if;
  end if;

  select clinic.ai_pending_slot_cap, clinic.ai_pending_booking_ttl_minutes
    into v_slot_cap, v_ttl_minutes
  from public.clinics as clinic
  where clinic.id = new.clinic_id and clinic.is_active
  for share;
  if not found then
    raise exception 'AI_BOOKING_CLINIC_UNAVAILABLE' using errcode = 'P0001';
  end if;

  if new.ai_patient_conversation_id is not null then
    select conversation.patient_id into v_conversation_patient
    from public.conversations as conversation
    where conversation.id = new.ai_patient_conversation_id
      and conversation.clinic_id = new.clinic_id
      and (v_is_intake_approval or conversation.status = 'open'::public.conversation_status);
    if not found or v_conversation_patient is null
       or (
         v_conversation_patient <> new.patient_id
         and not public.ai_conversation_booking_beneficiary_matches(
           new.clinic_id, new.ai_patient_conversation_id, new.patient_id
         )
       )
       or new.created_by is not null then
      raise exception 'AI_BOOKING_CONVERSATION_IDENTITY_MISMATCH'
        using errcode = '42501';
    end if;
  end if;

  if new.ai_action_receipt_id is not null then
    select * into v_receipt
    from public.ai_action_receipts receipt
    where receipt.id = new.ai_action_receipt_id
      and receipt.clinic_id = new.clinic_id
      and receipt.actor_id = new.created_by
      and receipt.action_id = 'appointments.create_pending'
      and receipt.phase = 'execute';
    if not found then
      raise exception 'AI_BOOKING_ACTION_RECEIPT_MISMATCH' using errcode = '42501';
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('p5a-ai-booking:' || new.clinic_id::text, 0)
  );
  new.expires_at := coalesce(
    new.expires_at,
    clock_timestamp() + make_interval(mins => v_ttl_minutes)
  );
  if new.expires_at <= clock_timestamp() then
    raise exception 'AI_BOOKING_INVALID_EXPIRY' using errcode = '22023';
  end if;

  select count(*)::integer into v_patient_pending
  from public.appointments as appointment
  where appointment.clinic_id = new.clinic_id
    and appointment.patient_id = new.patient_id
    and appointment.status = 'pending'::public.appointment_status
    and appointment.deleted_at is null
    and appointment.expires_at > clock_timestamp()
    and (
      appointment.ai_patient_conversation_id is not null
      or appointment.ai_workflow_run_id is not null
      or appointment.ai_action_receipt_id is not null
    )
    and (tg_op = 'INSERT' or appointment.id <> new.id);
  if v_patient_pending >= 1 then
    raise exception 'AI_PENDING_PATIENT_CAP' using errcode = 'P0001';
  end if;

  select count(*)::integer into v_slot_pending
  from public.appointments as appointment
  where appointment.clinic_id = new.clinic_id
    and appointment.doctor_id = new.doctor_id
    and appointment.scheduled_at = new.scheduled_at
    and appointment.status = 'pending'::public.appointment_status
    and appointment.deleted_at is null
    and appointment.expires_at > clock_timestamp()
    and (
      appointment.ai_patient_conversation_id is not null
      or appointment.ai_workflow_run_id is not null
      or appointment.ai_action_receipt_id is not null
    )
    and (tg_op = 'INSERT' or appointment.id <> new.id);
  if v_slot_pending >= v_slot_cap then
    raise exception 'AI_PENDING_SLOT_CAP' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Restated to match exactly what the function carries today.
revoke all on function public.enforce_ai_pending_booking_policy()
  from public, anon, authenticated, service_role;
