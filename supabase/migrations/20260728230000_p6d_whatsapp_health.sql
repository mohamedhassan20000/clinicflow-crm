-- P6D — WhatsApp Health, diagnostics & production-readiness.
--
-- Persists only non-secret operational health facts on clinic_channels. The
-- encrypted credential envelope remains unchanged and clinic_channels keeps
-- zero authenticated policies. All mutation/report RPCs are service-role-only.

alter table public.clinic_channels
  add column if not exists webhook_health_status text not null default 'unknown',
  add column if not exists webhook_health_reason text,
  add column if not exists last_verified_webhook_at timestamptz,
  add column if not exists last_webhook_check_at timestamptz;

alter table public.clinic_channels
  drop constraint if exists clinic_channels_webhook_health_status_check,
  add constraint clinic_channels_webhook_health_status_check
    check (webhook_health_status in ('unknown', 'healthy', 'degraded'));

comment on column public.clinic_channels.webhook_health_status is
  'P6D derived provider-webhook health; non-secret and updated only by the service boundary.';
comment on column public.clinic_channels.webhook_health_reason is
  'P6D closed-set sanitized diagnostic reason; never a raw provider error.';
comment on column public.clinic_channels.last_verified_webhook_at is
  'Last provider callback that passed signature verification and resolved to this clinic/channel.';

-- Atomically persists a webhook check/verified-event result and writes exactly
-- one audit row when health crosses unknown/healthy/degraded. Repeated identical
-- failures therefore do not create one event per callback/check.
create or replace function public.apply_whatsapp_webhook_health(
  p_clinic_id uuid,
  p_channel_id uuid,
  p_status text,
  p_reason text default null,
  p_checked_at timestamptz default null,
  p_verified_at timestamptz default null
)
returns table (applied boolean, transitioned boolean, health_status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_row public.clinic_channels%rowtype;
  v_transitioned boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_status not in ('unknown', 'healthy', 'degraded')
  then
    raise exception 'Not authorized to apply WhatsApp webhook health'
      using errcode = '42501';
  end if;

  select cc.*
    into v_row
    from public.clinic_channels cc
   where cc.id = p_channel_id
     and cc.clinic_id = p_clinic_id
     and cc.channel = 'whatsapp'
   for update;

  if not found then
    return query select false, false, null::text;
    return;
  end if;

  v_transitioned := v_row.webhook_health_status is distinct from p_status;

  update public.clinic_channels cc
     set webhook_health_status = p_status,
         webhook_health_reason = p_reason,
         last_webhook_check_at = coalesce(p_checked_at, cc.last_webhook_check_at),
         last_verified_webhook_at = case
           when p_verified_at is null then cc.last_verified_webhook_at
           when cc.last_verified_webhook_at is null
             or p_verified_at >= cc.last_verified_webhook_at
             then p_verified_at
           else cc.last_verified_webhook_at
         end
   where cc.id = v_row.id;

  if v_transitioned then
    insert into public.audit_logs (
      actor_id, clinic_id, action, table_name, record_id, new_data
    ) values (
      null,
      p_clinic_id,
      'messaging:webhook_health',
      'clinic_channels',
      v_row.id,
      jsonb_build_object(
        'provider', v_row.provider,
        'from', v_row.webhook_health_status,
        'to', p_status,
        'reason', p_reason
      )
    );
  end if;

  return query select true, v_transitioned, p_status;
end;
$$;

revoke all on function public.apply_whatsapp_webhook_health(
  uuid, uuid, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.apply_whatsapp_webhook_health(
  uuid, uuid, text, text, timestamptz, timestamptz
) to service_role;

-- Fair bounded claiming for the daily P6D self-check. The attempt stamp is
-- written before provider I/O so a broken channel cannot starve the rest.
create or replace function public.claim_whatsapp_channels_for_health_check(
  p_limit integer default 120
)
returns table (
  id uuid,
  clinic_id uuid,
  provider public.messaging_provider
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized to claim WhatsApp health checks'
      using errcode = '42501';
  end if;

  return query
  with candidates as (
    select cc.id
      from public.clinic_channels cc
     where cc.channel = 'whatsapp'
       and cc.provider in ('dialog360', 'meta')
       and cc.status in ('pending', 'active', 'error')
     order by cc.last_webhook_check_at asc nulls first, cc.id
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 120), 500))
  ),
  claimed as (
    update public.clinic_channels cc
       set last_webhook_check_at = now()
      from candidates c
     where cc.id = c.id
    returning cc.id, cc.clinic_id, cc.provider
  )
  select claimed.id, claimed.clinic_id, claimed.provider from claimed;
end;
$$;

revoke all on function public.claim_whatsapp_channels_for_health_check(integer)
  from public, anon, authenticated;
grant execute on function public.claim_whatsapp_channels_for_health_check(integer)
  to service_role;

-- Platform-admin report source. Callable only after the application has passed
-- requirePlatformAdmin and only through the service role. It returns platform /
-- messaging metadata: no credentials, recipients, senders, bodies, or errors.
create or replace function public.operator_whatsapp_health_report()
returns table (
  clinic_id uuid,
  clinic_name text,
  channel_id uuid,
  provider public.messaging_provider,
  channel_status public.clinic_channel_status,
  connection_state text,
  webhook_health_status text,
  last_verified_webhook_at timestamptz,
  last_webhook_check_at timestamptz,
  last_synced_at timestamptz,
  business_verification_status text,
  account_review_status text,
  phone_status text,
  quality_rating text,
  messaging_limit_tier text,
  approved_templates bigint,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_outbound_status public.outbound_message_status
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized to read WhatsApp health report'
      using errcode = '42501';
  end if;

  return query
  select
    c.id,
    c.name,
    cc.id,
    cc.provider,
    cc.status,
    cc.connection_state,
    cc.webhook_health_status,
    cc.last_verified_webhook_at,
    cc.last_webhook_check_at,
    cc.last_synced_at,
    cc.business_verification_status,
    cc.account_review_status,
    cc.phone_status,
    cc.quality_rating,
    cc.messaging_limit_tier,
    (
      select count(*)
        from public.message_template_provider_bindings mtpb
       where mtpb.clinic_id = cc.clinic_id
         and mtpb.provider = cc.provider
         and mtpb.approval_status = 'approved'
    ),
    (
      select max(im.received_at)
        from public.inbound_messages im
       where im.clinic_id = cc.clinic_id
         and im.channel = 'whatsapp'
    ),
    outbound_latest.status_updated_at,
    outbound_latest.status
  from public.clinic_channels cc
  join public.clinics c on c.id = cc.clinic_id
  left join lateral (
    select om.status_updated_at, om.status
      from public.outbound_messages om
     where om.clinic_id = cc.clinic_id
       and om.channel = 'whatsapp'
       and om.provider = cc.provider
     order by om.status_updated_at desc, om.id desc
     limit 1
  ) outbound_latest on true
  where cc.channel = 'whatsapp'
    and cc.provider in ('dialog360', 'meta');
end;
$$;

revoke all on function public.operator_whatsapp_health_report()
  from public, anon, authenticated;
grant execute on function public.operator_whatsapp_health_report()
  to service_role;
