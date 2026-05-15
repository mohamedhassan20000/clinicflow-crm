-- Allow receptionists to use the same metadata-only patient soft-delete path as admins.
-- Related records, documents, attachments, and storage objects remain untouched.

create or replace function public.soft_delete_patient(
  p_patient_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_clinic_id uuid := public.auth_clinic_id();
  v_role public.user_role := public.auth_role();
  v_is_deleted boolean;
begin
  if v_actor_id is null or v_clinic_id is null or v_role is null then
    raise exception 'Not authenticated'
      using errcode = '28000';
  end if;

  if v_role not in ('admin'::public.user_role, 'receptionist'::public.user_role) then
    raise exception 'Not authorized to delete patients'
      using errcode = '42501';
  end if;

  select p.is_deleted
  into v_is_deleted
  from public.patients p
  where p.id = p_patient_id
    and p.clinic_id = v_clinic_id
  limit 1;

  if not found then
    return false;
  end if;

  if v_is_deleted then
    return true;
  end if;

  update public.patients
  set
    is_deleted = true,
    updated_by = v_actor_id
  where id = p_patient_id
    and clinic_id = v_clinic_id
    and is_deleted = false;

  return true;
end;
$$;
revoke all on function public.soft_delete_patient(uuid)
from public;
grant execute on function public.soft_delete_patient(uuid)
to authenticated, service_role;
