-- P11R: historical sync may enrich linked-device identity, but only WhatsApp
-- activity at/after ClinicFlow's durable epoch may enter the normal Inbox.

alter table public.whatsapp_linked_device_sessions
  add column if not exists inbound_active_from timestamptz;

-- Existing clinics keep all already-accepted ClinicFlow activity. Their
-- session creation time is the most conservative recoverable first boundary;
-- reconnects never rewrite it.
update public.whatsapp_linked_device_sessions
set inbound_active_from = created_at
where inbound_active_from is null;

comment on column public.whatsapp_linked_device_sessions.inbound_active_from is
  'Immutable first successful ClinicFlow linked-device epoch; history before it cannot create Inbox activity.';

alter table public.inbound_messages
  add column if not exists ingestion_origin text not null default 'live';

alter table public.inbound_messages
  drop constraint if exists inbound_messages_ingestion_origin_check;

alter table public.inbound_messages
  add constraint inbound_messages_ingestion_origin_check
  check (ingestion_origin in ('live', 'history_sync'));

comment on column public.inbound_messages.ingestion_origin is
  'Audit provenance for live traffic versus admitted post-boundary history sync; old rows default conservatively to live.';
