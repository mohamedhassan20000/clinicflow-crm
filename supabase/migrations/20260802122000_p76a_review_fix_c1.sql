-- P7-6A review fix C1: frozen clinical identities must not have their
-- liveness re-validated during status-only lifecycle transitions. Tenant
-- existence/type checks remain active on every write, while doctor liveness
-- and patient soft-delete checks run on insert or identity reassignment only.

create or replace function public.validate_document_tenant_references()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment_patient uuid;
  v_validate_doctor_liveness boolean := true;
  v_validate_patient_liveness boolean := true;
begin
  if tg_table_name = 'documents' then
    if not exists (select 1 from public.profiles p where p.id = new.issued_by and p.clinic_id = new.clinic_id) then
      raise exception 'DOCUMENT_ACTOR_SCOPE_VIOLATION' using errcode = '42501';
    end if;
    if new.patient_id is not null and not exists (
      select 1 from public.patients p where p.id = new.patient_id and p.clinic_id = new.clinic_id
    ) then
      raise exception 'DOCUMENT_PATIENT_SCOPE_VIOLATION' using errcode = '42501';
    end if;
    if new.staff_id is not null and not exists (
      select 1 from public.profiles p where p.id = new.staff_id and p.clinic_id = new.clinic_id
    ) then
      raise exception 'DOCUMENT_STAFF_SCOPE_VIOLATION' using errcode = '42501';
    end if;
    if new.doctor_id is not null and not exists (
      select 1 from public.profiles p where p.id = new.doctor_id and p.clinic_id = new.clinic_id
    ) then
      raise exception 'DOCUMENT_DOCTOR_SCOPE_VIOLATION' using errcode = '42501';
    end if;
    if new.appointment_id is not null and not exists (
      select 1 from public.appointments a where a.id = new.appointment_id and a.clinic_id = new.clinic_id
    ) then
      raise exception 'DOCUMENT_APPOINTMENT_SCOPE_VIOLATION' using errcode = '42501';
    end if;
    if new.voided_by is not null and not exists (
      select 1 from public.profiles p where p.id = new.voided_by and p.clinic_id = new.clinic_id
    ) then
      raise exception 'DOCUMENT_VOID_ACTOR_SCOPE_VIOLATION' using errcode = '42501';
    end if;
    if new.regenerated_from is not null and not exists (
      select 1 from public.documents d where d.id = new.regenerated_from and d.clinic_id = new.clinic_id
    ) then
      raise exception 'DOCUMENT_PREDECESSOR_SCOPE_VIOLATION' using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    v_validate_doctor_liveness := new.responsible_doctor_id is distinct from old.responsible_doctor_id;
    v_validate_patient_liveness := new.patient_id is distinct from old.patient_id;
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = new.created_by and p.clinic_id = new.clinic_id
  ) then
    raise exception 'CLINICAL_PREPARER_SCOPE_VIOLATION' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = new.responsible_doctor_id
      and p.clinic_id = new.clinic_id
      and p.role = 'doctor'::public.user_role
  ) then
    raise exception 'CLINICAL_DOCTOR_SCOPE_VIOLATION' using errcode = '42501';
  end if;

  if v_validate_doctor_liveness and not exists (
    select 1 from public.profiles p
    where p.id = new.responsible_doctor_id
      and p.clinic_id = new.clinic_id
      and p.role = 'doctor'::public.user_role
      and p.is_active and not p.is_deleted and p.deleted_at is null
  ) then
    raise exception 'CLINICAL_DOCTOR_SCOPE_VIOLATION' using errcode = '42501';
  end if;

  if new.patient_id is not null and not exists (
    select 1 from public.patients p
    where p.id = new.patient_id and p.clinic_id = new.clinic_id
  ) then
    raise exception 'CLINICAL_PATIENT_SCOPE_VIOLATION' using errcode = '42501';
  end if;

  if v_validate_patient_liveness and new.patient_id is not null and not exists (
    select 1 from public.patients p
    where p.id = new.patient_id and p.clinic_id = new.clinic_id and not p.is_deleted
  ) then
    raise exception 'CLINICAL_PATIENT_SCOPE_VIOLATION' using errcode = '42501';
  end if;

  if new.appointment_id is not null then
    select a.patient_id into v_appointment_patient
    from public.appointments a
    where a.id = new.appointment_id and a.clinic_id = new.clinic_id;
    if v_appointment_patient is null then
      raise exception 'CLINICAL_APPOINTMENT_SCOPE_VIOLATION' using errcode = '42501';
    end if;
    if new.patient_id is null or v_appointment_patient <> new.patient_id then
      raise exception 'CLINICAL_APPOINTMENT_PATIENT_MISMATCH' using errcode = '23514';
    end if;
  end if;

  if new.finalized_by is not null and not exists (
    select 1 from public.profiles p
    where p.id = new.finalized_by and p.clinic_id = new.clinic_id
  ) then
    raise exception 'CLINICAL_FINALIZER_SCOPE_VIOLATION' using errcode = '42501';
  end if;
  return new;
end;
$$;
alter function public.validate_document_tenant_references() owner to postgres;
revoke all on function public.validate_document_tenant_references() from public;
