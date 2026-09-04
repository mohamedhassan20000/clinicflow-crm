-- P8D — preserve inbound WhatsApp audio/PTT classification.
--
-- `media_kind = 'audio'` remains the coarse, backward-compatible kind used by
-- existing readers. These two columns retain the distinction WhatsApp puts on
-- `audioMessage`: PTT voice notes versus ordinary audio files, plus the duration
-- carried by the stanza. No enum/check expansion is needed.

alter table public.inbound_message_attachments
  add column if not exists voice_note boolean not null default false,
  add column if not exists duration_seconds integer;

alter table public.inbound_message_attachments
  drop constraint if exists inbound_message_attachments_voice_note_kind_check,
  add constraint inbound_message_attachments_voice_note_kind_check
    check (not voice_note or media_kind = 'audio') not valid,
  drop constraint if exists inbound_message_attachments_duration_check,
  add constraint inbound_message_attachments_duration_check
    check (
      duration_seconds is null
      or duration_seconds between 0 and 604800
    ) not valid;

-- Older P8 history imports already used the unambiguous voice marker and audio
-- kind, but had nowhere to retain the PTT flag. Repair only that exact shape;
-- ordinary audio and ambiguous legacy rows remain `voice_note = false`.
update public.inbound_message_attachments attachment
set voice_note = true
from public.inbound_messages message
where message.id = attachment.inbound_message_id
  and message.clinic_id = attachment.clinic_id
  and attachment.media_kind = 'audio'
  and message.body = '[voice message]';

alter table public.inbound_message_attachments
  validate constraint inbound_message_attachments_voice_note_kind_check;
alter table public.inbound_message_attachments
  validate constraint inbound_message_attachments_duration_check;

