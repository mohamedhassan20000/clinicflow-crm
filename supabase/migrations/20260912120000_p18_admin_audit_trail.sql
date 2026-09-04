-- P18 — the administrative audit trail.
--
-- ## Why a third trail, and what it is *not*
--
-- ClinicFlow already keeps two working, reviewed trails, and this migration
-- deliberately leaves both of them alone:
--
--   * `activity_events` (P8D) — the *operational* trail. Semantic appointment
--     and follow-up transitions, written by one SECURITY DEFINER trigger,
--     readable by the same doctors and assistants who may already read the
--     underlying entity. It is authoritative for actor-level history of the
--     clinic's day-to-day work, and nothing here duplicates it.
--   * `audit_logs` — the original raw table-diff dump plus, latterly, a bucket
--     of *namespaced* curated events written by reviewed service-role RPCs
--     (`messaging:*` from `log_messaging_event`, `AI_PROVIDER_*` from the
--     provider-connection RPCs, `AI_TOOL_*` from `log_agent_tool_call`). The
--     curated half is good and is left in place; the raw half is a full
--     `to_jsonb(row)` written by the baseline `write_audit_log()` trigger, and
--     must never be surfaced as an admin-facing feed. That raw trigger is
--     attached to more tables than the clinical ones — as of the baseline
--     schema, `trg_audit_*` sits on `appointments`, `patients`,
--     `medical_notes` *and* `insurance_providers`, plus the documents,
--     packages and clinical-authoring tables added later.
--
-- ## The one deliberate overlap: insurance_providers
--
-- `insurance_providers` therefore already has a legacy raw trigger
-- (`trg_audit_insurance_providers`, baseline schema), and this migration adds
-- a *second*, curated administrative trigger to the same table. That overlap
-- is intentional, not an oversight, and it is additional storage coverage
-- rather than a replacement:
--
--   * the legacy raw insurance audit is left completely untouched — the
--     trigger, the function and every historical `audit_logs` row it has
--     already written stay exactly as they are. Nothing here rewrites,
--     backfills, deletes or re-shapes existing history in either table;
--   * `admin_audit_events` adds the safe *semantic* administrative event
--     ("Gulf Insurance was disabled by Sara") next to the raw row dump, with
--     the same field allowlist every other module here gets;
--   * the raw legacy audit is NOT surfaced in the new Audit Log UI. The reader
--     (`fetchLegacyAuditRows` in `actions/audit-log.ts`) selects only the two
--     curated namespaces `messaging:*` and `AI_PROVIDER_*`; the raw
--     `INSERT`/`UPDATE`/`DELETE` actions — insurance included — are excluded
--     by construction and cannot be filtered back into view;
--   * so the cost of the overlap is one extra small row per insurance change,
--     and the benefit is that the administrative feed reads the same way for
--     insurance as it does for services and departments.
--
-- Retiring the legacy insurance trigger is a separate, reviewable change and is
-- deliberately not attempted in this pass.
--
-- What neither covers is the *administrative* surface: who changed a price, who
-- renamed a department, who promoted a receptionist to admin, who turned the
-- patient assistant off for the whole clinic, whose phone the clinic's WhatsApp
-- is now paired to. Those mutations are today invisible. This table is that
-- trail, and only that trail.
--
-- ## Why triggers rather than "mutate, then audit"
--
-- Every high-value administrative mutation in this codebase already funnels
-- through one authoritative boundary (`lib/settings/mutations.ts`), but a
-- boundary is a convention, and a convention is exactly what a second UI, a
-- migration, an RPC or an AI action can walk around tomorrow. A trigger cannot
-- be walked around: it runs inside the mutating statement's own transaction, so
-- the audit row and the business row commit together or neither does, and an
-- audit failure aborts the change it was supposed to record.
--
-- So the high-priority set — service prices, departments, insurance providers,
-- staff roles, permissions, clinic settings, the clinic-wide AI reply mode, and
-- the linked WhatsApp account — is captured by triggers.
--
-- The one exception is scheduling configuration, which is *already* a
-- multi-statement delete-then-insert in the application layer (see
-- `upsertClinicWorkingHoursMutation`). A trigger there would produce two events
-- per save and still would not make the replace atomic, so those three
-- authoritative boundaries emit one event each through the
-- `record_admin_audit_event` RPC below. Making the replace itself atomic is a
-- separate, larger change and is reported rather than smuggled in here.
--
-- ## Privacy
--
-- This is a clinic system, and an audit trail is not a licence to build a
-- second, unpoliced copy of the record. Every trigger below carries an explicit
-- field allowlist. Nothing writes `to_jsonb(new)`. No message body, note,
-- diagnosis, national ID, credential, token, QR payload or WhatsApp auth state
-- can reach this table, because no code path here ever reads one: the WhatsApp
-- trigger stores the last four digits of the paired number and nothing else,
-- and the clinic trigger records the *names* of sensitive-but-uninteresting
-- fields (branding blobs, e-mail templates) without their values.
--
-- The same rule has to hold for the one writer a *caller* can reach. A trigger
-- allowlist is worthless if `record_admin_audit_event` next to it will accept
-- any module, any action and any JSON object an authenticated admin hands it:
-- that would be a general-purpose audit-authoring API, and therefore a
-- second, unpoliced place to park a national ID or a note. So the RPC is not a
-- general writer. It accepts exactly the three scheduling event tuples the
-- application actually emits, and for each one it validates the payload
-- against the exact shape of the corresponding helper in `lib/audit/record.ts`
-- — key set, value types, element grammar and array length — rejecting
-- anything else rather than silently stripping it. See the RPC at the bottom
-- of this file.
--
-- ## search_path
--
-- Every function this migration introduces runs with `set search_path = ''`,
-- the house style for new SECURITY DEFINER code (see e.g.
-- `20260911120000_existing_patient_identity_discovery.sql`). Every database
-- object each one touches is written schema-qualified — `public.*` for tables,
-- functions and enums, `auth.uid()` for the session — so an empty search path
-- changes nothing about their behaviour and removes the schema-shadowing
-- surface entirely. Bare `coalesce`, `to_jsonb`, `jsonb_build_object` and the
-- jsonb operators resolve from `pg_catalog`, which is always implicitly first
-- in the search path and cannot be shadowed this way.

-- ── canonical table ───────────────────────────────────────────────────────────

create table if not exists public.admin_audit_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  occurred_at timestamptz not null default clock_timestamp(),

  -- Who. `actor_type` is what the database can *prove*, never what a caller
  -- claimed: 'staff' when a JWT identified a clinic profile, 'integration' when
  -- the WhatsApp worker wrote as service_role, 'system' otherwise.
  actor_type text not null
    check (actor_type in ('staff', 'system', 'integration')),
  actor_user_id uuid references public.profiles(id) on delete set null,
  actor_role public.user_role,
  -- Display snapshot so a renamed or removed staff member's past actions still
  -- read correctly. Never an email, never a phone number.
  actor_display text check (actor_display is null or length(actor_display) <= 200),

  -- What.
  module text not null
    check (module in (
      'clinic', 'departments', 'services', 'insurance',
      'staff', 'scheduling', 'ai', 'messaging'
    )),
  action text not null check (action ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),

  -- Which record. `entity_id` is nullable because some administrative subjects
  -- (a clinic-wide schedule, a channel) are configuration rather than a row.
  entity_type text not null check (length(btrim(entity_type)) between 1 and 60),
  entity_id uuid,
  -- Safe human reference: a service or department name, a staff member's name,
  -- a masked phone suffix. Never an identifier that is itself sensitive.
  entity_ref text check (entity_ref is null or length(entity_ref) <= 200),

  -- The change. Focused diffs only — see the allowlists in each trigger.
  before jsonb check (before is null or jsonb_typeof(before) = 'object'),
  after jsonb check (after is null or jsonb_typeof(after) = 'object'),
  changed_fields text[] not null default '{}'::text[],

  source text not null
    check (source in ('staff_web', 'system', 'whatsapp')),
  outcome text not null default 'success'
    check (outcome in ('success', 'failure')),
  -- A stable code, never an exception message and never a provider string.
  failure_code text
    check (failure_code is null or failure_code ~ '^[a-z][a-z0-9_]{0,59}$'),
  correlation_id uuid,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),

  -- A non-staff actor has no user to attribute to; allowing one would let a
  -- 'system' row carry a human name it cannot justify.
  constraint admin_audit_events_actor_shape_check
    check (actor_type = 'staff' or actor_user_id is null),
  constraint admin_audit_events_failure_shape_check
    check (outcome = 'failure' or failure_code is null)
);

comment on table public.admin_audit_events is
  'P18 append-only administrative audit trail: configuration, pricing, staff, '
  'permission, clinic-wide AI and channel changes. Written only by SECURITY '
  'DEFINER triggers and the record_admin_audit_event RPC, both of which derive '
  'clinic and actor from the session. The RPC is not a general audit-authoring '
  'API: it accepts only the three scheduling event tuples, with payloads '
  'validated against the fixed scheduling summary shapes. Read by admins (and '
  'managers, except AI configuration) through RLS. Never stores secrets or '
  'clinical content.';
comment on column public.admin_audit_events.before is
  'Focused, allowlisted prior values for the changed fields only — never a row dump.';
comment on column public.admin_audit_events.changed_fields is
  'Field names that actually changed. Empty for create/delete events.';

-- ── indexes: one per query the feed and the entity history actually run ───────
-- (clinic, time) is the default feed; the other three are the three filters the
-- Audit Log page offers. Nothing indexes the JSONB, because nothing searches it.
create index if not exists admin_audit_events_feed_idx
  on public.admin_audit_events (clinic_id, occurred_at desc, id desc);
create index if not exists admin_audit_events_module_idx
  on public.admin_audit_events (clinic_id, module, occurred_at desc);
create index if not exists admin_audit_events_actor_idx
  on public.admin_audit_events (clinic_id, actor_user_id, occurred_at desc)
  where actor_user_id is not null;
create index if not exists admin_audit_events_entity_idx
  on public.admin_audit_events (clinic_id, entity_type, entity_id, occurred_at desc)
  where entity_id is not null;

-- The Audit Log page also reads the existing operational trail in the same
-- newest-first order. `activity_events` had no plain (clinic, time) index —
-- every existing index leads with an entity, actor, doctor or patient — so the
-- unfiltered feed would have had no way in. This is the one index the new read
-- adds to an existing table.
create index if not exists activity_events_clinic_time_idx
  on public.activity_events (clinic_id, occurred_at desc, id desc);

-- ── RLS: clinic-isolated, append-only, AI configuration is admin-only ─────────
alter table public.admin_audit_events enable row level security;

-- No INSERT/UPDATE/DELETE grant and no such policy: authenticated roles cannot
-- write this table at all. Every writer below is SECURITY DEFINER and therefore
-- runs as the owner, outside RLS.
revoke all on table public.admin_audit_events from anon, authenticated;
grant select on table public.admin_audit_events to authenticated;
grant all on table public.admin_audit_events to service_role;

drop policy if exists "admin_audit_events_select_scoped" on public.admin_audit_events;
create policy "admin_audit_events_select_scoped"
on public.admin_audit_events
for select
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and (
    public.auth_role() = 'admin'::public.user_role
    -- Managers run the clinic's operations and already administer staff,
    -- services and departments, so they read the same history they can create.
    -- AI provider and clinic-wide assistant configuration is primary-admin-only
    -- in Settings, so its history stays admin-only here too rather than
    -- becoming a back door to a screen the manager cannot open.
    or (
      public.auth_role() = 'manager'::public.user_role
      and module <> 'ai'
    )
  )
);

-- ── shared writer ────────────────────────────────────────────────────────────
-- One place stamps identity, so no trigger can get it wrong and no caller can
-- supply it. `p_actor_type_when_anonymous` lets the WhatsApp trigger say
-- "integration" for a worker write instead of the generic "system"; it can
-- never override a proven human actor.
create or replace function public.write_admin_audit_event(
  p_clinic_id uuid,
  p_module text,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_entity_ref text,
  p_before jsonb,
  p_after jsonb,
  p_changed_fields text[],
  p_metadata jsonb default '{}'::jsonb,
  p_actor_type_when_anonymous text default 'system',
  p_source_when_anonymous text default 'system'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_role public.user_role;
  v_display text;
  v_actor_type text;
  v_source text;
  v_id uuid;
begin
  if p_clinic_id is null then
    return null;
  end if;

  if v_actor is not null then
    select p.role, p.full_name
      into v_role, v_display
      from public.profiles p
     where p.id = v_actor;
  end if;

  -- A human actor is recorded only when the session proves one. A service-role
  -- or trigger-cascade write is never attributed to a person.
  if v_actor is null or v_role is null then
    v_actor := null;
    v_role := null;
    v_display := null;
    v_actor_type := p_actor_type_when_anonymous;
    v_source := p_source_when_anonymous;
  else
    v_actor_type := 'staff';
    v_source := 'staff_web';
  end if;

  insert into public.admin_audit_events (
    clinic_id, actor_type, actor_user_id, actor_role, actor_display,
    module, action, entity_type, entity_id, entity_ref,
    before, after, changed_fields, source, metadata
  ) values (
    p_clinic_id, v_actor_type, v_actor, v_role, left(v_display, 200),
    p_module, p_action, p_entity_type, p_entity_id, left(p_entity_ref, 200),
    p_before, p_after, coalesce(p_changed_fields, '{}'::text[]),
    v_source, coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

alter function public.write_admin_audit_event(
  uuid, text, text, text, uuid, text, jsonb, jsonb, text[], jsonb, text, text
) owner to postgres;
revoke all on function public.write_admin_audit_event(
  uuid, text, text, text, uuid, text, jsonb, jsonb, text[], jsonb, text, text
) from public, anon, authenticated;

-- ── diff helpers ─────────────────────────────────────────────────────────────
-- `p_valued` fields are recorded with their before/after values. `p_named`
-- fields are recorded as *having changed* and nothing more — the escape hatch
-- for a field whose value is large, cosmetic or sensitive (a branding blob, an
-- e-mail template body) but whose modification is still worth a line in the log.
create or replace function public.admin_audit_diff(
  p_old jsonb,
  p_new jsonb,
  p_valued text[],
  p_named text[] default '{}'::text[]
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_changed text[] := '{}'::text[];
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_key text;
begin
  foreach v_key in array coalesce(p_valued, '{}'::text[]) loop
    if coalesce(p_old -> v_key, 'null'::jsonb)
       is distinct from coalesce(p_new -> v_key, 'null'::jsonb) then
      v_changed := v_changed || v_key;
      v_before := v_before || jsonb_build_object(v_key, coalesce(p_old -> v_key, 'null'::jsonb));
      v_after := v_after || jsonb_build_object(v_key, coalesce(p_new -> v_key, 'null'::jsonb));
    end if;
  end loop;

  foreach v_key in array coalesce(p_named, '{}'::text[]) loop
    if coalesce(p_old -> v_key, 'null'::jsonb)
       is distinct from coalesce(p_new -> v_key, 'null'::jsonb) then
      v_changed := v_changed || v_key;
    end if;
  end loop;

  return jsonb_build_object(
    'changed', to_jsonb(v_changed),
    'before', v_before,
    'after', v_after
  );
end;
$$;

-- Allowlisted snapshot for create/delete events, where there is no diff to take.
create or replace function public.admin_audit_pick(p_row jsonb, p_fields text[])
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_out jsonb := '{}'::jsonb;
  v_key text;
begin
  if p_row is null then
    return null;
  end if;
  foreach v_key in array coalesce(p_fields, '{}'::text[]) loop
    if p_row ? v_key then
      v_out := v_out || jsonb_build_object(v_key, p_row -> v_key);
    end if;
  end loop;
  return v_out;
end;
$$;

alter function public.admin_audit_diff(jsonb, jsonb, text[], text[]) owner to postgres;
alter function public.admin_audit_pick(jsonb, text[]) owner to postgres;
revoke all on function public.admin_audit_diff(jsonb, jsonb, text[], text[]) from public, anon, authenticated;
revoke all on function public.admin_audit_pick(jsonb, text[]) from public, anon, authenticated;

-- ── departments, services (incl. price), insurance providers ─────────────────
--
-- One trigger for the three directory tables, because they share a lifecycle
-- (create → rename/edit → disable → archive → restore → delete) and the audit
-- reader should not have to learn three vocabularies for it.
--
-- Money is recorded as an exact decimal *string* (`numeric::text`), not as a
-- JSON number. jsonb would in fact preserve the numeric, but every reader
-- between here and the screen is JavaScript, and a price that survives the
-- database only to be rounded by the client is not an audit trail. The clinic's
-- currency is captured alongside it so "25.000 → 30.000" can never be read in
-- the wrong denomination years later, even if the clinic changes currency.
create or replace function public.audit_directory_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entity text;
  v_module text;
  v_valued text[];
  v_clinic uuid;
  v_id uuid;
  v_ref text;
  v_old jsonb;
  v_new jsonb;
  v_diff jsonb;
  v_changed text[];
  v_action text;
  v_meta jsonb := '{}'::jsonb;
  v_currency text;
  v_department text;
begin
  if tg_table_name = 'departments' then
    v_entity := 'department';
    v_module := 'departments';
    v_valued := array['name', 'color', 'description', 'is_active', 'deleted_at'];
  elsif tg_table_name = 'services' then
    v_entity := 'service';
    v_module := 'services';
    v_valued := array['name', 'price', 'currency', 'department_id', 'is_active', 'deleted_at'];
  else
    v_entity := 'insurance_provider';
    v_module := 'insurance';
    v_valued := array['name', 'code', 'is_active', 'deleted_at'];
  end if;

  v_clinic := coalesce(new.clinic_id, old.clinic_id);
  v_id := coalesce(new.id, old.id);
  v_ref := coalesce(new.name, old.name);

  v_old := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new := case when tg_op = 'DELETE' then null else to_jsonb(new) end;

  if tg_table_name = 'services' then
    select c.currency into v_currency from public.clinics c where c.id = v_clinic;
    if v_old is not null then
      v_old := v_old
        || jsonb_build_object('price', old.price::text, 'currency', v_currency);
    end if;
    if v_new is not null then
      v_new := v_new
        || jsonb_build_object('price', new.price::text, 'currency', v_currency);
    end if;
    -- The owning department is the service's authoritative parent, so the event
    -- carries its name as well as its id: an audit line that says
    -- "Consultation (Cardiology)" stays readable after a department is renamed
    -- or removed.
    select d.name into v_department
      from public.departments d
     where d.id = coalesce(new.department_id, old.department_id);
    v_meta := jsonb_build_object(
      'department_id', coalesce(new.department_id, old.department_id),
      'department_name', v_department,
      'currency', v_currency
    );
  end if;

  if tg_op = 'INSERT' then
    v_action := v_entity || '.created';
    perform public.write_admin_audit_event(
      v_clinic, v_module, v_action, v_entity, v_id, v_ref,
      null, public.admin_audit_pick(v_new, v_valued), '{}'::text[], v_meta
    );
    return new;
  end if;

  if tg_op = 'DELETE' then
    v_action := v_entity || '.deleted';
    perform public.write_admin_audit_event(
      v_clinic, v_module, v_action, v_entity, v_id, v_ref,
      public.admin_audit_pick(v_old, v_valued), null, '{}'::text[], v_meta
    );
    return old;
  end if;

  v_diff := public.admin_audit_diff(v_old, v_new, v_valued);
  v_changed := array(select jsonb_array_elements_text(v_diff -> 'changed'));

  -- A save that changed nothing in the allowlist is not an event. 30 KWD to
  -- 30 KWD must not appear in the trail as a price change.
  if array_length(v_changed, 1) is null then
    return new;
  end if;

  -- One event per statement, named for the most consequential thing that
  -- changed; `changed_fields` still lists everything, and the detail view shows
  -- the whole diff. Emitting one event per changed column would turn a single
  -- Save into a wall of near-identical lines.
  v_action := case
    when old.deleted_at is null and new.deleted_at is not null then v_entity || '.archived'
    when old.deleted_at is not null and new.deleted_at is null then v_entity || '.restored'
    when old.is_active and not new.is_active then v_entity || '.disabled'
    when not old.is_active and new.is_active then v_entity || '.enabled'
    when tg_table_name = 'services' and 'price' = any (v_changed) then 'service.price_changed'
    when tg_table_name = 'services' and 'department_id' = any (v_changed) then 'service.department_changed'
    when 'name' = any (v_changed) then v_entity || '.renamed'
    else v_entity || '.updated'
  end;

  -- A money diff that does not carry its denomination is not readable: the
  -- currency is unchanged and so never lands in the diff on its own, but
  -- "25.00 → 30.00" has to say what of.
  if tg_table_name = 'services' and 'price' = any (v_changed) then
    v_diff := jsonb_build_object(
      'before', (v_diff -> 'before') || jsonb_build_object('currency', v_currency),
      'after', (v_diff -> 'after') || jsonb_build_object('currency', v_currency)
    );
  end if;

  perform public.write_admin_audit_event(
    v_clinic, v_module, v_action, v_entity, v_id, v_ref,
    v_diff -> 'before', v_diff -> 'after', v_changed, v_meta
  );
  return new;
end;
$$;

alter function public.audit_directory_change() owner to postgres;
revoke all on function public.audit_directory_change() from public, anon, authenticated;

drop trigger if exists trg_admin_audit_departments on public.departments;
create trigger trg_admin_audit_departments
  after insert or update or delete on public.departments
  for each row execute function public.audit_directory_change();

drop trigger if exists trg_admin_audit_services on public.services;
create trigger trg_admin_audit_services
  after insert or update or delete on public.services
  for each row execute function public.audit_directory_change();

drop trigger if exists trg_admin_audit_insurance_providers on public.insurance_providers;
create trigger trg_admin_audit_insurance_providers
  after insert or update or delete on public.insurance_providers
  for each row execute function public.audit_directory_change();

-- ── staff: role, activation, department, archival ────────────────────────────
--
-- The allowlist is deliberately short. `last_login_at` and `updated_at` change
-- constantly and would drown the trail; `avatar_url`, `phone` and
-- `must_change_password` are either cosmetic or contact detail. What is left is
-- exactly the security-relevant shape of a staff account. `profiles` holds no
-- credential, so there is nothing here that could leak one.
create or replace function public.audit_staff_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_valued constant text[] := array['full_name', 'role', 'department_id', 'is_active', 'is_deleted'];
  v_clinic uuid := coalesce(new.clinic_id, old.clinic_id);
  v_id uuid := coalesce(new.id, old.id);
  v_ref text := coalesce(new.full_name, old.full_name);
  v_diff jsonb;
  v_changed text[];
  v_action text;
begin
  if tg_op = 'INSERT' then
    perform public.write_admin_audit_event(
      v_clinic, 'staff', 'staff.created', 'staff', v_id, v_ref,
      null, public.admin_audit_pick(to_jsonb(new), v_valued), '{}'::text[]
    );
    return new;
  end if;

  if tg_op = 'DELETE' then
    perform public.write_admin_audit_event(
      v_clinic, 'staff', 'staff.deleted', 'staff', v_id, v_ref,
      public.admin_audit_pick(to_jsonb(old), v_valued), null, '{}'::text[]
    );
    return old;
  end if;

  v_diff := public.admin_audit_diff(to_jsonb(old), to_jsonb(new), v_valued);
  v_changed := array(select jsonb_array_elements_text(v_diff -> 'changed'));
  if array_length(v_changed, 1) is null then
    return new;
  end if;

  v_action := case
    when old.is_deleted is distinct from new.is_deleted then
      case when new.is_deleted then 'staff.archived' else 'staff.restored' end
    when old.role is distinct from new.role then 'staff.role_changed'
    when old.is_active is distinct from new.is_active then
      case when new.is_active then 'staff.activated' else 'staff.deactivated' end
    when old.department_id is distinct from new.department_id then 'staff.department_changed'
    when old.full_name is distinct from new.full_name then 'staff.renamed'
    else 'staff.updated'
  end;

  perform public.write_admin_audit_event(
    v_clinic, 'staff', v_action, 'staff', v_id, v_ref,
    v_diff -> 'before', v_diff -> 'after', v_changed
  );
  return new;
end;
$$;

alter function public.audit_staff_change() owner to postgres;
revoke all on function public.audit_staff_change() from public, anon, authenticated;

drop trigger if exists trg_admin_audit_profiles on public.profiles;
create trigger trg_admin_audit_profiles
  after insert or update or delete on public.profiles
  for each row execute function public.audit_staff_change();

-- ── permissions: page, report and AI grants ──────────────────────────────────
--
-- A permission row *is* the change: which subject, which key, visible or not.
-- The event is filed against the staff member rather than the permission row so
-- "what has been granted to Ahmed" is one entity-history query.
create or replace function public.audit_permission_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clinic uuid := coalesce(new.clinic_id, old.clinic_id);
  v_user uuid := coalesce(new.user_id, old.user_id);
  v_ref text;
  v_kind text;
  v_key text;
  v_granted_before boolean;
  v_granted_after boolean;
  v_action text;
begin
  if tg_table_name = 'user_page_permissions' then
    v_kind := 'page';
    v_key := coalesce(new.page_slug, old.page_slug);
    v_granted_before := case when tg_op = 'INSERT' then null else old.is_visible end;
    v_granted_after := case when tg_op = 'DELETE' then null else new.is_visible end;
  elsif tg_table_name = 'user_report_permissions' then
    v_kind := 'report';
    v_key := coalesce(new.report_id, old.report_id);
    v_granted_before := case when tg_op = 'INSERT' then null else old.is_visible end;
    v_granted_after := case when tg_op = 'DELETE' then null else new.is_visible end;
  else
    v_kind := 'ai';
    v_key := coalesce(new.permission_key, old.permission_key);
    v_granted_before := case when tg_op = 'INSERT' then null else old.granted end;
    v_granted_after := case when tg_op = 'DELETE' then null else new.granted end;
  end if;

  if tg_op = 'UPDATE' and v_granted_before is not distinct from v_granted_after then
    return new;
  end if;

  select p.full_name into v_ref from public.profiles p where p.id = v_user;

  v_action := case
    when tg_op = 'DELETE' then v_kind || '_permission.reset'
    when v_granted_after then v_kind || '_permission.granted'
    else v_kind || '_permission.revoked'
  end;

  perform public.write_admin_audit_event(
    v_clinic, 'staff', v_action, 'staff', v_user, v_ref,
    case when tg_op = 'INSERT' then null
         else jsonb_build_object('key', v_key, 'granted', v_granted_before) end,
    case when tg_op = 'DELETE' then null
         else jsonb_build_object('key', v_key, 'granted', v_granted_after) end,
    case when tg_op = 'UPDATE' then array['granted'] else '{}'::text[] end,
    jsonb_build_object('permission_kind', v_kind, 'permission_key', v_key)
  );

  return coalesce(new, old);
end;
$$;

alter function public.audit_permission_change() owner to postgres;
revoke all on function public.audit_permission_change() from public, anon, authenticated;

drop trigger if exists trg_admin_audit_page_permissions on public.user_page_permissions;
create trigger trg_admin_audit_page_permissions
  after insert or update or delete on public.user_page_permissions
  for each row execute function public.audit_permission_change();

drop trigger if exists trg_admin_audit_report_permissions on public.user_report_permissions;
create trigger trg_admin_audit_report_permissions
  after insert or update or delete on public.user_report_permissions
  for each row execute function public.audit_permission_change();

drop trigger if exists trg_admin_audit_ai_permissions on public.user_ai_permissions;
create trigger trg_admin_audit_ai_permissions
  after insert or update or delete on public.user_ai_permissions
  for each row execute function public.audit_permission_change();

-- ── clinic settings, including the clinic-wide AI reply mode ─────────────────
--
-- `clinics.ai_reply_mode` is the global "AI replies on/off" switch (see
-- lib/messaging/ai-enablement.ts). It is written from a service-role RPC rather
-- than the caller's own session, so an application-level audit call there would
-- have had to be trusted to happen. A trigger on the row is the only place that
-- cannot be skipped, whichever surface writes it.
--
-- Two tiers of allowlist. Valued fields are recorded with their values. Named
-- fields — branding blobs, document footers, e-mail templates, the assistant's
-- free-text style line — are recorded as *changed* only: an admin needs to know
-- the invoice e-mail body was edited and by whom, and does not need a second
-- copy of it living in the audit table forever.
create or replace function public.audit_clinic_settings_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_valued constant text[] := array[
    'name', 'phone', 'address', 'email', 'website', 'license_no', 'tax_id',
    'is_active', 'time_format', 'locale', 'timezone', 'currency', 'country',
    'week_start', 'digits',
    'reminders_enabled', 'reminder_lead_hours',
    'invoice_followups_enabled', 'invoice_followup_first_days',
    'invoice_followup_second_days',
    'ai_reply_mode', 'ai_language_mode', 'ai_arabic_style', 'ai_tone'
  ];
  v_named constant text[] := array[
    'logo_url', 'branding_metadata', 'document_footer', 'reminder_offsets',
    'invoice_followup_email_subject', 'invoice_followup_email_body',
    'ai_style_instruction'
  ];
  v_diff jsonb;
  v_changed text[];
  v_action text;
  v_module text;
begin
  v_diff := public.admin_audit_diff(to_jsonb(old), to_jsonb(new), v_valued, v_named);
  v_changed := array(select jsonb_array_elements_text(v_diff -> 'changed'));
  if array_length(v_changed, 1) is null then
    return new;
  end if;

  v_action := case
    when old.ai_reply_mode is distinct from new.ai_reply_mode then 'ai.patient_replies_changed'
    when v_changed && array['ai_language_mode', 'ai_arabic_style', 'ai_tone', 'ai_style_instruction']
      then 'ai.assistant_style_changed'
    when v_changed && array['reminders_enabled', 'reminder_lead_hours', 'reminder_offsets']
      then 'clinic.reminders_changed'
    when v_changed && array[
      'invoice_followups_enabled', 'invoice_followup_first_days',
      'invoice_followup_second_days', 'invoice_followup_email_subject',
      'invoice_followup_email_body'
    ] then 'clinic.invoice_followups_changed'
    else 'clinic.settings_updated'
  end;
  v_module := case when v_action like 'ai.%' then 'ai' else 'clinic' end;

  perform public.write_admin_audit_event(
    -- `clinics.id` is the clinic id.
    new.id, v_module, v_action, 'clinic', new.id, new.name,
    v_diff -> 'before', v_diff -> 'after', v_changed
  );
  return new;
end;
$$;

alter function public.audit_clinic_settings_change() owner to postgres;
revoke all on function public.audit_clinic_settings_change() from public, anon, authenticated;

drop trigger if exists trg_admin_audit_clinics on public.clinics;
create trigger trg_admin_audit_clinics
  after update on public.clinics
  for each row execute function public.audit_clinic_settings_change();

-- ── WhatsApp linked account ──────────────────────────────────────────────────
--
-- Which phone the clinic's WhatsApp is paired to, and when that changed, is a
-- security fact: it decides which conversations the clinic can see and which
-- number patients receive messages from. It is also the place where an audit
-- trail is most likely to be turned into a leak, so this trigger reads exactly
-- three columns and masks the only sensitive one.
--
-- Explicitly never read here: `qr_payload` (the pairing code), `last_error`,
-- `worker_id`, and the entire `whatsapp_linked_device_auth` table, which holds
-- the Baileys authentication state. The intermediate churn — starting,
-- awaiting_scan, connecting — is operational noise already recorded as
-- `messaging:*` events in `audit_logs` by the reviewed health path, so only the
-- settled transitions produce an administrative event.
create or replace function public.audit_linked_device_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_digits text := regexp_replace(coalesce(old.phone_number, ''), '\D', '', 'g');
  v_new_digits text := regexp_replace(coalesce(new.phone_number, ''), '\D', '', 'g');
  v_old_mask text := case when length(v_old_digits) >= 4 then '••••' || right(v_old_digits, 4) end;
  v_new_mask text := case when length(v_new_digits) >= 4 then '••••' || right(v_new_digits, 4) end;
  v_action text;
begin
  v_action := case
    when new.status = 'connected' and old.status is distinct from 'connected'
      then 'whatsapp_account.connected'
    when old.status = 'connected' and new.status in ('disconnected', 'error')
      then 'whatsapp_account.disconnected'
    when new.status = 'connected' and old.status = 'connected'
         and v_old_mask is distinct from v_new_mask
      then 'whatsapp_account.replaced'
    when old.desired_state is distinct from new.desired_state
      then 'whatsapp_account.link_intent_changed'
  end;

  if v_action is null then
    return new;
  end if;

  perform public.write_admin_audit_event(
    new.clinic_id, 'messaging', v_action, 'whatsapp_account', new.id,
    coalesce(v_new_mask, v_old_mask),
    jsonb_build_object(
      'status', old.status,
      'desired_state', old.desired_state,
      'account_suffix', v_old_mask
    ),
    jsonb_build_object(
      'status', new.status,
      'desired_state', new.desired_state,
      'account_suffix', v_new_mask
    ),
    array(
      select f from unnest(array['status', 'desired_state', 'account_suffix']) f
      where (f = 'status' and old.status is distinct from new.status)
         or (f = 'desired_state' and old.desired_state is distinct from new.desired_state)
         or (f = 'account_suffix' and v_old_mask is distinct from v_new_mask)
    ),
    '{}'::jsonb,
    -- The pairing worker writes as service_role with no user session; that is a
    -- provable integration actor, not an anonymous "system" one.
    'integration',
    'whatsapp'
  );
  return new;
end;
$$;

alter function public.audit_linked_device_change() owner to postgres;
revoke all on function public.audit_linked_device_change() from public, anon, authenticated;

drop trigger if exists trg_admin_audit_linked_device on public.whatsapp_linked_device_sessions;
create trigger trg_admin_audit_linked_device
  after update on public.whatsapp_linked_device_sessions
  for each row execute function public.audit_linked_device_change();

-- ── the one non-trigger writer: scheduling configuration ─────────────────────
--
-- Clinic hours, staff schedules and shift templates are saved as a
-- delete-everything-then-insert replace across two statements (see
-- `upsertClinicWorkingHoursMutation`). Row triggers there would emit one event
-- per shift, and statement triggers two events per save, and neither would make
-- the replace atomic — it already is not. So the authoritative mutation
-- boundary emits one event through this RPC instead, with the before/after it
-- has already computed.
--
-- Everything below exists to keep that narrow need from becoming a wide hole.
-- The RPC is authenticated-callable, because deriving the real actor from the
-- caller's own JWT is the entire point of it; a service-role variant would have
-- to be *told* who acted, which is exactly the forgery this table refuses. But
-- authenticated-callable plus free-form arguments would be a general-purpose
-- audit-authoring API: any admin or manager could file "ai.patient_replies_
-- changed" against their own clinic, or park a patient's national ID in a
-- `before` object that no allowlist ever sees. So it is not free-form.
--
-- ### 1. The event tuple is closed
--
-- Exactly three (module, action, entity_type) triples are accepted, matching
-- the three call sites in `lib/settings/mutations.ts`:
--
--     scheduling / clinic_hours.updated    / clinic_hours
--     scheduling / staff_schedule.updated  / staff
--     scheduling / shift_templates.updated / shift_templates
--
-- The *tuple* is matched, not three independent membership tests, so an allowed
-- action cannot be paired with the wrong entity type
-- (`clinic_hours.updated` + `staff` is rejected like anything else). Everything
-- outside the three raises `ADMIN_AUDIT_UNSUPPORTED_EVENT`. Every other module
-- in this file is trigger-written and therefore unreachable from here: there is
-- no argument combination that produces a `services`, `staff`, `clinic`, `ai`
-- or `messaging` event through this function.
--
-- ### 2. The payload is closed
--
-- `before` and `after` are not "some JSON object". They are validated against
-- the exact output of the two helpers that produce them —
-- `auditShiftSummary` and `auditTemplateSummary` in `lib/audit/record.ts` —
-- key set, value types, per-element grammar and array length, by
-- `admin_audit_valid_shift_summary` / `admin_audit_valid_template_summary`
-- below. Unexpected keys are *rejected*, not stripped, so misuse fails loudly
-- at the boundary instead of disappearing.
--
-- ### 3. Identity, clinic and the human reference are derived, never supplied
--
-- `clinic_id` comes from `auth_clinic_id()`, actor and role from `auth.uid()`
-- and `profiles` inside `write_admin_audit_event`, and — new here —
-- `entity_id` and `entity_ref` are derived too. For the two clinic-wide
-- subjects the entity *is* the clinic; for a staff schedule the target must be
-- a live profile in the caller's own clinic, and the displayed name is read
-- from that profile rather than taken from the argument. `p_entity_ref` is
-- accordingly accepted (the application still passes the staff name) and
-- ignored, which closes the last free-text channel into the row.
--
-- `changed_fields` and `metadata` are pinned to the one value each call site
-- actually sends: `{shifts}` or `{templates}`, and an empty metadata object.

-- Grammar of one rendered shift, from `auditShiftSummary`:
--     `${day}:${start.slice(0,5)}-${end.slice(0,5)}`
-- `day_of_week` is 0–6 (zod: `int().min(0).max(6)`) and both clocks are
-- `HH:MM` in 24-hour form (zod: `/^([01]\d|2[0-3]):[0-5]\d$/`). The cap of 28
-- elements is the application maximum: 7 days × 4 intervals per day
-- (`doctorDayScheduleSchema.intervals` is `.max(4)`; clinic hours allow 2).
-- `shift_count` must equal the array length, so the counter cannot be used as a
-- smuggling channel of its own.
create or replace function public.admin_audit_valid_shift_summary(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_value is not null
     and jsonb_typeof(p_value) = 'object'
     -- Exactly these two keys, no more and no fewer.
     and (select count(*) from jsonb_object_keys(p_value)) = 2
     and p_value ? 'shift_count'
     and p_value ? 'shifts'
     and jsonb_typeof(p_value -> 'shift_count') = 'number'
     and (p_value ->> 'shift_count') ~ '^(0|[1-9][0-9]?)$'
     and jsonb_typeof(p_value -> 'shifts') = 'array'
     and jsonb_array_length(p_value -> 'shifts') <= 28
     and jsonb_array_length(p_value -> 'shifts') = (p_value ->> 'shift_count')::int
     and not exists (
       select 1
         from jsonb_array_elements(p_value -> 'shifts') as element(item)
        where jsonb_typeof(element.item) <> 'string'
           or (element.item #>> '{}') !~
              '^[0-6]:([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$'
     );
$$;

-- Grammar of one rendered template, from `auditTemplateSummary`:
--     `${name} ${start.slice(0,5)}-${end.slice(0,5)}` + optional ` (disabled)`
-- The name is admin-authored clinic configuration (zod: trimmed, 1–60 chars,
-- max 10 templates), not patient data, and it is already stored in
-- `staff_shift_templates`. It is still the only free text this RPC can write,
-- so it is bounded three ways: 60 characters, no control characters, and no run
-- of five or more digits — which admits every real label ("Morning",
-- "شفت المساء", "Shift A") while refusing a phone number or a civil ID pasted
-- into a template name. The times contribute runs of at most two digits, so the
-- digit rule never fires on a well-formed summary.
create or replace function public.admin_audit_valid_template_summary(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_value is not null
     and jsonb_typeof(p_value) = 'object'
     and (select count(*) from jsonb_object_keys(p_value)) = 2
     and p_value ? 'template_count'
     and p_value ? 'templates'
     and jsonb_typeof(p_value -> 'template_count') = 'number'
     and (p_value ->> 'template_count') ~ '^(0|[1-9][0-9]?)$'
     and jsonb_typeof(p_value -> 'templates') = 'array'
     and jsonb_array_length(p_value -> 'templates') <= 10
     and jsonb_array_length(p_value -> 'templates') = (p_value ->> 'template_count')::int
     and not exists (
       select 1
         from jsonb_array_elements(p_value -> 'templates') as element(item)
        where jsonb_typeof(element.item) <> 'string'
           or length(element.item #>> '{}') > 90
           or (element.item #>> '{}') !~
              '^[^[:cntrl:]]{1,60} ([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]( \(disabled\))?$'
           or (element.item #>> '{}') ~ '[0-9]{5,}'
     );
$$;

alter function public.admin_audit_valid_shift_summary(jsonb) owner to postgres;
alter function public.admin_audit_valid_template_summary(jsonb) owner to postgres;
revoke all on function public.admin_audit_valid_shift_summary(jsonb)
  from public, anon, authenticated;
revoke all on function public.admin_audit_valid_template_summary(jsonb)
  from public, anon, authenticated;

create or replace function public.record_admin_audit_event(
  p_module text,
  p_action text,
  p_entity_type text,
  p_entity_id uuid default null,
  p_entity_ref text default null,
  p_before jsonb default null,
  p_after jsonb default null,
  p_changed_fields text[] default '{}'::text[],
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clinic uuid := public.auth_clinic_id();
  v_role public.user_role := public.auth_role();
  -- 'shifts' or 'templates': which summary grammar and which changed_fields
  -- value this tuple implies. Null means the tuple is not one of the three.
  v_kind text;
  v_entity_id uuid;
  v_entity_ref text;
begin
  -- Role and clinic first: an unauthorised caller learns nothing about which
  -- event shapes exist.
  if v_clinic is null
     or v_role is null
     or v_role not in ('admin'::public.user_role, 'manager'::public.user_role) then
    raise exception 'ADMIN_AUDIT_FORBIDDEN' using errcode = '42501';
  end if;

  -- The closed tuple. Matched as a whole so an allowed action cannot be
  -- combined with a different entity type or a different module.
  v_kind := case
    when (p_module, p_action, p_entity_type)
       = ('scheduling', 'clinic_hours.updated', 'clinic_hours') then 'shifts'
    when (p_module, p_action, p_entity_type)
       = ('scheduling', 'staff_schedule.updated', 'staff') then 'shifts'
    when (p_module, p_action, p_entity_type)
       = ('scheduling', 'shift_templates.updated', 'shift_templates') then 'templates'
  end;

  if v_kind is null then
    raise exception 'ADMIN_AUDIT_UNSUPPORTED_EVENT' using errcode = '22023';
  end if;

  -- Payload. Both sides are required and both must be the exact summary the
  -- application helper emits for this tuple; anything else — an extra key, a
  -- nested object, a free-text value, a count that disagrees with the array —
  -- is rejected rather than trimmed.
  if p_entity_type = 'shift_templates' then
    if not (public.admin_audit_valid_template_summary(p_before)
            and public.admin_audit_valid_template_summary(p_after)) then
      raise exception 'ADMIN_AUDIT_UNSUPPORTED_PAYLOAD' using errcode = '22023';
    end if;
  else
    if not (public.admin_audit_valid_shift_summary(p_before)
            and public.admin_audit_valid_shift_summary(p_after)) then
      raise exception 'ADMIN_AUDIT_UNSUPPORTED_PAYLOAD' using errcode = '22023';
    end if;
  end if;

  -- `changed_fields` and `metadata` are the other two jsonb/text channels into
  -- the row, so they are pinned to the single value each call site sends.
  if coalesce(p_changed_fields, '{}'::text[])
     is distinct from array[case when v_kind = 'templates' then 'templates' else 'shifts' end] then
    raise exception 'ADMIN_AUDIT_UNSUPPORTED_PAYLOAD' using errcode = '22023';
  end if;

  if coalesce(p_metadata, '{}'::jsonb) <> '{}'::jsonb then
    raise exception 'ADMIN_AUDIT_UNSUPPORTED_PAYLOAD' using errcode = '22023';
  end if;

  -- The subject is derived, never taken on trust. Clinic hours and shift
  -- templates are clinic-wide configuration, so the entity is the caller's own
  -- clinic; a staff schedule must name a live profile in that same clinic, and
  -- its display name is read from the profile rather than from the argument.
  -- `p_entity_ref` is therefore deliberately unused.
  if p_entity_type = 'staff' then
    select p.full_name
      into v_entity_ref
      from public.profiles p
     where p.id = p_entity_id
       and p.clinic_id = v_clinic
       and coalesce(p.is_deleted, false) = false;
    if not found then
      raise exception 'ADMIN_AUDIT_UNSUPPORTED_EVENT' using errcode = '22023';
    end if;
    v_entity_id := p_entity_id;
  else
    if p_entity_id is not null and p_entity_id <> v_clinic then
      raise exception 'ADMIN_AUDIT_UNSUPPORTED_EVENT' using errcode = '22023';
    end if;
    v_entity_id := v_clinic;
    v_entity_ref := null;
  end if;

  return public.write_admin_audit_event(
    v_clinic, p_module, p_action, p_entity_type, v_entity_id, v_entity_ref,
    p_before, p_after,
    array[case when v_kind = 'templates' then 'templates' else 'shifts' end],
    '{}'::jsonb
  );
end;
$$;

comment on function public.record_admin_audit_event(
  text, text, text, uuid, text, jsonb, jsonb, text[], jsonb
) is
  'P18: the only application-callable writer for admin_audit_events, and not a '
  'general-purpose audit-authoring API. Accepts exactly three scheduling event '
  'tuples (clinic_hours.updated/clinic_hours, staff_schedule.updated/staff, '
  'shift_templates.updated/shift_templates) with payloads validated against the '
  'auditShiftSummary / auditTemplateSummary shapes; anything else raises '
  'ADMIN_AUDIT_UNSUPPORTED_EVENT or ADMIN_AUDIT_UNSUPPORTED_PAYLOAD. Clinic, '
  'actor, entity and entity_ref are derived from the session, never supplied.';

alter function public.record_admin_audit_event(
  text, text, text, uuid, text, jsonb, jsonb, text[], jsonb
) owner to postgres;
revoke all on function public.record_admin_audit_event(
  text, text, text, uuid, text, jsonb, jsonb, text[], jsonb
) from public, anon;
grant execute on function public.record_admin_audit_event(
  text, text, text, uuid, text, jsonb, jsonb, text[], jsonb
) to authenticated;
