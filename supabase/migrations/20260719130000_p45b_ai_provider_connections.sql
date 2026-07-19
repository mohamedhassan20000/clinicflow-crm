-- P4.5B: encrypted tenant AI provider credentials and explicit routing modes.
--
-- Credential ciphertext is service-role-only and never has an authenticated
-- read policy. Lifecycle RPCs verify the clinic's primary administrator again
-- inside the database and write metadata-only audit records atomically.

create table public.ai_provider_connections (
  id uuid primary key,
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  provider text not null check (provider = 'anthropic'),
  credential_encrypted bytea,
  encryption_key_version smallint not null check (encryption_key_version between 1 and 65535),
  masked_fingerprint text not null check (masked_fingerprint ~ '^sha256:[0-9a-f]{8}…[0-9a-f]{4}$'),
  lifecycle_status text not null check (lifecycle_status in ('active', 'retired', 'revoked')),
  health_status text not null check (
    health_status in ('valid', 'invalid', 'insufficient_scope', 'quota', 'provider_unavailable')
  ),
  last_error_code text check (
    last_error_code is null
    or last_error_code in ('invalid', 'insufficient_scope', 'quota', 'provider_unavailable')
  ),
  created_by uuid references public.profiles(id) on delete set null,
  activated_at timestamptz not null default clock_timestamp(),
  tested_at timestamptz not null default clock_timestamp(),
  rotated_at timestamptz,
  retired_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_provider_connections_secret_lifecycle check (
    (lifecycle_status = 'active' and credential_encrypted is not null and retired_at is null and revoked_at is null)
    or (lifecycle_status = 'retired' and credential_encrypted is null and retired_at is not null and revoked_at is null)
    or (lifecycle_status = 'revoked' and credential_encrypted is null and revoked_at is not null)
  )
);

create unique index ai_provider_connections_one_active_idx
  on public.ai_provider_connections (clinic_id, provider)
  where lifecycle_status = 'active';
create index ai_provider_connections_clinic_history_idx
  on public.ai_provider_connections (clinic_id, created_at desc);

create table public.ai_clinic_provider_policies (
  clinic_id uuid primary key references public.clinics(id) on delete cascade,
  credential_mode text not null default 'managed'
    check (credential_mode in ('managed', 'byok_strict', 'hybrid')),
  provider text check (provider is null or provider = 'anthropic'),
  hybrid_disclosure_version text,
  hybrid_accepted_at timestamptz,
  hybrid_accepted_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_clinic_provider_policies_mode_shape check (
    (credential_mode = 'managed'
      and provider is null
      and hybrid_disclosure_version is null
      and hybrid_accepted_at is null
      and hybrid_accepted_by is null)
    or (credential_mode = 'byok_strict'
      and provider = 'anthropic'
      and hybrid_disclosure_version is null
      and hybrid_accepted_at is null
      and hybrid_accepted_by is null)
    or (credential_mode = 'hybrid'
      and provider = 'anthropic'
      and hybrid_disclosure_version = 'p45b-hybrid-disclosure-v1'
      and hybrid_accepted_at is not null
      and hybrid_accepted_by is not null)
  )
);

create trigger trg_ai_provider_connections_updated_at
  before update on public.ai_provider_connections
  for each row execute function public.set_updated_at();
create trigger trg_ai_clinic_provider_policies_updated_at
  before update on public.ai_clinic_provider_policies
  for each row execute function public.set_updated_at();

alter table public.ai_provider_connections enable row level security;
alter table public.ai_clinic_provider_policies enable row level security;
revoke all on table public.ai_provider_connections from public, anon, authenticated;
revoke all on table public.ai_clinic_provider_policies from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_provider_connections to service_role;
grant select, insert, update, delete on table public.ai_clinic_provider_policies to service_role;

create or replace function public.assert_primary_ai_provider_admin(
  p_clinic_id uuid,
  p_actor_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_primary_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AI_PROVIDER_NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select profile.id
  into v_primary_id
  from public.profiles as profile
  where profile.clinic_id = p_clinic_id
    and profile.role = 'admin'::public.user_role
    and profile.is_active = true
    and profile.is_deleted = false
    and profile.deleted_at is null
  order by profile.created_at asc, profile.id asc
  limit 1;

  if v_primary_id is null or v_primary_id <> p_actor_id then
    raise exception 'AI_PROVIDER_PRIMARY_ADMIN_REQUIRED' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.assert_primary_ai_provider_admin(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.activate_ai_provider_connection(
  p_connection_id uuid,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_provider text,
  p_credential_encrypted bytea,
  p_encryption_key_version smallint,
  p_masked_fingerprint text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous public.ai_provider_connections%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  perform public.assert_primary_ai_provider_admin(p_clinic_id, p_actor_id);
  -- Serializes first connection creation as well as rotations, where no active
  -- connection row may yet exist to lock.
  perform 1 from public.clinics where id = p_clinic_id for update;
  if not found then
    raise exception 'AI_PROVIDER_CLINIC_NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_connection_id is null
     or p_provider is distinct from 'anthropic'
     or p_credential_encrypted is null
     or p_encryption_key_version is null
     or p_encryption_key_version < 1
     or p_masked_fingerprint is null
     or p_masked_fingerprint !~ '^sha256:[0-9a-f]{8}…[0-9a-f]{4}$' then
    raise exception 'AI_PROVIDER_INVALID_CONNECTION';
  end if;

  select * into v_previous
  from public.ai_provider_connections
  where clinic_id = p_clinic_id
    and provider = p_provider
    and lifecycle_status = 'active'
  for update;

  if found then
    update public.ai_provider_connections
    set credential_encrypted = null,
        lifecycle_status = 'retired',
        retired_at = v_now,
        rotated_at = v_now
    where id = v_previous.id;
  end if;

  insert into public.ai_provider_connections (
    id, clinic_id, provider, credential_encrypted, encryption_key_version,
    masked_fingerprint, lifecycle_status, health_status, last_error_code,
    created_by, activated_at, tested_at, rotated_at
  ) values (
    p_connection_id, p_clinic_id, p_provider, p_credential_encrypted,
    p_encryption_key_version, p_masked_fingerprint, 'active', 'valid', null,
    p_actor_id, v_now, v_now, case when v_previous.id is null then null else v_now end
  );

  insert into public.ai_clinic_provider_policies (
    clinic_id, credential_mode, provider, updated_by
  ) values (
    p_clinic_id, 'managed', null, p_actor_id
  ) on conflict (clinic_id) do nothing;

  insert into public.audit_logs (
    actor_id, clinic_id, action, table_name, record_id, old_data, new_data
  ) values (
    p_actor_id,
    p_clinic_id,
    case when v_previous.id is null then 'AI_PROVIDER_CONNECTION_CREATED' else 'AI_PROVIDER_CONNECTION_ROTATED' end,
    'ai_provider_connections',
    p_connection_id,
    case when v_previous.id is null then null else jsonb_build_object(
      'provider', v_previous.provider,
      'connection_id', v_previous.id,
      'masked_fingerprint', v_previous.masked_fingerprint,
      'lifecycle_status', 'retired'
    ) end,
    jsonb_build_object(
      'provider', p_provider,
      'connection_id', p_connection_id,
      'masked_fingerprint', p_masked_fingerprint,
      'health_status', 'valid',
      'encryption_key_version', p_encryption_key_version
    )
  );

  return p_connection_id;
end;
$$;

create or replace function public.record_ai_provider_connection_test(
  p_connection_id uuid,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_health_status text,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection public.ai_provider_connections%rowtype;
begin
  perform public.assert_primary_ai_provider_admin(p_clinic_id, p_actor_id);
  if p_health_status is null
     or p_health_status not in ('valid', 'invalid', 'insufficient_scope', 'quota', 'provider_unavailable')
     or (p_health_status = 'valid' and p_error_code is not null)
     or (p_health_status <> 'valid' and p_error_code <> p_health_status) then
    raise exception 'AI_PROVIDER_INVALID_HEALTH';
  end if;

  update public.ai_provider_connections
  set health_status = p_health_status,
      last_error_code = p_error_code,
      tested_at = clock_timestamp()
  where id = p_connection_id
    and clinic_id = p_clinic_id
    and lifecycle_status = 'active'
  returning * into v_connection;
  if not found then
    raise exception 'AI_PROVIDER_CONNECTION_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.audit_logs (
    actor_id, clinic_id, action, table_name, record_id, new_data
  ) values (
    p_actor_id, p_clinic_id, 'AI_PROVIDER_CONNECTION_TESTED',
    'ai_provider_connections', p_connection_id,
    jsonb_build_object(
      'provider', v_connection.provider,
      'masked_fingerprint', v_connection.masked_fingerprint,
      'health_status', p_health_status,
      'error_code', p_error_code
    )
  );
  return true;
end;
$$;

create or replace function public.set_ai_provider_policy(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_credential_mode text,
  p_hybrid_disclosure_version text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.ai_clinic_provider_policies%rowtype;
  v_connection_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  perform public.assert_primary_ai_provider_admin(p_clinic_id, p_actor_id);
  if p_credential_mode is null
     or p_credential_mode not in ('managed', 'byok_strict', 'hybrid') then
    raise exception 'AI_PROVIDER_INVALID_MODE';
  end if;
  if p_credential_mode = 'hybrid'
     and p_hybrid_disclosure_version is distinct from 'p45b-hybrid-disclosure-v1' then
    raise exception 'AI_PROVIDER_HYBRID_ACCEPTANCE_REQUIRED' using errcode = '42501';
  end if;
  if p_credential_mode <> 'hybrid' and p_hybrid_disclosure_version is not null then
    raise exception 'AI_PROVIDER_INVALID_MODE';
  end if;

  if p_credential_mode <> 'managed' then
    select connection.id into v_connection_id
    from public.ai_provider_connections as connection
    where connection.clinic_id = p_clinic_id
      and connection.provider = 'anthropic'
      and connection.lifecycle_status = 'active'
      and connection.health_status = 'valid'
      and connection.credential_encrypted is not null
    for update;
    if v_connection_id is null then
      raise exception 'AI_PROVIDER_HEALTHY_CONNECTION_REQUIRED' using errcode = 'P0002';
    end if;
  end if;

  select * into v_old
  from public.ai_clinic_provider_policies
  where clinic_id = p_clinic_id
  for update;

  insert into public.ai_clinic_provider_policies (
    clinic_id, credential_mode, provider, hybrid_disclosure_version,
    hybrid_accepted_at, hybrid_accepted_by, updated_by
  ) values (
    p_clinic_id,
    p_credential_mode,
    case when p_credential_mode = 'managed' then null else 'anthropic' end,
    case when p_credential_mode = 'hybrid' then p_hybrid_disclosure_version else null end,
    case when p_credential_mode = 'hybrid' then v_now else null end,
    case when p_credential_mode = 'hybrid' then p_actor_id else null end,
    p_actor_id
  ) on conflict (clinic_id) do update
  set credential_mode = excluded.credential_mode,
      provider = excluded.provider,
      hybrid_disclosure_version = excluded.hybrid_disclosure_version,
      hybrid_accepted_at = excluded.hybrid_accepted_at,
      hybrid_accepted_by = excluded.hybrid_accepted_by,
      updated_by = excluded.updated_by;

  insert into public.audit_logs (
    actor_id, clinic_id, action, table_name, record_id, old_data, new_data
  ) values (
    p_actor_id, p_clinic_id, 'AI_PROVIDER_MODE_CHANGED',
    'ai_clinic_provider_policies', p_clinic_id,
    jsonb_build_object('credential_mode', coalesce(v_old.credential_mode, 'managed')),
    jsonb_build_object(
      'credential_mode', p_credential_mode,
      'provider', case when p_credential_mode = 'managed' then null else 'anthropic' end,
      'hybrid_disclosure_version', case when p_credential_mode = 'hybrid' then p_hybrid_disclosure_version else null end
    )
  );
  return true;
end;
$$;

create or replace function public.revoke_ai_provider_connection(
  p_connection_id uuid,
  p_clinic_id uuid,
  p_actor_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection public.ai_provider_connections%rowtype;
  v_old_mode text;
  v_now timestamptz := clock_timestamp();
begin
  perform public.assert_primary_ai_provider_admin(p_clinic_id, p_actor_id);

  update public.ai_provider_connections
  set credential_encrypted = null,
      lifecycle_status = 'revoked',
      revoked_at = v_now
  where id = p_connection_id
    and clinic_id = p_clinic_id
    and lifecycle_status = 'active'
  returning * into v_connection;
  if not found then
    raise exception 'AI_PROVIDER_CONNECTION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select credential_mode into v_old_mode
  from public.ai_clinic_provider_policies
  where clinic_id = p_clinic_id
  for update;

  insert into public.ai_clinic_provider_policies (
    clinic_id, credential_mode, provider, updated_by
  ) values (
    p_clinic_id, 'managed', null, p_actor_id
  ) on conflict (clinic_id) do update
  set credential_mode = 'managed',
      provider = null,
      hybrid_disclosure_version = null,
      hybrid_accepted_at = null,
      hybrid_accepted_by = null,
      updated_by = excluded.updated_by;

  insert into public.audit_logs (
    actor_id, clinic_id, action, table_name, record_id, old_data, new_data
  ) values (
    p_actor_id, p_clinic_id, 'AI_PROVIDER_CONNECTION_REVOKED',
    'ai_provider_connections', p_connection_id,
    jsonb_build_object(
      'provider', v_connection.provider,
      'masked_fingerprint', v_connection.masked_fingerprint,
      'credential_mode', coalesce(v_old_mode, 'managed')
    ),
    jsonb_build_object(
      'provider', v_connection.provider,
      'masked_fingerprint', v_connection.masked_fingerprint,
      'lifecycle_status', 'revoked',
      'credential_mode', 'managed'
    )
  );
  return true;
end;
$$;

create or replace function public.log_ai_provider_fallback(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_request_id uuid,
  p_provider text,
  p_error_class text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AI_PROVIDER_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_provider is distinct from 'anthropic'
     or p_error_class is null
     or p_error_class not in ('authentication', 'permission', 'quota', 'rate_limit', 'timeout', 'provider_unavailable', 'request_failed') then
    raise exception 'AI_PROVIDER_INVALID_FALLBACK_AUDIT';
  end if;

  select reservation.id into v_reservation_id
  from public.ai_budget_reservations as reservation
  join public.ai_clinic_provider_policies as policy
    on policy.clinic_id = reservation.clinic_id
  where reservation.request_id = p_request_id
    and reservation.clinic_id = p_clinic_id
    and reservation.actor_id = p_actor_id
    and reservation.credential_mode = 'hybrid'
    and reservation.status = 'reserved'
    and policy.credential_mode = 'hybrid'
    and policy.provider = p_provider
    and policy.hybrid_disclosure_version = 'p45b-hybrid-disclosure-v1'
    and policy.hybrid_accepted_at is not null;
  if v_reservation_id is null then
    raise exception 'AI_PROVIDER_HYBRID_POLICY_REQUIRED' using errcode = '42501';
  end if;

  insert into public.audit_logs (
    actor_id, clinic_id, action, table_name, record_id, new_data
  ) values (
    p_actor_id, p_clinic_id, 'AI_PROVIDER_HYBRID_FALLBACK',
    'ai_budget_reservations', v_reservation_id,
    jsonb_build_object(
      'request_id', p_request_id,
      'credential_mode', 'hybrid',
      'provider', p_provider,
      'from', 'tenant_credential',
      'to', 'managed',
      'error_class', p_error_class
    )
  );
  return true;
end;
$$;

revoke all on function public.activate_ai_provider_connection(uuid, uuid, uuid, text, bytea, smallint, text)
  from public, anon, authenticated;
revoke all on function public.record_ai_provider_connection_test(uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.set_ai_provider_policy(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.revoke_ai_provider_connection(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.log_ai_provider_fallback(uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.activate_ai_provider_connection(uuid, uuid, uuid, text, bytea, smallint, text)
  to service_role;
grant execute on function public.record_ai_provider_connection_test(uuid, uuid, uuid, text, text)
  to service_role;
grant execute on function public.set_ai_provider_policy(uuid, uuid, text, text)
  to service_role;
grant execute on function public.revoke_ai_provider_connection(uuid, uuid, uuid)
  to service_role;
grant execute on function public.log_ai_provider_fallback(uuid, uuid, uuid, text, text)
  to service_role;

-- Expand the P4.5A ledger to preserve the actual credential mode. A trigger
-- derives billing disposition without trusting application-supplied values.
alter table public.ai_budget_reservations
  drop constraint ai_budget_reservations_credential_mode_check,
  add constraint ai_budget_reservations_credential_mode_check
    check (credential_mode in ('managed', 'byok_strict', 'hybrid'));
alter table public.ai_usage_events
  drop constraint ai_usage_events_credential_mode_check,
  add constraint ai_usage_events_credential_mode_check
    check (credential_mode in ('managed', 'byok_strict', 'hybrid')),
  drop constraint ai_usage_events_billing_disposition_check,
  add constraint ai_usage_events_billing_disposition_check
    check (billing_disposition in ('managed_included', 'byok_provider_direct', 'nonbillable_failed'));

create or replace function public.derive_ai_usage_billing_disposition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.billing_disposition := case
    when new.status <> 'success' then 'nonbillable_failed'
    when new.credential_mode = 'byok_strict' then 'byok_provider_direct'
    when new.credential_mode = 'hybrid' and new.fallback_parent_attempt_id is null
      then 'byok_provider_direct'
    else 'managed_included'
  end;
  return new;
end;
$$;

create trigger trg_ai_usage_events_billing_disposition
  before insert on public.ai_usage_events
  for each row execute function public.derive_ai_usage_billing_disposition();
revoke all on function public.derive_ai_usage_billing_disposition()
  from public, anon, authenticated, service_role;

-- Overload the P4.5A reservation RPC with an explicit credential mode. The
-- original transaction remains authoritative for limits and concurrency; this
-- wrapper updates the newly-created lease in the same database transaction.
create or replace function public.reserve_ai_budget(
  p_request_id uuid,
  p_lease_token uuid,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_period_start date,
  p_surface text,
  p_persona text,
  p_task text,
  p_transport text,
  p_expected_provider text,
  p_expected_model text,
  p_model_alias text,
  p_fallback_model_aliases text[],
  p_policy_version text,
  p_certification_version text,
  p_privacy_policy_version text,
  p_reserved_cost_micros bigint,
  p_budget_limit_micros bigint,
  p_lease_seconds integer,
  p_credential_mode text
)
returns table (
  reservation_id uuid,
  returned_lease_token uuid,
  acquired boolean,
  reservation_status text,
  legacy_used integer,
  legacy_limit integer,
  reserved_cost_micros bigint,
  budget_limit_micros bigint,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result record;
begin
  -- Defense-in-depth: this wrapper runs its own validation before delegating to
  -- the auth-gated inner reserve. EXECUTE is service-role only, but the leading
  -- role check keeps the wrapper symmetric with the inner function even if a
  -- future grant widens.
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AI_BUDGET_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_credential_mode is null
     or p_credential_mode not in ('managed', 'byok_strict', 'hybrid') then
    raise exception 'AI_BUDGET_INVALID_CREDENTIAL_MODE';
  end if;

  select * into v_result
  from public.reserve_ai_budget(
    p_request_id, p_lease_token, p_clinic_id, p_actor_id, p_period_start,
    p_surface, p_persona, p_task, p_transport, p_expected_provider,
    p_expected_model, p_model_alias, p_fallback_model_aliases,
    p_policy_version, p_certification_version, p_privacy_policy_version,
    p_reserved_cost_micros, p_budget_limit_micros, p_lease_seconds
  );

  if v_result.acquired then
    update public.ai_budget_reservations
    set credential_mode = p_credential_mode
    where id = v_result.reservation_id
      and lease_token = p_lease_token
      and status = 'reserved';
    if not found then
      raise exception 'AI_BUDGET_CREDENTIAL_MODE_UPDATE_FAILED';
    end if;
  end if;

  return query select
    v_result.reservation_id,
    v_result.returned_lease_token,
    v_result.acquired,
    v_result.reservation_status,
    v_result.legacy_used,
    v_result.legacy_limit,
    v_result.reserved_cost_micros,
    v_result.budget_limit_micros,
    v_result.expires_at;
end;
$$;

revoke all on function public.reserve_ai_budget(
  uuid, uuid, uuid, uuid, date, text, text, text, text, text, text, text,
  text[], text, text, text, bigint, bigint, integer, text
) from public, anon, authenticated;
grant execute on function public.reserve_ai_budget(
  uuid, uuid, uuid, uuid, date, text, text, text, text, text, text, text,
  text[], text, text, text, bigint, bigint, integer, text
) to service_role;

-- Reconcile total provider cost for attribution while charging only the
-- managed portion to ClinicFlow's included-credit pool. The P4.5A reconciler
-- remains the sole writer of immutable attempts; this wrapper corrects the
-- period aggregate inside the same transaction for strict/hybrid BYOK spend.
create or replace function public.reconcile_ai_budget(
  p_reservation_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_attempts jsonb,
  p_actual_cost_micros bigint,
  p_managed_cost_micros bigint,
  p_error_class text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.ai_budget_reservations%rowtype;
  v_reconciled boolean;
  v_direct_cost_micros bigint;
  v_managed_cost_micros bigint;
  v_should_adjust boolean;
begin
  -- Defense-in-depth: the wrapper validates and takes SELECT ... FOR UPDATE
  -- before delegating to the auth-gated inner reconcile. EXECUTE is service-role
  -- only; this leading check keeps the wrapper symmetric with the inner function
  -- even if a future grant widens.
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AI_BUDGET_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_actual_cost_micros is null
     or p_managed_cost_micros is null
     or p_managed_cost_micros < 0
     or p_managed_cost_micros > p_actual_cost_micros then
    raise exception 'AI_BUDGET_INVALID_MANAGED_COST';
  end if;

  select * into v_reservation
  from public.ai_budget_reservations
  where id = p_reservation_id
    and lease_token = p_lease_token
  for update;
  if not found then
    raise exception 'AI_BUDGET_RESERVATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  v_should_adjust := v_reservation.status = 'reserved';

  if v_reservation.credential_mode = 'managed'
     and p_managed_cost_micros <> p_actual_cost_micros then
    raise exception 'AI_BUDGET_INVALID_MANAGED_COST';
  end if;
  if v_reservation.credential_mode = 'byok_strict'
     and p_managed_cost_micros <> 0 then
    raise exception 'AI_BUDGET_STRICT_BYOK_MANAGED_SPEND_FORBIDDEN' using errcode = '42501';
  end if;

  v_reconciled := public.reconcile_ai_budget(
    p_reservation_id,
    p_lease_token,
    p_outcome,
    p_attempts,
    p_actual_cost_micros,
    p_error_class
  );

  -- managed and byok_strict enforce their managed split structurally above
  -- (managed == actual, strict == 0). For hybrid the split is not fixed, so the
  -- managed portion is re-derived in SQL from the immutable, trigger-classified
  -- attempts the inner reconcile just inserted, never trusting the
  -- application-supplied value. The application-supplied split must match the
  -- database-derived sum or the whole reconciliation fails closed.
  v_managed_cost_micros := p_managed_cost_micros;
  if v_reservation.credential_mode = 'hybrid' and v_reconciled and v_should_adjust then
    select coalesce(sum(final_cost_micros), 0)
    into v_managed_cost_micros
    from public.ai_usage_events
    where reservation_id = p_reservation_id
      and billing_disposition = 'managed_included';
    if v_managed_cost_micros <> p_managed_cost_micros then
      raise exception 'AI_BUDGET_INVALID_MANAGED_COST';
    end if;
  end if;

  v_direct_cost_micros := p_actual_cost_micros - v_managed_cost_micros;
  if v_reconciled and v_should_adjust and v_direct_cost_micros > 0 then
    update public.ai_budget_periods
    set spent_micros = spent_micros - v_direct_cost_micros,
        updated_at = clock_timestamp()
    where clinic_id = v_reservation.clinic_id
      and period_start = v_reservation.period_start
      and spent_micros >= v_direct_cost_micros;
    if not found then
      raise exception 'AI_BUDGET_MANAGED_COST_RECONCILIATION_FAILED';
    end if;
  end if;

  return v_reconciled;
end;
$$;

revoke all on function public.reconcile_ai_budget(uuid, uuid, text, jsonb, bigint, bigint, text)
  from public, anon, authenticated;
grant execute on function public.reconcile_ai_budget(uuid, uuid, text, jsonb, bigint, bigint, text)
  to service_role;

comment on table public.ai_provider_connections is
  'P4.5B encrypted tenant AI credentials. No authenticated policies; safe metadata is projected server-side only.';
comment on table public.ai_clinic_provider_policies is
  'P4.5B explicit managed, strict BYOK, or consented hybrid routing policy.';
