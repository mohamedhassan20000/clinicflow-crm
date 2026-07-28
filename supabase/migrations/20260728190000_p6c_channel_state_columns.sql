-- P6C — Meta Tech Provider migration & Embedded Signup onboarding (§8 P6C).
--
-- Adds non-secret *operational* columns to clinic_channels for the Meta-direct
-- connection-state machine and hybrid state refresh, plus a service-role audit
-- boundary (log_messaging_event) that writes the clinic-scoped `messaging:<event>`
-- audit_logs rows the P6D activity timeline reads.
--
-- Security posture (unchanged from P3A): clinic_channels carries ZERO authenticated
-- RLS policies. Encrypted credentials live in credentials_encrypted; these new
-- columns are non-secret status metadata (Meta's own verification/phone/quality
-- strings), stored OUTSIDE the encrypted envelope and readable only through the
-- reviewed lib/supabase/admin.ts safe-metadata server boundary. No new grants or
-- policies are added to the table — service-role continues to be the only reader.

alter table public.clinic_channels
  -- Derived per-channel connection state (connecting_to_meta → … → connected,
  -- or verification_failed). Written by the webhook/poll transition applier only.
  add column if not exists connection_state text,
  -- Meta WABA business/account verification status (raw provider string).
  add column if not exists business_verification_status text,
  -- Meta phone-number connection status (raw provider string).
  add column if not exists phone_status text,
  -- Meta phone quality rating (GREEN/YELLOW/RED). Meta-direct only.
  add column if not exists quality_rating text,
  -- Meta messaging (conversation) limit tier. Meta-direct only.
  add column if not exists messaging_limit_tier text,
  -- Last successful reconciliation-poll stamp (hybrid refresh).
  add column if not exists last_synced_at timestamptz,
  -- Sanitized, closed-set failure reason CODE (never raw Meta text). The UI
  -- localizes the code; see lib/messaging/connection-state.ts.
  add column if not exists last_state_reason text;

comment on column public.clinic_channels.connection_state is
  'P6C derived connection state; null on legacy/360dialog channels (honest placeholder).';
comment on column public.clinic_channels.last_state_reason is
  'P6C sanitized failure-reason code (closed set); never raw provider payload text.';

-- log_messaging_event — service-role audit boundary for connection-state
-- transitions and template approval-status changes (§6.6 pattern, plan line 1310).
-- Writes exactly one clinic-scoped audit_logs row per *transition* (callers only
-- invoke it when a stored signal actually changed — never one row per callback).
-- The existing audit_logs_select_admin_manager policy scopes who can read it; the
-- P6D activity timeline reads these `messaging:<event>` rows.
create or replace function public.log_messaging_event(
  p_clinic_id uuid,
  p_event text,
  p_record_id uuid default null,
  p_summary jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  -- Service-role only: the reviewed lib/supabase/admin.ts boundary is the sole
  -- caller. Strip the ambient authenticated/anon EXECUTE below as well.
  if p_clinic_id is null or coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized to log messaging events' using errcode = '42501';
  end if;
  if p_event is null or length(btrim(p_event)) = 0 then
    raise exception 'Messaging event name is required';
  end if;
  if jsonb_typeof(p_summary) is distinct from 'object' then
    raise exception 'Messaging event summary must be a JSON object';
  end if;

  insert into public.audit_logs (
    actor_id, clinic_id, action, table_name, record_id, new_data
  ) values (
    null,                       -- system/provider-driven event, no acting user
    p_clinic_id,
    'messaging:' || p_event,
    'clinic_channels',
    p_record_id,
    p_summary
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.log_messaging_event(uuid, text, uuid, jsonb) from public;
revoke all on function public.log_messaging_event(uuid, text, uuid, jsonb) from authenticated;
revoke all on function public.log_messaging_event(uuid, text, uuid, jsonb) from anon;
grant execute on function public.log_messaging_event(uuid, text, uuid, jsonb) to service_role;
