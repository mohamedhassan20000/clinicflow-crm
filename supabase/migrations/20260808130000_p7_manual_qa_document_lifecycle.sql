-- P7 Manual QA polish: persistent pre-issue drafts and issued cancellation.
--
-- Draft authoring is intentionally kept outside `documents`: that table stays
-- the immutable issuance ledger and continues to allocate identity/numbering
-- only inside the existing issuance RPCs. A successful issue resolves its
-- source draft; it never rewrites the issued snapshot or canonical PDF.

create table if not exists public.document_drafts (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  doc_type text not null,
  status text not null default 'not_issued',
  locale text not null,
  params jsonb not null default '{}'::jsonb,
  patient_id uuid references public.patients(id) on delete restrict,
  staff_id uuid references public.profiles(id) on delete restrict,
  doctor_id uuid references public.profiles(id) on delete restrict,
  appointment_id uuid references public.appointments(id) on delete restrict,
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  issued_document_id uuid unique references public.documents(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  deleted_at timestamptz,
  constraint document_drafts_doc_type_format check (
    doc_type ~ '^[A-Z][A-Z0-9_]{1,63}$'
  ),
  constraint document_drafts_status_check check (
    status = any (array['not_issued', 'issued', 'deleted'])
  ),
  constraint document_drafts_locale_check check (
    locale = any (array['ar', 'en'])
  ),
  constraint document_drafts_params_object check (
    jsonb_typeof(params) = 'object'
  ),
  constraint document_drafts_state_check check (
    (
      status = 'not_issued'
      and issued_document_id is null
      and resolved_at is null
      and deleted_at is null
    )
    or (
      status = 'issued'
      and issued_document_id is not null
      and resolved_at is not null
      and deleted_at is null
    )
    or (
      status = 'deleted'
      and issued_document_id is null
      and resolved_at is not null
      and deleted_at is not null
    )
  )
);

comment on table public.document_drafts is
  'Mutable pre-issue authoring records. Issued identity, snapshots, PDFs, numbering, and lifecycle events remain in documents/document_events.';

create index if not exists document_drafts_clinic_active_idx
  on public.document_drafts (clinic_id, updated_at desc)
  where status = 'not_issued';
create index if not exists document_drafts_clinic_type_active_idx
  on public.document_drafts (clinic_id, doc_type, updated_at desc)
  where status = 'not_issued';
create index if not exists document_drafts_clinic_patient_active_idx
  on public.document_drafts (clinic_id, patient_id, updated_at desc)
  where status = 'not_issued' and patient_id is not null;

create or replace function public.validate_document_draft_tenant_references()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = new.created_by and p.clinic_id = new.clinic_id
  ) or not exists (
    select 1 from public.profiles p
    where p.id = new.updated_by and p.clinic_id = new.clinic_id
  ) then
    raise exception 'DOCUMENT_DRAFT_ACTOR_SCOPE_VIOLATION' using errcode = '42501';
  end if;
  if new.patient_id is not null and not exists (
    select 1 from public.patients p
    where p.id = new.patient_id and p.clinic_id = new.clinic_id
  ) then
    raise exception 'DOCUMENT_DRAFT_PATIENT_SCOPE_VIOLATION' using errcode = '42501';
  end if;
  if new.staff_id is not null and not exists (
    select 1 from public.profiles p
    where p.id = new.staff_id and p.clinic_id = new.clinic_id
  ) then
    raise exception 'DOCUMENT_DRAFT_STAFF_SCOPE_VIOLATION' using errcode = '42501';
  end if;
  if new.doctor_id is not null and not exists (
    select 1 from public.profiles p
    where p.id = new.doctor_id and p.clinic_id = new.clinic_id
  ) then
    raise exception 'DOCUMENT_DRAFT_DOCTOR_SCOPE_VIOLATION' using errcode = '42501';
  end if;
  if new.appointment_id is not null and not exists (
    select 1 from public.appointments a
    where a.id = new.appointment_id and a.clinic_id = new.clinic_id
  ) then
    raise exception 'DOCUMENT_DRAFT_APPOINTMENT_SCOPE_VIOLATION' using errcode = '42501';
  end if;
  if new.issued_document_id is not null and not exists (
    select 1 from public.documents d
    where d.id = new.issued_document_id
      and d.clinic_id = new.clinic_id
      and d.doc_type = new.doc_type
      and d.status = any (array['issued', 'cancelled'])
  ) then
    raise exception 'DOCUMENT_DRAFT_ISSUED_SCOPE_VIOLATION' using errcode = '42501';
  end if;
  return new;
end;
$$;

alter function public.validate_document_draft_tenant_references() owner to postgres;
revoke all on function public.validate_document_draft_tenant_references() from public;

drop trigger if exists trg_document_drafts_tenant_references on public.document_drafts;
create trigger trg_document_drafts_tenant_references
before insert or update on public.document_drafts
for each row execute function public.validate_document_draft_tenant_references();

drop trigger if exists trg_document_drafts_updated_at on public.document_drafts;
create trigger trg_document_drafts_updated_at
before update on public.document_drafts
for each row execute function public.set_updated_at();

alter table public.document_drafts enable row level security;
revoke all on table public.document_drafts from anon, authenticated;
grant select on table public.document_drafts to authenticated;
grant all on table public.document_drafts to service_role;

drop policy if exists "document_drafts_select_scoped" on public.document_drafts;
create policy "document_drafts_select_scoped"
on public.document_drafts
for select
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and status = 'not_issued'
  and (
    public.auth_role() = any (
      array[
        'admin'::public.user_role,
        'manager'::public.user_role,
        'receptionist'::public.user_role
      ]
    )
    or created_by = auth.uid()
    or (
      public.auth_role() = 'doctor'::public.user_role
      and (
        doctor_id = auth.uid()
        or exists (
          select 1 from public.patients p
          where p.id = document_drafts.patient_id
            and p.clinic_id = public.auth_clinic_id()
            and not p.is_deleted
            and (
              p.assigned_doctor_id = auth.uid()
              or (
                public.auth_department_id() is not null
                and p.department_id = public.auth_department_id()
              )
            )
        )
      )
    )
    or (
      public.auth_role() = 'assistant'::public.user_role
      and (
        doctor_id = any (public.auth_supervised_doctor_ids())
        or exists (
          select 1 from public.patients p
          where p.id = document_drafts.patient_id
            and p.clinic_id = public.auth_clinic_id()
            and not p.is_deleted
            and p.assigned_doctor_id = any (public.auth_supervised_doctor_ids())
        )
      )
    )
  )
);

create or replace function public.cancel_issued_document(p_document_id uuid)
returns table (document_id uuid, document_status text, cancelled_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_clinic_id uuid := public.auth_clinic_id();
  v_actor_role public.user_role := public.auth_role();
  v_document public.documents%rowtype;
begin
  if v_actor_id is null
    or v_clinic_id is null
    or v_actor_role is null
    or v_actor_role <> all (
      array[
        'admin'::public.user_role,
        'manager'::public.user_role,
        'receptionist'::public.user_role,
        'doctor'::public.user_role,
        'assistant'::public.user_role
      ]
    ) then
    raise exception 'DOCUMENT_CANCEL_NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select d.* into v_document
  from public.documents d
  where d.id = p_document_id
    and d.clinic_id = v_clinic_id
  for update;

  if not found then
    raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_document.status = 'cancelled' then
    return query select v_document.id, v_document.status, v_document.voided_at;
    return;
  end if;

  if v_document.status <> 'issued' then
    raise exception 'DOCUMENT_CANCEL_STATE_INVALID' using errcode = '55000';
  end if;

  update public.documents d
  set status = 'cancelled',
      voided_by = v_actor_id,
      voided_at = now()
  where d.id = v_document.id
  returning * into v_document;

  insert into public.document_events (
    clinic_id, document_id, event, actor_id, is_system, metadata
  ) values (
    v_clinic_id, v_document.id, 'cancelled', v_actor_id, false,
    jsonb_build_object('previous_status', 'issued')
  );

  insert into public.activity_events (
    clinic_id, actor_id, actor_role, is_system, action, entity_type,
    entity_id, patient_id, doctor_id, old_state, new_state, metadata
  ) values (
    v_clinic_id, v_actor_id, v_actor_role, false, 'document.cancelled',
    'document', v_document.id, v_document.patient_id, v_document.doctor_id,
    jsonb_build_object('status', 'issued'),
    jsonb_build_object('status', 'cancelled'),
    jsonb_build_object(
      'doc_type', v_document.doc_type,
      'document_number', v_document.document_number
    )
  );

  return query select v_document.id, v_document.status, v_document.voided_at;
end;
$$;

alter function public.cancel_issued_document(uuid) owner to postgres;
revoke all on function public.cancel_issued_document(uuid) from public, anon;
grant execute on function public.cancel_issued_document(uuid) to authenticated;

comment on function public.cancel_issued_document(uuid) is
  'Transitions only issued documents to cancelled, retaining the immutable snapshot/PDF/number and appending lifecycle + activity audit events.';
