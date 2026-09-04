-- P8E — allow already-validated inbound WhatsApp audio into private storage.
--
-- P8D taught the worker and attachment table about audio, but the original P8
-- bucket allow-list still admitted images/documents only. A live PTT therefore
-- downloaded and sniffed successfully, then failed at Storage with a non-empty
-- audio buffer. Keep the bucket private and extend only its MIME backstop.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'whatsapp-inbound',
  'whatsapp-inbound',
  false,
  16777216,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
    'image/heif',
    'application/pdf',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'audio/aac',
    'audio/flac',
    'audio/mp4',
    'audio/mpeg',
    'audio/ogg',
    'audio/wav',
    'audio/webm'
  ]::text[]
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
