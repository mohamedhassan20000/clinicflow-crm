-- P7E fix — activate_whatsapp_provider could never complete its UPDATE.
--
-- The body (unchanged since P6C, carried forward verbatim by P7E) wrote:
--
--   set status = case when provider = p_provider then 'active' else 'pending' end
--
-- Both CASE branches are untyped literals, so the expression resolves to `text`
-- rather than to the column's enum. Postgres has no assignment cast from text to
-- an enum, so every call that got as far as the UPDATE failed with
--
--   42804: column "status" is of type public.clinic_channel_status
--          but expression is of type text
--
-- The guard above the UPDATE returns false when the clinic has no row for the
-- requested provider, which is why the fault only surfaces on the success path:
-- the WhatsApp linked-device worker inserts its clinic_channels row, calls this
-- RPC, gets 42804, reports the claim as failed, and unpairs a device that had
-- in fact just paired. The Meta/360dialog switch reaches the same statement.
--
-- The fix is the cast and nothing else: same signature, same authorization
-- guard, same semantics.

create or replace function public.activate_whatsapp_provider(
  p_clinic_id uuid,
  p_provider public.messaging_provider
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exists boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_provider not in ('dialog360', 'meta', 'linked_device')
  then
    raise exception 'Not authorized to activate WhatsApp provider' using errcode = '42501';
  end if;

  select exists (
    select 1
      from public.clinic_channels
     where clinic_id = p_clinic_id
       and channel = 'whatsapp'
       and provider = p_provider
  ) into v_exists;
  if not v_exists then
    return false;
  end if;

  update public.clinic_channels
     set status = (
           case
             when provider = p_provider then 'active'
             else 'pending'
           end
         )::public.clinic_channel_status
   where clinic_id = p_clinic_id
     and channel = 'whatsapp';
  return true;
end;
$$;

revoke all on function public.activate_whatsapp_provider(
  uuid, public.messaging_provider
) from public, anon, authenticated;
grant execute on function public.activate_whatsapp_provider(
  uuid, public.messaging_provider
) to service_role;
