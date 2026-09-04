-- P11P — allow already-validated inbound WhatsApp video into private storage.
--
-- P8E extended the bucket's MIME backstop to audio. Video was classified
-- correctly by the worker but refused before download by explicit policy, so it
-- never reached Storage and never needed an allow-list entry. That policy is now
-- lifted: a `videoMessage` is downloaded, size-capped and byte-sniffed exactly
-- like every other kind, and must therefore be admitted here too.
--
-- The bucket stays private and the size limit is unchanged. Only the MIME
-- backstop grows, and only by the four containers WhatsApp clients produce —
-- each of which the worker additionally requires the sender's own claim to
-- agree with before it is stored.

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
    'audio/webm',
    'video/mp4',
    'video/3gpp',
    'video/quicktime',
    'video/webm'
  ]::text[]
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
