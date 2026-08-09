-- P7-6: canonical reprint transaction for persisted clinical documents.

create or replace function public.record_clinical_document_reprint(
  p_document_id uuid
)
returns table (
  pdf_storage_path text,
  document_number text,
  print_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid := public.auth_clinic_id();
  v_actor_id uuid := auth.uid();
  v_document public.documents%rowtype;
  v_print_count integer;
begin
  if v_actor_id is null or v_clinic_id is null or public.auth_role() is null then
    raise exception 'DOCUMENT_REPRINT_NOT_AUTHENTICATED' using errcode = '28000';
  end if;

  select d.* into v_document
  from public.documents d
  where d.id = p_document_id
    and d.clinic_id = v_clinic_id
    and d.doc_type = any (array[
      'PRESCRIPTION', 'LAB_REQUEST', 'SICK_LEAVE_CERTIFICATE'
    ])
    and d.status = any (array['issued', 'void', 'cancelled'])
  for update;
  if not found then
    raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not public.can_access_clinical_record(
    v_document.clinic_id,
    v_document.patient_id,
    v_document.doctor_id
  ) then
    raise exception 'DOCUMENT_REPRINT_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if v_document.pdf_storage_path is null then
    raise exception 'DOCUMENT_PDF_UNAVAILABLE' using errcode = '55000';
  end if;

  update public.documents d
  set print_count = d.print_count + 1
  where d.id = v_document.id
  returning d.print_count into v_print_count;

  insert into public.document_events (
    clinic_id, document_id, event, actor_id, is_system, metadata
  ) values (
    v_clinic_id, v_document.id, 'reprinted', v_actor_id, false,
    jsonb_build_object('print_count', v_print_count)
  );

  return query select v_document.pdf_storage_path, v_document.document_number, v_print_count;
end;
$$;

alter function public.record_clinical_document_reprint(uuid) owner to postgres;
revoke all on function public.record_clinical_document_reprint(uuid) from public, anon;
grant execute on function public.record_clinical_document_reprint(uuid) to authenticated;

comment on function public.record_clinical_document_reprint(uuid) is
  'P7-6 canonical reprint transaction restricted to the three approved persisted clinical document types.';
