-- P7 Manual QA: repair issued-document cancellation.
--
-- The original RPC used the nonexistent activity_events.old_state target
-- column. PostgreSQL therefore raised 42703 during the audit insert and rolled
-- the entire transaction back, including the preceding lifecycle update and
-- document_events insert. The actual append-only column is previous_state.

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

  -- Deliberately update lifecycle fields only. Issued identity, snapshot, PDF,
  -- verification token, and original issued timestamp remain immutable.
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
    entity_id, patient_id, doctor_id, previous_state, new_state, metadata
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
