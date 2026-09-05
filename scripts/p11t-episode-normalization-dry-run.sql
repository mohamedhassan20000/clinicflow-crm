-- P11T — the hosted normalization classifier. READ ONLY.
--
-- After P11T, a conversation's resting state is Done: no active episode, no
-- assistant memory, history intact. The hosted database predates that rule and
-- carries a backlog of threads left `open` simply because nothing ever closed
-- them — 139 of them at the time of writing, 100 idle for more than a day.
--
-- Bulk-closing those is a product decision with patient-visible consequences (a
-- closed thread greets on its next message and starts a fresh episode), so this
-- file does not make it. It contains no UPDATE, no DELETE and no INSERT: it
-- classifies, counts, and stops. Executing a normalization is a separate,
-- explicitly approved step.
--
-- The classification is deliberately conservative. Every bucket except the
-- first *preserves*, and anything that does not clearly belong in a bucket
-- lands in `indeterminate_preserve` rather than being swept into
-- `safe_to_mark_done`. The cost of wrongly preserving a thread is that a
-- receptionist sees one stale row; the cost of wrongly closing one is that a
-- patient mid-booking is greeted from scratch and loses their place.
--
--   safe_to_mark_done       — open, idle > 30 days, no escalation, no human
--                             takeover, nothing half-finished, no pending draft.
--   active_or_recent_preserve — anything that moved in the last 24 hours.
--   needs_review_preserve   — escalated, or taken over by a staff member.
--   mid_workflow_preserve   — a booking stage, collected fields, an outstanding
--                             clarification, or a pending AI draft.
--   indeterminate_preserve  — everything else, including the 1–30 day band.

with classified as (
  select
    c.id,
    c.clinic_id,
    case
      when c.status <> 'open'::public.conversation_status then 'already_done'
      when c.ai_escalated_at is not null or c.ai_paused_at is not null
        then 'needs_review_preserve'
      when c.ai_booking_stage is not null
        or coalesce(c.ai_collected_data, '{}'::jsonb) <> '{}'::jsonb
        or c.ai_pending_clarification is not null
        or exists (
          select 1 from public.ai_suggested_replies s
          where s.conversation_id = c.id and s.status = 'pending'
        )
        then 'mid_workflow_preserve'
      when c.last_message_at is null
        then 'indeterminate_preserve'
      when c.last_message_at > now() - interval '24 hours'
        then 'active_or_recent_preserve'
      when c.last_message_at < now() - interval '30 days'
        then 'safe_to_mark_done'
      else 'indeterminate_preserve'
    end as bucket
  from public.conversations c
  where c.channel = 'whatsapp'::public.message_channel
)
select
  bucket,
  count(*) as conversations,
  count(distinct clinic_id) as clinics
from classified
group by bucket
order by conversations desc;
