-- P4.9A review fixes: placement mutations must never create an unattributed
-- audit row. Keep service-role resolution reads, but require configuration
-- writes to use the authenticated primary-admin RLS boundary.

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
