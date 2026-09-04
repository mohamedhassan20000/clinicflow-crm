-- READ-ONLY P11R WhatsApp legacy-history audit.
-- This file contains SELECT/CTE statements only. It never deletes, updates, or
-- marks a conversation. Run with service-role read access and review every
-- preserve class before drafting any separately approved cleanup migration.

with
history_events as (
  select
    batch.clinic_id,
    event ->> 'kind' as kind,
    event ->> 'providerMessageId' as provider_message_id,
    coalesce(
      event ->> 'sender',
      event ->> 'recipient',
      event ->> 'participant'
    ) as participant,
    case
      when event ->> 'kind' = 'inbound' then event ->> 'receivedAt'
      when event ->> 'kind' in ('outbound_echo', 'history_pending_message') then event ->> 'occurredAt'
      else event ->> 'lastMessageAt'
    end as occurred_at
  from public.whatsapp_history_delivery_batches batch
  cross join lateral jsonb_array_elements(batch.payload) event
),
boundaries as (
  -- `created_at` is the conservative pre-migration fallback and keeps this
  -- report runnable before the additive boundary migration is applied.
  select clinic_id, created_at as inbound_active_from
  from public.whatsapp_linked_device_sessions
),
classified as (
  select
    conversation.id,
    conversation.clinic_id,
    case
      when conversation.patient_id is not null then 'preserve_linked_patient'
      when exists (
        select 1 from public.ai_patient_intakes intake
        where intake.conversation_id = conversation.id
      ) or exists (
        select 1 from public.ai_appointment_requests request
        where request.conversation_id = conversation.id
      ) or exists (
        select 1 from public.bulk_message_recipients recipient
        where recipient.conversation_id = conversation.id
      ) or exists (
        select 1 from public.appointments appointment
        where appointment.ai_patient_conversation_id = conversation.id
      ) or exists (
        select 1 from public.audit_logs audit
        where audit.clinic_id = conversation.clinic_id
          and audit.table_name = 'conversations'
          -- `audit_logs.record_id` is uuid; `platform_audit_logs.target_id` is text.
          and audit.record_id = conversation.id
      ) or exists (
        select 1 from public.platform_audit_logs audit
        where audit.clinic_id = conversation.clinic_id
          and audit.target_type in ('conversation', 'conversations')
          and audit.target_id = conversation.id::text
      ) then 'preserve_domain_or_audit_reference'
      when exists (
        select 1
        from public.inbound_messages inbound
        left join history_events history
          on history.clinic_id = inbound.clinic_id
         and history.provider_message_id = inbound.provider_message_id
         and history.kind = 'inbound'
        left join boundaries boundary on boundary.clinic_id = inbound.clinic_id
        where inbound.conversation_id = conversation.id
          and (
            history.provider_message_id is null
            or inbound.received_at >= boundary.inbound_active_from
          )
      ) then 'preserve_live_or_post_boundary_inbound'
      when exists (
        select 1
        from public.outbound_messages outbound
        left join history_events history
          on history.clinic_id = outbound.clinic_id
         and history.provider_message_id = outbound.provider_message_id
         and history.kind = 'outbound_echo'
        left join boundaries boundary on boundary.clinic_id = outbound.clinic_id
        where outbound.clinic_id = conversation.clinic_id
          and outbound.recipient = conversation.participant_address
          and (
            history.provider_message_id is null
            or outbound.created_at >= boundary.inbound_active_from
          )
      ) then 'preserve_clinicflow_outbound'
      when exists (
        select 1 from history_events history
        where history.clinic_id = conversation.clinic_id
          and history.participant = trim(leading '+' from conversation.participant_address)
      ) then 'legacy_history_only_safe_candidate'
      else 'indeterminate_preserve'
    end as cleanup_class
  from public.conversations conversation
  where conversation.channel = 'whatsapp'
)
select cleanup_class, count(*)::bigint as conversations
from classified
group by cleanup_class
order by cleanup_class;

-- Candidate-dependent counts. These rows are reported, never changed. Each
-- count is independent so inbound/outbound joins cannot multiply one another.
with candidates as (
  -- Paste ids from the reviewed `legacy_history_only_safe_candidate` result,
  -- or replace this empty SELECT with the exact reviewed classifier CTE above.
  select null::uuid as id where false
)
select
  (
    select count(*) from public.inbound_messages inbound
    where exists (select 1 from candidates candidate where candidate.id = inbound.conversation_id)
  ) as inbound_rows,
  (
    select count(*)
    from public.outbound_messages outbound
    join public.conversations conversation
      on conversation.clinic_id = outbound.clinic_id
     and conversation.participant_address = outbound.recipient
    where exists (select 1 from candidates candidate where candidate.id = conversation.id)
  ) as outbound_rows,
  (
    select count(*)
    from candidates candidate
    join public.conversations conversation on conversation.id = candidate.id
    where not exists (
      select 1 from public.inbound_messages inbound
      where inbound.conversation_id = candidate.id
    )
      and not exists (
        select 1 from public.outbound_messages outbound
        where outbound.clinic_id = conversation.clinic_id
          and outbound.recipient = conversation.participant_address
      )
  ) as empty_threads;
