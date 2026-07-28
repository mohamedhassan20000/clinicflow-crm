-- Resolve PL/pgSQL output-column names (`template_id`, `clinic_id`) in the
-- provider-status RPC explicitly in favor of table columns.

create or replace function public.apply_message_template_provider_status(
  p_provider public.messaging_provider,
  p_provider_template_id text,
  p_status public.template_approval_status,
  p_allowed_from public.template_approval_status[]
)
returns table (template_id uuid, clinic_id uuid, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_binding public.message_template_provider_bindings%rowtype;
  v_template public.message_templates%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized to apply template status' using errcode = '42501';
  end if;

  select b.*
    into v_binding
    from public.message_template_provider_bindings b
   where b.provider = p_provider
     and b.provider_template_id = p_provider_template_id
   for update;

  if not found and p_provider = 'dialog360' then
    select mt.*
      into v_template
      from public.message_templates mt
     where mt.provider_template_id = p_provider_template_id
     for update;

    if found then
      insert into public.message_template_provider_bindings (
        clinic_id,
        template_id,
        provider,
        provider_template_id,
        approval_status
      ) values (
        v_template.clinic_id,
        v_template.id,
        'dialog360',
        v_template.provider_template_id,
        v_template.approval_status
      )
      on conflict (template_id, provider) do update
        set provider_template_id = excluded.provider_template_id
      returning * into v_binding;
    end if;
  end if;

  if v_binding.id is null
     or v_binding.approval_status = p_status
     or not (v_binding.approval_status = any(p_allowed_from))
  then
    return;
  end if;

  update public.message_template_provider_bindings b
     set approval_status = p_status
   where b.id = v_binding.id;

  if exists (
    select 1
      from public.clinic_channels cc
     where cc.clinic_id = v_binding.clinic_id
       and cc.channel = 'whatsapp'
       and cc.provider = p_provider
       and cc.status = 'active'
  ) then
    update public.message_templates mt
       set approval_status = p_status,
           provider_template_id = p_provider_template_id
     where mt.id = v_binding.template_id
       and mt.clinic_id = v_binding.clinic_id;
  end if;

  insert into public.audit_logs (
    actor_id, clinic_id, action, table_name, record_id, new_data
  ) values (
    null,
    v_binding.clinic_id,
    'messaging:template_status',
    'message_templates',
    v_binding.template_id,
    jsonb_build_object('provider', p_provider, 'status', p_status)
  );

  return query
    select v_binding.template_id, v_binding.clinic_id, true;
end;
$$;

revoke all on function public.apply_message_template_provider_status(
  public.messaging_provider, text, public.template_approval_status,
  public.template_approval_status[]
) from public, anon, authenticated;
grant execute on function public.apply_message_template_provider_status(
  public.messaging_provider, text, public.template_approval_status,
  public.template_approval_status[]
) to service_role;
