-- Production-safe metadata soft-delete RPCs for private patient files.
-- These functions avoid fragile client-side UPDATE policy mismatches while
-- preserving explicit clinic and role checks inside the database.

create or replace function public.soft_delete_patient_document(
  p_document_id uuid,
  p_patient_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic_id uuid := public.auth_clinic_id();
  v_role public.user_role := public.auth_role();
  v_deleted_at timestamptz;
begin
  if auth.uid() is null or v_clinic_id is null or v_role is null then
    raise exception 'Not authenticated'
      using errcode = '28000';
  end if;

  if not (v_role = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )) then
    raise exception 'Not authorized to delete patient documents'
      using errcode = '42501';
  end if;

  select d.deleted_at
  into v_deleted_at
  from public.patient_documents d
  join public.patients p on p.id = d.patient_id
  where d.id = p_document_id
    and d.patient_id = p_patient_id
    and d.clinic_id = v_clinic_id
    and p.clinic_id = v_clinic_id
    and not p.is_deleted
  limit 1;

  if not found then
    return false;
  end if;

  if v_deleted_at is not null then
    return true;
  end if;

  update public.patient_documents
  set deleted_at = now()
  where id = p_document_id
    and patient_id = p_patient_id
    and clinic_id = v_clinic_id
    and deleted_at is null;

  return true;
end;
$$;
create or replace function public.soft_delete_medical_note_attachment(
  p_attachment_id uuid,
  p_note_id uuid,
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
  v_deleted_at timestamptz;
begin
  if v_actor_id is null or v_clinic_id is null or v_role is null then
    raise exception 'Not authenticated'
      using errcode = '28000';
  end if;

  if not (v_role = any (
    array['admin'::public.user_role, 'doctor'::public.user_role]
  )) then
    raise exception 'Not authorized to delete medical note attachments'
      using errcode = '42501';
  end if;

  select a.deleted_at
  into v_deleted_at
  from public.medical_note_attachments a
  join public.medical_notes mn on mn.id = a.note_id
  join public.patients p on p.id = a.patient_id
  where a.id = p_attachment_id
    and a.note_id = p_note_id
    and a.patient_id = p_patient_id
    and a.clinic_id = v_clinic_id
    and mn.id = p_note_id
    and mn.patient_id = p_patient_id
    and p.clinic_id = v_clinic_id
    and not p.is_deleted
    and (
      v_role = 'admin'::public.user_role
      or (
        v_role = 'doctor'::public.user_role
        and (
          a.uploaded_by = v_actor_id
          or mn.created_by = v_actor_id
        )
      )
    )
  limit 1;

  if not found then
    return false;
  end if;

  if v_deleted_at is not null then
    return true;
  end if;

  update public.medical_note_attachments
  set deleted_at = now()
  where id = p_attachment_id
    and note_id = p_note_id
    and patient_id = p_patient_id
    and clinic_id = v_clinic_id
    and deleted_at is null;

  return true;
end;
$$;
revoke all on function public.soft_delete_patient_document(uuid, uuid)
from public;
revoke all on function public.soft_delete_medical_note_attachment(uuid, uuid, uuid)
from public;
grant execute on function public.soft_delete_patient_document(uuid, uuid)
to authenticated, service_role;
grant execute on function public.soft_delete_medical_note_attachment(uuid, uuid, uuid)
to authenticated, service_role;
