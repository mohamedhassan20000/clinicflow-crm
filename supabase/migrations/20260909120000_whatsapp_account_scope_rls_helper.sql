-- WhatsApp account-isolation RLS boundary fix.
--
-- ## The defect
--
-- 20260907120000_whatsapp_linked_account_isolation.sql added five *restrictive*
-- SELECT policies whose account branch is chosen by an inline probe:
--
--   exists (select 1 from public.clinic_channels cc where cc.clinic_id = ...)
--
-- A policy's subquery is planned as the *querying* role. `clinic_channels` has
-- RLS enabled and, by design (20260717090000), no policy at all — deny-all for
-- `authenticated`, because it holds channel credentials. So for every staff
-- session that EXISTS is unconditionally false, the CASE falls to its
-- `else whatsapp_account_id is null` branch, and every row belonging to the
-- clinic's *live* linked-device account is invisible to authenticated reads.
--
-- The Inbox list never noticed, because it comes from
-- `get_inbox_conversation_summaries` — a SECURITY DEFINER RPC that *can* read
-- `clinic_channels` and therefore takes the correct branch. That split-brain is
-- the single root cause behind the thread/message, media/attachment, Past
-- Appointments and `loadInboxData` conversation-metadata symptoms.
--
-- ## The fix
--
-- The unreachable EXISTS is replaced by one SECURITY DEFINER helper that
-- publishes only the boundary fact RLS actually needs: does the caller's own
-- clinic currently have an active linked-device WhatsApp channel? It is a
-- zero-argument strict boolean. It takes no clinic argument — the clinic is
-- always `public.auth_clinic_id()` — so it cannot be aimed at another tenant,
-- and it returns no credential, no sender identity, no `clinic_channels` row
-- and no session state. `clinic_channels` remains unreadable to `authenticated`.
--
-- The account id itself continues to come from the helper the original
-- migration already created and already granted to `authenticated`,
-- `public.current_whatsapp_linked_account_id()`. Nothing about it changes here.
--
-- Everything else in each policy is byte-identical to 2026-09-07. The rule is
-- preserved exactly, and it is the same rule `get_inbox_conversation_summaries`
-- applies:
--   * linked-device channel active -> only that exact account's rows;
--   * linked-device active but no proved Baileys identity -> nothing. The
--     comparison against a NULL account yields NULL, and a restrictive policy
--     admits only TRUE, so the scope is closed rather than widened;
--   * no linked-device channel -> the legacy NULL scope, exactly as before.
-- Legacy NULL rows are never adopted into a linked account and never rewritten.
--
-- Additive only: no data is read, written, backfilled or deleted, and no table,
-- column or constraint is altered.
--
-- Both helpers are zero-argument, so the planner folds them per query rather
-- than per row — the same shape, and the same cost, as the expression they
-- replace.

-- ---------------------------------------------------------------------------
-- The boundary fact
-- ---------------------------------------------------------------------------

create or replace function public.whatsapp_linked_device_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.clinic_channels cc
    where cc.clinic_id = public.auth_clinic_id()
      and cc.channel = 'whatsapp'::public.message_channel
      and cc.provider = 'linked_device'::public.messaging_provider
      and cc.status = 'active'::public.clinic_channel_status
  );
$$;

comment on function public.whatsapp_linked_device_active() is
  'RLS boundary fact: does the calling staff member''s own clinic have an active linked-device WhatsApp channel? The clinic is taken from auth_clinic_id(), never from an argument. Exposes no credentials, sender identity, clinic_channels row or session state, so authenticated RLS can select the correct account branch while clinic_channels stays deny-all.';

revoke all on function public.whatsapp_linked_device_active() from public, anon;
grant execute on function public.whatsapp_linked_device_active()
  to authenticated, service_role;

-- `clinic_channels` deliberately keeps zero policies. Restated so a future
-- reader does not "fix" the deny-all by granting staff a read: the helper above
-- is the supported way to reach this one boundary fact.
alter table public.clinic_channels enable row level security;

-- ---------------------------------------------------------------------------
-- Re-create the five affected policies against the helper
-- ---------------------------------------------------------------------------
-- Each is a like-for-like replacement of the unreachable EXISTS. The table,
-- channel and join conditions are unchanged.

drop policy if exists "whatsapp_account_isolation_conversations" on public.conversations;
create policy "whatsapp_account_isolation_conversations"
on public.conversations as restrictive for select to authenticated
using (
  channel <> 'whatsapp'::public.message_channel
  or case when public.whatsapp_linked_device_active()
    then whatsapp_account_id = public.current_whatsapp_linked_account_id()
    else whatsapp_account_id is null end
);

drop policy if exists "whatsapp_account_isolation_inbound_messages" on public.inbound_messages;
create policy "whatsapp_account_isolation_inbound_messages"
on public.inbound_messages as restrictive for select to authenticated
using (exists (
  select 1 from public.conversations c
  where c.id = inbound_messages.conversation_id
    and c.clinic_id = inbound_messages.clinic_id
    and (
      c.channel <> 'whatsapp'::public.message_channel
      or case when public.whatsapp_linked_device_active()
        then c.whatsapp_account_id = public.current_whatsapp_linked_account_id()
        else c.whatsapp_account_id is null end
    )
));

drop policy if exists "whatsapp_account_isolation_outbound_messages" on public.outbound_messages;
create policy "whatsapp_account_isolation_outbound_messages"
on public.outbound_messages as restrictive for select to authenticated
using (
  related_type <> 'manual'::public.outbound_related_type
  or exists (
    select 1 from public.conversations c
    where c.id = outbound_messages.related_id
      and c.clinic_id = outbound_messages.clinic_id
      and (
        c.channel <> 'whatsapp'::public.message_channel
        or case when public.whatsapp_linked_device_active()
          then c.whatsapp_account_id = public.current_whatsapp_linked_account_id()
          else c.whatsapp_account_id is null end
      )
  )
);

drop policy if exists "whatsapp_account_isolation_inbound_attachments" on public.inbound_message_attachments;
create policy "whatsapp_account_isolation_inbound_attachments"
on public.inbound_message_attachments as restrictive for select to authenticated
using (exists (
  select 1 from public.inbound_messages im
  join public.conversations c on c.id = im.conversation_id and c.clinic_id = im.clinic_id
  where im.id = inbound_message_attachments.inbound_message_id
    and im.clinic_id = inbound_message_attachments.clinic_id
    and (
      c.channel <> 'whatsapp'::public.message_channel
      or case when public.whatsapp_linked_device_active()
        then c.whatsapp_account_id = public.current_whatsapp_linked_account_id()
        else c.whatsapp_account_id is null end
    )
));

drop policy if exists "whatsapp_account_isolation_outbound_media" on public.outbound_message_media;
create policy "whatsapp_account_isolation_outbound_media"
on public.outbound_message_media as restrictive for select to authenticated
using (exists (
  select 1 from public.conversations c
  where c.id = outbound_message_media.conversation_id
    and c.clinic_id = outbound_message_media.clinic_id
    and (
      c.channel <> 'whatsapp'::public.message_channel
      or case when public.whatsapp_linked_device_active()
        then c.whatsapp_account_id = public.current_whatsapp_linked_account_id()
        else c.whatsapp_account_id is null end
    )
));
