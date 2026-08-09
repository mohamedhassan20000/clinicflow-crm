-- P7-6A — Clinical Authoring Foundations
-- Durable clinical source records. This migration intentionally does not add
-- document templates, rendering, issuance, QR, or verification behavior.

alter table public.profiles
  add column if not exists professional_license_no text,
  add column if not exists specialty text,
  add column if not exists professional_title text,
  add column if not exists signature_path text;

alter table public.medical_notes
  add column if not exists appointment_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'medical_notes_appointment_id_fkey'
  ) then
    alter table public.medical_notes
      add constraint medical_notes_appointment_id_fkey
      foreign key (appointment_id) references public.appointments(id)
      on delete set null not valid;
  end if;
end;
$$;
alter table public.medical_notes
  validate constraint medical_notes_appointment_id_fkey;

create table if not exists public.drug_catalog (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  name text not null,
  form text,
  strength text,
  is_controlled boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint drug_catalog_name_check check (char_length(btrim(name)) between 1 and 200),
  constraint drug_catalog_form_check check (form is null or char_length(form) <= 120),
  constraint drug_catalog_strength_check check (strength is null or char_length(strength) <= 120),
  unique (id, clinic_id)
);

create table if not exists public.drug_catalog_departments (
  drug_catalog_id uuid not null references public.drug_catalog(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (drug_catalog_id, department_id)
);

create table if not exists public.lab_test_catalog (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_test_catalog_name_check check (char_length(btrim(name)) between 1 and 200),
  unique (id, clinic_id)
);

create table if not exists public.lab_test_catalog_departments (
  lab_test_catalog_id uuid not null references public.lab_test_catalog(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (lab_test_catalog_id, department_id)
);

create table if not exists public.prescriptions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  created_by uuid not null references public.profiles(id) on delete restrict,
  responsible_doctor_id uuid not null references public.profiles(id) on delete restrict,
  patient_id uuid references public.patients(id) on delete restrict,
  subject_full_name text,
  subject_dob date,
  subject_national_id text,
  appointment_id uuid references public.appointments(id) on delete set null,
  status text not null default 'draft',
  valid_until date,
  notes text,
  finalized_at timestamptz,
  finalized_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prescriptions_status_check check (status = any (array['draft', 'finalized', 'void'])),
  constraint prescriptions_subject_check check (
    (patient_id is not null and nullif(btrim(subject_full_name), '') is null)
    or (patient_id is null and nullif(btrim(subject_full_name), '') is not null)
  ),
  constraint prescriptions_external_dob_check check (subject_dob is null or subject_dob <= current_date),
  constraint prescriptions_notes_check check (notes is null or char_length(notes) <= 5000),
  constraint prescriptions_finalization_check check (
    (status = 'draft' and finalized_at is null and finalized_by is null)
    or (status in ('finalized', 'void') and finalized_at is not null and finalized_by is not null)
  ),
  unique (id, clinic_id)
);

create table if not exists public.prescription_medications (
  id uuid primary key default gen_random_uuid(),
  prescription_id uuid not null references public.prescriptions(id) on delete cascade,
  drug_catalog_id uuid references public.drug_catalog(id) on delete set null,
  drug_name text not null,
  dose text,
  frequency text,
  duration text,
  route text,
  quantity text,
  instructions text,
  is_controlled_snapshot boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prescription_medications_name_check check (char_length(btrim(drug_name)) between 1 and 200),
  constraint prescription_medications_sort_order_check check (sort_order >= 0),
  constraint prescription_medications_instructions_check check (instructions is null or char_length(instructions) <= 2000)
);

create table if not exists public.lab_requests (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  created_by uuid not null references public.profiles(id) on delete restrict,
  responsible_doctor_id uuid not null references public.profiles(id) on delete restrict,
  patient_id uuid references public.patients(id) on delete restrict,
  subject_full_name text,
  subject_dob date,
  subject_national_id text,
  appointment_id uuid references public.appointments(id) on delete set null,
  priority text not null default 'routine',
  laboratory_name text,
  clinical_context text,
  instructions text,
  status text not null default 'draft',
  finalized_at timestamptz,
  finalized_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_requests_priority_check check (priority = any (array['routine', 'urgent', 'stat'])),
  constraint lab_requests_status_check check (status = any (array['draft', 'finalized', 'void'])),
  constraint lab_requests_subject_check check (
    (patient_id is not null and nullif(btrim(subject_full_name), '') is null)
    or (patient_id is null and nullif(btrim(subject_full_name), '') is not null)
  ),
  constraint lab_requests_external_dob_check check (subject_dob is null or subject_dob <= current_date),
  constraint lab_requests_context_check check (clinical_context is null or char_length(clinical_context) <= 5000),
  constraint lab_requests_instructions_check check (instructions is null or char_length(instructions) <= 5000),
  constraint lab_requests_finalization_check check (
    (status = 'draft' and finalized_at is null and finalized_by is null)
    or (status in ('finalized', 'void') and finalized_at is not null and finalized_by is not null)
  ),
  unique (id, clinic_id)
);

create table if not exists public.lab_request_tests (
  id uuid primary key default gen_random_uuid(),
  lab_request_id uuid not null references public.lab_requests(id) on delete cascade,
  lab_test_catalog_id uuid references public.lab_test_catalog(id) on delete set null,
  test_name text not null,
  notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_request_tests_name_check check (char_length(btrim(test_name)) between 1 and 200),
  constraint lab_request_tests_notes_check check (notes is null or char_length(notes) <= 2000),
  constraint lab_request_tests_sort_order_check check (sort_order >= 0)
);

create table if not exists public.sick_leaves (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  created_by uuid not null references public.profiles(id) on delete restrict,
  responsible_doctor_id uuid not null references public.profiles(id) on delete restrict,
  patient_id uuid references public.patients(id) on delete restrict,
  subject_full_name text,
  subject_dob date,
  subject_national_id text,
  appointment_id uuid not null references public.appointments(id) on delete restrict,
  leave_start_date date not null,
  leave_end_date date not null,
  recipient_organization text,
  recipient_reference text,
  restrictions text,
  return_date date,
  status text not null default 'draft',
  finalized_at timestamptz,
  finalized_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sick_leaves_status_check check (status = any (array['draft', 'finalized', 'void'])),
  constraint sick_leaves_subject_check check (
    (patient_id is not null and nullif(btrim(subject_full_name), '') is null)
    or (patient_id is null and nullif(btrim(subject_full_name), '') is not null)
  ),
  constraint sick_leaves_external_dob_check check (subject_dob is null or subject_dob <= current_date),
  constraint sick_leaves_dates_check check (leave_end_date >= leave_start_date),
  constraint sick_leaves_return_date_check check (return_date is null or return_date > leave_end_date),
  constraint sick_leaves_finalization_check check (
    (status = 'draft' and finalized_at is null and finalized_by is null)
    or (status in ('finalized', 'void') and finalized_at is not null and finalized_by is not null)
  ),
  unique (id, clinic_id)
);

create index if not exists drug_catalog_clinic_active_name_idx
  on public.drug_catalog (clinic_id, is_active, lower(name));
create index if not exists lab_test_catalog_clinic_active_name_idx
  on public.lab_test_catalog (clinic_id, is_active, lower(name));
create index if not exists prescriptions_clinic_patient_created_idx
  on public.prescriptions (clinic_id, patient_id, created_at desc);
create index if not exists prescriptions_doctor_status_idx
  on public.prescriptions (clinic_id, responsible_doctor_id, status, created_at desc);
create index if not exists prescription_medications_parent_sort_idx
  on public.prescription_medications (prescription_id, sort_order, id);
create index if not exists lab_requests_clinic_patient_created_idx
  on public.lab_requests (clinic_id, patient_id, created_at desc);
create index if not exists lab_requests_doctor_status_idx
  on public.lab_requests (clinic_id, responsible_doctor_id, status, created_at desc);
create index if not exists lab_request_tests_parent_sort_idx
  on public.lab_request_tests (lab_request_id, sort_order, id);
create index if not exists sick_leaves_clinic_patient_created_idx
  on public.sick_leaves (clinic_id, patient_id, created_at desc);
create index if not exists sick_leaves_doctor_status_idx
  on public.sick_leaves (clinic_id, responsible_doctor_id, status, created_at desc);
create index if not exists medical_notes_appointment_id_idx
  on public.medical_notes (appointment_id) where appointment_id is not null;

-- Cross-tenant and encounter integrity for all clinical headers.
create or replace function public.validate_document_tenant_references()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment_patient uuid;
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
      and p.is_active and not p.is_deleted and p.deleted_at is null
  ) then
    raise exception 'CLINICAL_DOCTOR_SCOPE_VIOLATION' using errcode = '42501';
  end if;

  if new.patient_id is not null and not exists (
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
revoke all on function public.validate_document_tenant_references() from public;

create or replace function public.enforce_clinical_record_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.clinic_id <> old.clinic_id
      or new.created_by <> old.created_by
      or new.responsible_doctor_id <> old.responsible_doctor_id
      or new.patient_id is distinct from old.patient_id
      or new.subject_full_name is distinct from old.subject_full_name
      or new.subject_dob is distinct from old.subject_dob
      or new.subject_national_id is distinct from old.subject_national_id
      or new.appointment_id is distinct from old.appointment_id
      or new.created_at <> old.created_at
    then
      raise exception 'CLINICAL_IDENTITY_IMMUTABLE' using errcode = '23514';
    end if;

    if old.status = 'draft' and new.status not in ('draft', 'finalized') then
      raise exception 'INVALID_CLINICAL_STATUS_TRANSITION' using errcode = '23514';
    elsif old.status = 'finalized' and new.status not in ('finalized', 'void') then
      raise exception 'INVALID_CLINICAL_STATUS_TRANSITION' using errcode = '23514';
    elsif old.status = 'void' then
      raise exception 'VOID_CLINICAL_RECORD_IMMUTABLE' using errcode = '23514';
    end if;

    if old.status <> 'draft' and to_jsonb(new) - array['status', 'updated_at']
      is distinct from to_jsonb(old) - array['status', 'updated_at'] then
      raise exception 'FINALIZED_CLINICAL_RECORD_IMMUTABLE' using errcode = '23514';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.enforce_clinical_record_lifecycle() from public;

create or replace function public.enforce_clinical_line_item_draft()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_parent_id uuid;
begin
  if tg_table_name = 'prescription_medications' then
    if tg_op = 'DELETE' then v_parent_id := old.prescription_id;
    else v_parent_id := new.prescription_id; end if;
    select p.status into v_status from public.prescriptions p where p.id = v_parent_id;
  else
    if tg_op = 'DELETE' then v_parent_id := old.lab_request_id;
    else v_parent_id := new.lab_request_id; end if;
    select l.status into v_status from public.lab_requests l where l.id = v_parent_id;
  end if;
  if v_status is distinct from 'draft' then
    raise exception 'CLINICAL_LINE_ITEMS_LOCKED' using errcode = '23514';
  end if;
  if tg_op <> 'DELETE' then new.updated_at := now(); end if;
  return coalesce(new, old);
end;
$$;
revoke all on function public.enforce_clinical_line_item_draft() from public;

create or replace function public.validate_clinical_catalog_reference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_clinic uuid;
  v_catalog_clinic uuid;
begin
  if tg_table_name = 'prescription_medications' then
    select p.clinic_id into v_parent_clinic from public.prescriptions p where p.id = new.prescription_id;
    if new.drug_catalog_id is not null then
      select c.clinic_id into v_catalog_clinic from public.drug_catalog c where c.id = new.drug_catalog_id;
      if v_catalog_clinic is distinct from v_parent_clinic then
        raise exception 'DRUG_CATALOG_SCOPE_VIOLATION' using errcode = '42501';
      end if;
    end if;
  else
    select l.clinic_id into v_parent_clinic from public.lab_requests l where l.id = new.lab_request_id;
    if new.lab_test_catalog_id is not null then
      select c.clinic_id into v_catalog_clinic from public.lab_test_catalog c where c.id = new.lab_test_catalog_id;
      if v_catalog_clinic is distinct from v_parent_clinic then
        raise exception 'LAB_CATALOG_SCOPE_VIOLATION' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.validate_clinical_catalog_reference() from public;

create or replace function public.validate_catalog_department_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_catalog_clinic uuid;
  v_department_clinic uuid;
begin
  if tg_table_name = 'drug_catalog_departments' then
    select c.clinic_id into v_catalog_clinic from public.drug_catalog c where c.id = new.drug_catalog_id;
  else
    select c.clinic_id into v_catalog_clinic from public.lab_test_catalog c where c.id = new.lab_test_catalog_id;
  end if;
  select d.clinic_id into v_department_clinic from public.departments d where d.id = new.department_id;
  if v_catalog_clinic is null or v_department_clinic is distinct from v_catalog_clinic then
    raise exception 'CATALOG_DEPARTMENT_SCOPE_VIOLATION' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_catalog_department_scope() from public;

create or replace function public.validate_medical_note_appointment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.appointment_id is not null and not exists (
    select 1 from public.appointments a
    join public.patients p on p.id = new.patient_id and p.clinic_id = a.clinic_id
    where a.id = new.appointment_id and a.patient_id = new.patient_id
  ) then
    raise exception 'MEDICAL_NOTE_APPOINTMENT_MISMATCH' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_medical_note_appointment() from public;

create or replace function public.enforce_clinician_credential_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.professional_license_no is distinct from old.professional_license_no
    or new.specialty is distinct from old.specialty
    or new.professional_title is distinct from old.professional_title
    or new.signature_path is distinct from old.signature_path
  then
    if new.role <> 'doctor'::public.user_role and (
      new.professional_license_no is not null or new.specialty is not null
      or new.professional_title is not null or new.signature_path is not null
    ) then
      raise exception 'CLINICIAN_CREDENTIALS_REQUIRE_DOCTOR' using errcode = '23514';
    end if;
    if auth.uid() is not null
      and public.auth_role() <> 'admin'::public.user_role
      and new.id <> auth.uid()
    then
      raise exception 'CLINICIAN_CREDENTIAL_UPDATE_DENIED' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_clinician_credential_update() from public;

create trigger trg_prescriptions_tenant_references
before insert or update on public.prescriptions
for each row execute function public.validate_document_tenant_references();
create trigger trg_lab_requests_tenant_references
before insert or update on public.lab_requests
for each row execute function public.validate_document_tenant_references();
create trigger trg_sick_leaves_tenant_references
before insert or update on public.sick_leaves
for each row execute function public.validate_document_tenant_references();
create trigger trg_prescriptions_lifecycle
before update on public.prescriptions
for each row execute function public.enforce_clinical_record_lifecycle();
create trigger trg_lab_requests_lifecycle
before update on public.lab_requests
for each row execute function public.enforce_clinical_record_lifecycle();
create trigger trg_sick_leaves_lifecycle
before update on public.sick_leaves
for each row execute function public.enforce_clinical_record_lifecycle();
create trigger trg_prescription_medications_draft
before insert or update or delete on public.prescription_medications
for each row execute function public.enforce_clinical_line_item_draft();
create trigger trg_lab_request_tests_draft
before insert or update or delete on public.lab_request_tests
for each row execute function public.enforce_clinical_line_item_draft();
create trigger trg_prescription_medications_catalog
before insert or update on public.prescription_medications
for each row execute function public.validate_clinical_catalog_reference();
create trigger trg_lab_request_tests_catalog
before insert or update on public.lab_request_tests
for each row execute function public.validate_clinical_catalog_reference();
create trigger trg_drug_catalog_departments_scope
before insert or update on public.drug_catalog_departments
for each row execute function public.validate_catalog_department_scope();
create trigger trg_lab_test_catalog_departments_scope
before insert or update on public.lab_test_catalog_departments
for each row execute function public.validate_catalog_department_scope();
create trigger trg_medical_notes_appointment
before insert or update of appointment_id, patient_id on public.medical_notes
for each row execute function public.validate_medical_note_appointment();
create trigger trg_profiles_clinician_credentials
before update of professional_license_no, specialty, professional_title, signature_path on public.profiles
for each row execute function public.enforce_clinician_credential_update();

create trigger trg_drug_catalog_updated_at before update on public.drug_catalog
for each row execute function public.set_updated_at();
create trigger trg_lab_test_catalog_updated_at before update on public.lab_test_catalog
for each row execute function public.set_updated_at();

-- Full row-change audit. Clinical headers and catalogs resolve clinic_id
-- directly; line items use a clinical-specific resolver below.
create or replace function public.write_clinical_child_audit_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_record_id uuid;
  v_parent_id uuid;
  v_clinic_id uuid;
begin
  if tg_table_name = 'prescription_medications' then
    if tg_op = 'DELETE' then
      v_parent_id := old.prescription_id; v_record_id := old.id;
    else
      v_parent_id := new.prescription_id; v_record_id := new.id;
    end if;
    select p.clinic_id into v_clinic_id from public.prescriptions p where p.id = v_parent_id;
  elsif tg_table_name = 'lab_request_tests' then
    if tg_op = 'DELETE' then
      v_parent_id := old.lab_request_id; v_record_id := old.id;
    else
      v_parent_id := new.lab_request_id; v_record_id := new.id;
    end if;
    select l.clinic_id into v_clinic_id from public.lab_requests l where l.id = v_parent_id;
  elsif tg_table_name = 'drug_catalog_departments' then
    if tg_op = 'DELETE' then v_parent_id := old.drug_catalog_id;
    else v_parent_id := new.drug_catalog_id; end if;
    select c.clinic_id into v_clinic_id from public.drug_catalog c where c.id = v_parent_id;
    v_record_id := v_parent_id;
  else
    if tg_op = 'DELETE' then v_parent_id := old.lab_test_catalog_id;
    else v_parent_id := new.lab_test_catalog_id; end if;
    select c.clinic_id into v_clinic_id from public.lab_test_catalog c where c.id = v_parent_id;
    v_record_id := v_parent_id;
  end if;
  insert into public.audit_logs (actor_id, clinic_id, action, table_name, record_id, old_data, new_data)
  values (auth.uid(), v_clinic_id, tg_op, tg_table_name, v_record_id, v_old, v_new);
  return coalesce(new, old);
end;
$$;
revoke all on function public.write_clinical_child_audit_log() from public;

create or replace function public.audit_clinician_credentials()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.professional_license_no is distinct from old.professional_license_no
    or new.specialty is distinct from old.specialty
    or new.professional_title is distinct from old.professional_title
    or new.signature_path is distinct from old.signature_path
  then
    insert into public.audit_logs (actor_id, clinic_id, action, table_name, record_id, old_data, new_data)
    values (
      auth.uid(), new.clinic_id, 'UPDATE', 'profiles.clinician_credentials', new.id,
      jsonb_build_object('professional_license_no', old.professional_license_no, 'specialty', old.specialty,
        'professional_title', old.professional_title, 'signature_path', old.signature_path),
      jsonb_build_object('professional_license_no', new.professional_license_no, 'specialty', new.specialty,
        'professional_title', new.professional_title, 'signature_path', new.signature_path)
    );
  end if;
  return new;
end;
$$;
revoke all on function public.audit_clinician_credentials() from public;

create trigger trg_audit_prescriptions after insert or update or delete on public.prescriptions
for each row execute function public.write_audit_log();
create trigger trg_audit_lab_requests after insert or update or delete on public.lab_requests
for each row execute function public.write_audit_log();
create trigger trg_audit_sick_leaves after insert or update or delete on public.sick_leaves
for each row execute function public.write_audit_log();
create trigger trg_audit_drug_catalog after insert or update or delete on public.drug_catalog
for each row execute function public.write_audit_log();
create trigger trg_audit_lab_test_catalog after insert or update or delete on public.lab_test_catalog
for each row execute function public.write_audit_log();
create trigger trg_audit_prescription_medications after insert or update or delete on public.prescription_medications
for each row execute function public.write_clinical_child_audit_log();
create trigger trg_audit_lab_request_tests after insert or update or delete on public.lab_request_tests
for each row execute function public.write_clinical_child_audit_log();
create trigger trg_audit_drug_catalog_departments after insert or delete on public.drug_catalog_departments
for each row execute function public.write_clinical_child_audit_log();
create trigger trg_audit_lab_test_catalog_departments after insert or delete on public.lab_test_catalog_departments
for each row execute function public.write_clinical_child_audit_log();
create trigger trg_audit_clinician_credentials after update on public.profiles
for each row execute function public.audit_clinician_credentials();

-- RLS helper kept centralized so all three clinical headers and both line-item
-- tables share exactly the same subject visibility rule.
create or replace function public.can_access_clinical_record(
  p_clinic_id uuid,
  p_patient_id uuid,
  p_responsible_doctor_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_clinic_id = public.auth_clinic_id()
    and (
      public.auth_role() = any (array['admin'::public.user_role, 'manager'::public.user_role, 'receptionist'::public.user_role])
      or (
        public.auth_role() = 'doctor'::public.user_role
        and (
          p_responsible_doctor_id = auth.uid()
          or exists (
            select 1 from public.patients p
            where p.id = p_patient_id and p.clinic_id = public.auth_clinic_id() and not p.is_deleted
              and (p.assigned_doctor_id = auth.uid()
                or (public.auth_department_id() is not null and p.department_id = public.auth_department_id()))
          )
        )
      )
      or (
        public.auth_role() = 'assistant'::public.user_role
        and (
          p_responsible_doctor_id = any (public.auth_supervised_doctor_ids())
          or exists (
            select 1 from public.patients p
            where p.id = p_patient_id and p.clinic_id = public.auth_clinic_id() and not p.is_deleted
              and p.assigned_doctor_id = any (public.auth_supervised_doctor_ids())
          )
        )
      )
    );
$$;
revoke all on function public.can_access_clinical_record(uuid, uuid, uuid) from public;
grant execute on function public.can_access_clinical_record(uuid, uuid, uuid) to authenticated, service_role;

alter table public.drug_catalog enable row level security;
alter table public.drug_catalog_departments enable row level security;
alter table public.lab_test_catalog enable row level security;
alter table public.lab_test_catalog_departments enable row level security;
alter table public.prescriptions enable row level security;
alter table public.prescription_medications enable row level security;
alter table public.lab_requests enable row level security;
alter table public.lab_request_tests enable row level security;
alter table public.sick_leaves enable row level security;

create policy drug_catalog_select_clinic on public.drug_catalog for select to authenticated
using (clinic_id = public.auth_clinic_id());
create policy drug_catalog_admin_write on public.drug_catalog for all to authenticated
using (clinic_id = public.auth_clinic_id() and public.auth_role() = 'admin'::public.user_role)
with check (clinic_id = public.auth_clinic_id() and public.auth_role() = 'admin'::public.user_role);
create policy lab_test_catalog_select_clinic on public.lab_test_catalog for select to authenticated
using (clinic_id = public.auth_clinic_id());
create policy lab_test_catalog_admin_write on public.lab_test_catalog for all to authenticated
using (clinic_id = public.auth_clinic_id() and public.auth_role() = 'admin'::public.user_role)
with check (clinic_id = public.auth_clinic_id() and public.auth_role() = 'admin'::public.user_role);

create policy drug_catalog_departments_select_clinic on public.drug_catalog_departments for select to authenticated
using (exists (select 1 from public.drug_catalog c where c.id = drug_catalog_id and c.clinic_id = public.auth_clinic_id()));
create policy drug_catalog_departments_admin_write on public.drug_catalog_departments for all to authenticated
using (public.auth_role() = 'admin'::public.user_role and exists (
  select 1 from public.drug_catalog c where c.id = drug_catalog_id and c.clinic_id = public.auth_clinic_id()))
with check (public.auth_role() = 'admin'::public.user_role and exists (
  select 1 from public.drug_catalog c where c.id = drug_catalog_id and c.clinic_id = public.auth_clinic_id()));
create policy lab_test_catalog_departments_select_clinic on public.lab_test_catalog_departments for select to authenticated
using (exists (select 1 from public.lab_test_catalog c where c.id = lab_test_catalog_id and c.clinic_id = public.auth_clinic_id()));
create policy lab_test_catalog_departments_admin_write on public.lab_test_catalog_departments for all to authenticated
using (public.auth_role() = 'admin'::public.user_role and exists (
  select 1 from public.lab_test_catalog c where c.id = lab_test_catalog_id and c.clinic_id = public.auth_clinic_id()))
with check (public.auth_role() = 'admin'::public.user_role and exists (
  select 1 from public.lab_test_catalog c where c.id = lab_test_catalog_id and c.clinic_id = public.auth_clinic_id()));

create policy prescriptions_select_scoped on public.prescriptions for select to authenticated
using (public.can_access_clinical_record(clinic_id, patient_id, responsible_doctor_id));
create policy prescriptions_insert_scoped on public.prescriptions for insert to authenticated
with check (created_by = auth.uid() and status = 'draft'
  and public.auth_role() = any (array['admin'::public.user_role, 'manager'::public.user_role,
    'receptionist'::public.user_role, 'doctor'::public.user_role, 'assistant'::public.user_role])
  and public.can_access_clinical_record(clinic_id, patient_id, responsible_doctor_id));
create policy prescriptions_update_scoped on public.prescriptions for update to authenticated
using (public.can_access_clinical_record(clinic_id, patient_id, responsible_doctor_id))
with check (public.can_access_clinical_record(clinic_id, patient_id, responsible_doctor_id));
create policy prescriptions_delete_own_draft on public.prescriptions for delete to authenticated
using (clinic_id = public.auth_clinic_id() and created_by = auth.uid() and status = 'draft');

create policy lab_requests_select_scoped on public.lab_requests for select to authenticated
using (public.can_access_clinical_record(clinic_id, patient_id, responsible_doctor_id));
create policy lab_requests_insert_scoped on public.lab_requests for insert to authenticated
with check (created_by = auth.uid() and status = 'draft'
  and public.auth_role() = any (array['admin'::public.user_role, 'manager'::public.user_role,
    'receptionist'::public.user_role, 'doctor'::public.user_role, 'assistant'::public.user_role])
  and public.can_access_clinical_record(clinic_id, patient_id, responsible_doctor_id));
create policy lab_requests_update_scoped on public.lab_requests for update to authenticated
using (public.can_access_clinical_record(clinic_id, patient_id, responsible_doctor_id))
with check (public.can_access_clinical_record(clinic_id, patient_id, responsible_doctor_id));
create policy lab_requests_delete_own_draft on public.lab_requests for delete to authenticated
using (clinic_id = public.auth_clinic_id() and created_by = auth.uid() and status = 'draft');

create policy sick_leaves_select_scoped on public.sick_leaves for select to authenticated
using (public.can_access_clinical_record(clinic_id, patient_id, responsible_doctor_id));
create policy sick_leaves_insert_scoped on public.sick_leaves for insert to authenticated
with check (created_by = auth.uid() and status = 'draft'
  and public.auth_role() = any (array['admin'::public.user_role, 'manager'::public.user_role,
    'receptionist'::public.user_role, 'doctor'::public.user_role, 'assistant'::public.user_role])
  and public.can_access_clinical_record(clinic_id, patient_id, responsible_doctor_id));
create policy sick_leaves_update_scoped on public.sick_leaves for update to authenticated
using (public.can_access_clinical_record(clinic_id, patient_id, responsible_doctor_id))
with check (public.can_access_clinical_record(clinic_id, patient_id, responsible_doctor_id));
create policy sick_leaves_delete_own_draft on public.sick_leaves for delete to authenticated
using (clinic_id = public.auth_clinic_id() and created_by = auth.uid() and status = 'draft');

create policy prescription_medications_select_scoped on public.prescription_medications for select to authenticated
using (exists (select 1 from public.prescriptions p where p.id = prescription_id
  and public.can_access_clinical_record(p.clinic_id, p.patient_id, p.responsible_doctor_id)));
create policy prescription_medications_write_scoped on public.prescription_medications for all to authenticated
using (exists (select 1 from public.prescriptions p where p.id = prescription_id and p.status = 'draft'
  and public.can_access_clinical_record(p.clinic_id, p.patient_id, p.responsible_doctor_id)))
with check (exists (select 1 from public.prescriptions p where p.id = prescription_id and p.status = 'draft'
  and public.can_access_clinical_record(p.clinic_id, p.patient_id, p.responsible_doctor_id)));
create policy lab_request_tests_select_scoped on public.lab_request_tests for select to authenticated
using (exists (select 1 from public.lab_requests l where l.id = lab_request_id
  and public.can_access_clinical_record(l.clinic_id, l.patient_id, l.responsible_doctor_id)));
create policy lab_request_tests_write_scoped on public.lab_request_tests for all to authenticated
using (exists (select 1 from public.lab_requests l where l.id = lab_request_id and l.status = 'draft'
  and public.can_access_clinical_record(l.clinic_id, l.patient_id, l.responsible_doctor_id)))
with check (exists (select 1 from public.lab_requests l where l.id = lab_request_id and l.status = 'draft'
  and public.can_access_clinical_record(l.clinic_id, l.patient_id, l.responsible_doctor_id)));

revoke all on table public.drug_catalog, public.drug_catalog_departments,
  public.lab_test_catalog, public.lab_test_catalog_departments,
  public.prescriptions, public.prescription_medications,
  public.lab_requests, public.lab_request_tests, public.sick_leaves from anon;
grant select, insert, update, delete on table public.drug_catalog, public.drug_catalog_departments,
  public.lab_test_catalog, public.lab_test_catalog_departments,
  public.prescriptions, public.prescription_medications,
  public.lab_requests, public.lab_request_tests, public.sick_leaves to authenticated;
grant all on table public.drug_catalog, public.drug_catalog_departments,
  public.lab_test_catalog, public.lab_test_catalog_departments,
  public.prescriptions, public.prescription_medications,
  public.lab_requests, public.lab_request_tests, public.sick_leaves to service_role;

-- Private clinician signature/stamp assets reuse the established clinic-assets
-- bucket. Administrators can manage clinic staff assets; a doctor can manage
-- only their own signature path.
create policy clinic_assets_select_own_signature
on storage.objects for select to authenticated
using (bucket_id = 'clinic-assets'
  and (storage.foldername(name))[1] = 'staff'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and (storage.foldername(name))[3] = auth.uid()::text
  and (storage.foldername(name))[4] = 'signature');
create policy clinic_assets_insert_own_signature
on storage.objects for insert to authenticated
with check (bucket_id = 'clinic-assets'
  and (storage.foldername(name))[1] = 'staff'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and (storage.foldername(name))[3] = auth.uid()::text
  and (storage.foldername(name))[4] = 'signature'
  and public.auth_role() = 'doctor'::public.user_role);
create policy clinic_assets_update_own_signature
on storage.objects for update to authenticated
using (bucket_id = 'clinic-assets'
  and (storage.foldername(name))[1] = 'staff'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and (storage.foldername(name))[3] = auth.uid()::text
  and (storage.foldername(name))[4] = 'signature'
  and public.auth_role() = 'doctor'::public.user_role)
with check (bucket_id = 'clinic-assets'
  and (storage.foldername(name))[1] = 'staff'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and (storage.foldername(name))[3] = auth.uid()::text
  and (storage.foldername(name))[4] = 'signature'
  and public.auth_role() = 'doctor'::public.user_role);
create policy clinic_assets_delete_own_signature
on storage.objects for delete to authenticated
using (bucket_id = 'clinic-assets'
  and (storage.foldername(name))[1] = 'staff'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and (storage.foldername(name))[3] = auth.uid()::text
  and (storage.foldername(name))[4] = 'signature'
  and public.auth_role() = 'doctor'::public.user_role);

comment on table public.prescriptions is 'P7-6A durable prescription source records; not issued documents.';
comment on table public.lab_requests is 'P7-6A durable laboratory-request source records; not issued documents.';
comment on table public.sick_leaves is 'P7-6A durable sick-leave source records; not issued documents.';
