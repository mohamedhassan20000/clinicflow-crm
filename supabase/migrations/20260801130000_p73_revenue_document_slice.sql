-- P7-3: Revenue Report vertical slice lifecycle read boundaries.
--
-- Issuance/numbering/storage remain owned by P7-0. This migration adds only:
--   1. a strict five-field public verification lookup by opaque token; and
--   2. an authenticated Revenue Report reprint event/count transaction.

create or replace function public.verify_document_token(p_token text)
returns table (
  verification_status text,
  document_number text,
  document_type text,
  issue_date timestamptz,
  clinic_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    case d.status
      when 'issued' then 'valid'
      when 'void' then 'void'
      when 'cancelled' then 'cancelled'
      else 'unavailable'
    end,
    d.document_number,
    d.doc_type,
    d.issued_at,
    c.name
  from public.documents d
  join public.clinics c on c.id = d.clinic_id
  where p_token ~ '^[0-9a-f]{32}$'
    and d.verification_token = p_token
    and d.status = any (array['issued', 'void', 'cancelled'])
  limit 1
$$;
alter function public.verify_document_token(text) owner to postgres;
revoke all on function public.verify_document_token(text) from public;
grant execute on function public.verify_document_token(text) to anon, authenticated;

comment on function public.verify_document_token(text) is
  'Enumeration-resistant public verification boundary. Returns only status, number, type, issue date, and clinic name.';

create or replace function public.record_revenue_document_reprint(
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
  v_role public.user_role := public.auth_role();
  v_document public.documents%rowtype;
  v_print_count integer;
begin
  if v_actor_id is null or v_clinic_id is null or v_role is null then
    raise exception 'DOCUMENT_REPRINT_NOT_AUTHENTICATED' using errcode = '28000';
  end if;
  if v_role <> all (
    array[
      'admin'::public.user_role,
      'manager'::public.user_role,
      'receptionist'::public.user_role
    ]
  ) then
    raise exception 'DOCUMENT_REPRINT_NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select d.* into v_document
  from public.documents d
  where d.id = p_document_id
    and d.clinic_id = v_clinic_id
    and d.doc_type = 'REVENUE_REPORT'
    and d.status = any (array['issued', 'void', 'cancelled'])
  for update;
  if not found then
    raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0002';
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
    v_clinic_id,
    v_document.id,
    'reprinted',
    v_actor_id,
    false,
    jsonb_build_object('print_count', v_print_count)
  );

  return query select
    v_document.pdf_storage_path,
    v_document.document_number,
    v_print_count;
end;
$$;
alter function public.record_revenue_document_reprint(uuid) owner to postgres;
revoke all on function public.record_revenue_document_reprint(uuid) from public, anon;
grant execute on function public.record_revenue_document_reprint(uuid) to authenticated;

comment on function public.record_revenue_document_reprint(uuid) is
  'P7-3 Revenue Report-only canonical reprint transaction. Keeps identity/PDF immutable and appends history.';
