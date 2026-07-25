-- P4.9A: premium contextual-Assistant launcher placement storage.
--
-- These rows control only whether an already-authorized P4.8 launcher is
-- rendered. They are deliberately absent from the chat route, tool registry,
-- tool authorization, RLS data paths, AI budget reservation, and audit
-- boundaries. Enabling a row therefore grants no Assistant or data access;
-- disabling one removes only the contextual entry point.

create table public.assistant_launcher_settings (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  area text not null check (
    area in (
      'patient',
      'appointments',
      'dashboard',
      'revenue',
      'reports',
      'invoices',
      'staff',
      'departments',
      'doctor-schedule'
    )
  ),
  role public.user_role not null,
  enabled boolean not null,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (clinic_id, area, role)
);

create table public.assistant_launcher_user_overrides (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  user_id uuid not null,
  area text not null check (
    area in (
      'patient',
      'appointments',
      'dashboard',
      'revenue',
      'reports',
      'invoices',
      'staff',
      'departments',
      'doctor-schedule'
    )
  ),
  enabled boolean not null,
  primary key (clinic_id, user_id, area),
  constraint assistant_launcher_user_overrides_user_clinic_fk
    foreign key (user_id, clinic_id)
    references public.profiles(id, clinic_id)
    on delete cascade
);

create index assistant_launcher_user_overrides_user_idx
  on public.assistant_launcher_user_overrides (user_id, clinic_id);

create trigger trg_assistant_launcher_settings_updated_at
  before update on public.assistant_launcher_settings
  for each row execute function public.set_updated_at();

-- The legacy write_audit_log trigger assumes every table has one UUID `id`.
-- These placement tables intentionally use tenant-scoped composite keys, so a
-- narrow trigger records their complete, non-PHI rows with record_id = null.
create or replace function public.audit_assistant_launcher_placement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end;
  v_clinic_id uuid := nullif(
    coalesce(v_new ->> 'clinic_id', v_old ->> 'clinic_id'),
    ''
  )::uuid;
begin
  -- Placement changes are human-admin configuration changes. A raw
  -- service-role table write has no authenticated actor and is therefore not
  -- a supported mutation path; fail the mutation instead of emitting an
  -- unattributed audit event. A future reviewed maintenance path must use a
  -- dedicated RPC that verifies and supplies its actor explicitly.
  if v_actor_id is null then
    raise exception 'ASSISTANT_LAUNCHER_ACTOR_REQUIRED' using errcode = '42501';
  end if;

  insert into public.audit_logs (
    actor_id,
    clinic_id,
    action,
    table_name,
    record_id,
    old_data,
    new_data
  ) values (
    v_actor_id,
    v_clinic_id,
    'assistant_launcher_placement:' || lower(tg_op),
    tg_table_name,
    null,
    v_old,
    v_new
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.audit_assistant_launcher_placement() from public;

create trigger trg_audit_assistant_launcher_settings
  after insert or update or delete on public.assistant_launcher_settings
  for each row execute function public.audit_assistant_launcher_placement();

create trigger trg_audit_assistant_launcher_user_overrides
  after insert or update or delete on public.assistant_launcher_user_overrides
  for each row execute function public.audit_assistant_launcher_placement();

alter table public.assistant_launcher_settings enable row level security;
alter table public.assistant_launcher_user_overrides enable row level security;

revoke all on table public.assistant_launcher_settings from public, anon;
revoke all on table public.assistant_launcher_user_overrides from public, anon;
grant select on table public.assistant_launcher_settings
  to authenticated, service_role;
grant select on table public.assistant_launcher_user_overrides
  to authenticated, service_role;
grant insert, update, delete on table public.assistant_launcher_settings
  to authenticated;
grant insert, update, delete on table public.assistant_launcher_user_overrides
  to authenticated;
revoke insert, update, delete on table public.assistant_launcher_settings
  from service_role;
revoke insert, update, delete on table public.assistant_launcher_user_overrides
  from service_role;

-- Every clinic role may read placement metadata for its own clinic. The rows
-- contain no PHI or secrets, and P4.9B needs the primary admin to read the
-- complete matrix. Tenant isolation remains database-enforced.
create policy "Clinic users can read launcher settings"
  on public.assistant_launcher_settings
  for select
  using (clinic_id = public.auth_clinic_id());

create policy "Clinic users can read launcher user overrides"
  on public.assistant_launcher_user_overrides
  for select
  using (clinic_id = public.auth_clinic_id());

-- Direct PostgREST writes and the future P4.9B server actions agree on the
-- existing deterministic primary-admin authority. The supported write path
-- uses the authenticated user's session so RLS authorization and auth.uid()
-- audit attribution execute together. The clinic-scoped service client remains
-- read-only for placement resolution.
create policy "Primary admin can manage launcher settings"
  on public.assistant_launcher_settings
  for all
  using (
    public.is_primary_clinic_admin(
      assistant_launcher_settings.clinic_id,
      auth.uid()
    )
  )
  with check (
    public.is_primary_clinic_admin(
      assistant_launcher_settings.clinic_id,
      auth.uid()
    )
    and assistant_launcher_settings.updated_by = auth.uid()
  );

create policy "Primary admin can manage launcher user overrides"
  on public.assistant_launcher_user_overrides
  for all
  using (
    public.is_primary_clinic_admin(
      assistant_launcher_user_overrides.clinic_id,
      auth.uid()
    )
  )
  with check (
    public.is_primary_clinic_admin(
      assistant_launcher_user_overrides.clinic_id,
      auth.uid()
    )
  );

comment on table public.assistant_launcher_settings is
  'P4.9 UI-placement preferences only; never an authorization or tool-mount source.';
comment on table public.assistant_launcher_user_overrides is
  'P4.9 per-user UI-placement overrides only; never an authorization or tool-mount source.';

-- AI stays exclusive to the stable pro_ai tier. Basic and Professional carry
-- an explicit false value so catalog inspection and upgrade gates are honest;
-- lib/entitlements.ts independently prevents overrides from lifting either
-- non-AI tier into an AI feature.
update public.plans
set features = features || jsonb_build_object(
      'ai.assistant_customization', slug = 'pro_ai'
    ),
    updated_at = clock_timestamp()
where slug in ('basic', 'pro', 'pro_ai');
