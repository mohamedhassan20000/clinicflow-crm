alter table public.clinic_invitations
  add column if not exists email_sent_at timestamptz;

comment on column public.clinic_invitations.email_sent_at is
  'Last successful branded invitation email send; raw invitation tokens are never stored.';
