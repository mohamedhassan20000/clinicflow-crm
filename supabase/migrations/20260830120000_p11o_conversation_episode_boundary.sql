-- P11O — the conversation episode boundary.
--
-- P11N made "Close Thread" forget what the assistant was *doing*
-- (ai_collected_data, ai_pending_clarification, ai_booking_stage, the pending
-- draft). It did not, and could not, forget what the assistant had *said*:
-- lib/ai/patient-reply.ts assembles the model's context by reading the newest
-- inbound_messages/outbound_messages rows for the conversation, unbounded. A
-- closed thread that reopens on the next inbound message therefore handed the
-- model the whole previous exchange verbatim — the department question, the
-- names typed during a previous episode, the half-finished booking prose — and
-- the model dutifully continued it. Clearing the state columns cannot fix that,
-- because the transcript is the context.
--
-- This column is the missing fact: the instant the current episode began.
--
--   * NULL — the thread has never been closed or reset. Every message on it
--     belongs to the current episode, which is the pre-existing behaviour.
--   * A timestamp — messages strictly older than it belong to a finished
--     episode. They stay in the Inbox, in full, forever: this bounds *model
--     context only* and deletes nothing. Human history and assistant memory are
--     two different things, and this column is the line between them.
--
-- Why a dedicated column rather than reusing status_updated_at: that column is
-- moved by every status transition, including the reopen performed inside
-- persist_whatsapp_inbound and any staff reopen from the Inbox, so it cannot
-- distinguish "this episode started here" from "somebody flipped the status".
-- An episode boundary that a status change can silently rewrite is not a
-- boundary. This one is written only by the close/reset path in
-- lib/ai/conversation-reset.ts.
alter table public.conversations
  add column if not exists ai_context_reset_at timestamptz;

comment on column public.conversations.ai_context_reset_at is
  'P11O — start of the current conversation episode. Messages older than this are excluded from assistant model context and never deleted; NULL means no episode boundary has been drawn. Written only by the close/reset path.';
