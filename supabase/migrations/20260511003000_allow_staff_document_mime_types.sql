-- Allow the staff document formats that the app validates under
-- clinic-assets/staff/... without changing storage object RLS.
update storage.buckets
set allowed_mime_types = array[
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]::text[]
where id = 'clinic-assets';
