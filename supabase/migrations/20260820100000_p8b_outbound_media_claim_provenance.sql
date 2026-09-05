-- P8B follow-up: installations that applied 20260819120000 before the
-- source_record_id return column was added must receive the same send-time
-- document reauthorization contract as fresh installs.

drop function if exists public.claim_outbound_media(uuid, uuid, uuid);

create function public.claim_outbound_media(
  p_clinic_id uuid,
  p_media_id uuid,
  p_conversation_id uuid
)
returns table (
  media_id uuid,
  source text,
  source_record_id uuid,
  media_kind text,
  mime_type text,
  file_name text,
  byte_size integer,
  bucket text,
  storage_path text,
  caption text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.outbound_message_media m
  set status = 'sending'
  where m.id = p_media_id
    and m.clinic_id = p_clinic_id
    and m.conversation_id = p_conversation_id
    and m.status = 'draft'
  returning m.id, m.source, m.source_record_id, m.media_kind, m.mime_type, m.file_name,
            m.byte_size, m.bucket, m.storage_path, m.caption;
end;
$$;

revoke all on function public.claim_outbound_media(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_outbound_media(uuid, uuid, uuid)
  to service_role;
