-- The WhatsApp account boundary is an *identity* fact, not a transport fact.
--
-- ## The defect
--
-- Both the Inbox list RPC (`get_inbox_conversation_summaries`, 2026-09-07) and
-- the five restrictive RLS policies (via `whatsapp_linked_device_active()`,
-- 2026-09-09) choose which WhatsApp account's conversations a clinic may see by
-- asking:
--
--   exists (select 1 from public.clinic_channels cc
--           where ... provider = 'linked_device' and status = 'active')
--
-- That row is the clinic's *transport*. It is deleted by the worker's teardown
-- (`Store.removeChannel`, reached from `SessionManager.tearDown` on
-- `loggedOut` / `badSession` / exhausted pairing) and by
-- `disconnectLinkedDeviceSession`, and it is briefly re-written as `pending`
-- by `Store.activateChannel` on every re-pair before
-- `activate_whatsapp_provider` restores `active`.
--
-- So the moment the linked device goes away — for any reason, including one
-- that lasts a minute — the predicate flips to false, the CASE falls to its
-- `else whatsapp_account_id is null` branch, and the Inbox stops showing the
-- clinic's ~3 live threads and starts showing every legacy NULL-scoped
-- conversation the clinic ever imported. Reconnecting flips it back. That is
-- the reported regression, and it is a *boundary* change caused by a
-- *connection* change.
--
-- ## The rule this migration installs instead
--
-- The boundary is the clinic's last proved WhatsApp identity, which survives
-- every disconnect:
--
--   1. `whatsapp_linked_device_sessions.authenticated_account_id` — the Baileys
--      PN JID the worker proved and bound. `clinic_id` is unique there, it is
--      only ever written by `bind_whatsapp_linked_account`, and nothing on any
--      disconnect path clears it.
--   2. Failing that, the most recently seen row in
--      `whatsapp_linked_accounts` — the durable per-clinic account ledger the
--      same 2026-09-07 migration created.
--
-- If either yields an account, that account is the scope, connected or not.
--
-- If neither does, the clinic has no proved identity. It then matters whether
-- it has ever *tried* to have one: a clinic that holds a `linked_device`
-- channel row in any state is mid-pairing and fails closed (unchanged from
-- 2026-09-09 — the comparison against NULL yields NULL and a restrictive policy
-- admits only TRUE). A clinic with no linked-device channel and no account
-- ledger genuinely has no linked-account boundary, and only that clinic reads
-- the legacy NULL scope.
--
-- Consequences, stated so they can be tested:
--   * connected A -> disconnected A -> reconnected A shows the identical set.
--   * re-pairing as B moves the boundary to B the moment B is bound, and A's
--     conversations become invisible. Nothing is rewritten either way.
--   * a temporary offline never exposes legacy NULL rows.
--   * no clinic ever sees another account's rows, historical or current.
--
-- Additive only: no data read, written, backfilled or deleted; no table, column
-- or constraint altered. `current_whatsapp_linked_account_id()` and
-- `whatsapp_linked_device_active()` are left in place untouched — they describe
-- the live session and the live transport, which are still true things — but
-- nothing that decides an account boundary calls them any more.

-- ---------------------------------------------------------------------------
-- The boundary account
-- ---------------------------------------------------------------------------

create or replace function public.current_whatsapp_account_boundary()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.authenticated_account_id
       from public.whatsapp_linked_device_sessions s
      where s.clinic_id = public.auth_clinic_id()),
    (select a.authenticated_account_id
       from public.whatsapp_linked_accounts a
      where a.clinic_id = public.auth_clinic_id()
      order by a.last_seen_at desc, a.first_linked_at desc, a.authenticated_account_id
      limit 1)
  );
$$;

comment on function public.current_whatsapp_account_boundary() is
  'The calling staff member''s clinic''s WhatsApp account boundary: the account identity last proved for it, independent of whether a socket, session or channel is currently up. Clinic comes from auth_clinic_id(), never from an argument. Exposes no credential, no session state and no channel row.';

revoke all on function public.current_whatsapp_account_boundary() from public, anon;
grant execute on function public.current_whatsapp_account_boundary()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Whether a boundary applies at all
-- ---------------------------------------------------------------------------

create or replace function public.whatsapp_account_boundary_required()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_whatsapp_account_boundary() is not null
    or exists (
      select 1
      from public.clinic_channels cc
      where cc.clinic_id = public.auth_clinic_id()
        and cc.channel = 'whatsapp'::public.message_channel
        and cc.provider = 'linked_device'::public.messaging_provider
    );
$$;

comment on function public.whatsapp_account_boundary_required() is
  'Does this clinic have a linked-account boundary at all? True once an account has ever been proved for it, and also while a linked-device channel row exists in any state (mid-pairing fails closed rather than falling back to legacy rows). Only a clinic for which both are false reads the legacy NULL scope.';

revoke all on function public.whatsapp_account_boundary_required() from public, anon;
grant execute on function public.whatsapp_account_boundary_required()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The five restrictive policies, re-pointed at the identity helpers
-- ---------------------------------------------------------------------------
-- Byte-identical to 2026-09-09 apart from the two helper names.

drop policy if exists "whatsapp_account_isolation_conversations" on public.conversations;
create policy "whatsapp_account_isolation_conversations"
on public.conversations as restrictive for select to authenticated
using (
  channel <> 'whatsapp'::public.message_channel
  or case when public.whatsapp_account_boundary_required()
    then whatsapp_account_id = public.current_whatsapp_account_boundary()
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
      or case when public.whatsapp_account_boundary_required()
        then c.whatsapp_account_id = public.current_whatsapp_account_boundary()
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
        or case when public.whatsapp_account_boundary_required()
          then c.whatsapp_account_id = public.current_whatsapp_account_boundary()
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
      or case when public.whatsapp_account_boundary_required()
        then c.whatsapp_account_id = public.current_whatsapp_account_boundary()
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
      or case when public.whatsapp_account_boundary_required()
        then c.whatsapp_account_id = public.current_whatsapp_account_boundary()
        else c.whatsapp_account_id is null end
    )
));

-- The contact directory is the same boundary. Previously it compared against
-- `current_whatsapp_linked_account_id()` directly, which is NULL-safe but goes
-- empty for a clinic whose session row has not yet been re-bound; the ledger
-- fallback keeps the address book stable across a re-pair of the same number.
drop policy if exists "inbox_staff_read_whatsapp_contacts" on public.whatsapp_contacts;
create policy "inbox_staff_read_whatsapp_contacts"
on public.whatsapp_contacts for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (array['admin'::public.user_role, 'receptionist'::public.user_role])
  and authenticated_account_id = public.current_whatsapp_account_boundary()
);

-- ---------------------------------------------------------------------------
-- The Inbox list RPC
-- ---------------------------------------------------------------------------
-- Identical to 2026-09-07 except for how `v_linked` / `v_account` are resolved.
-- The projection, the search, the limit, the laterals and the ordering are
-- unchanged.

create or replace function public.get_inbox_conversation_summaries(
  p_requested_conversation_id uuid default null,
  p_limit integer default 100,
  p_search text default null
)
returns table (
  id uuid, channel public.message_channel, status public.conversation_status,
  patient_id uuid, participant_address text, assigned_to uuid,
  last_message_at timestamptz, last_inbound_at timestamptz,
  window_expires_at timestamptz, preview text, unread_count bigint
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_clinic uuid;
  v_role public.user_role;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 300);
  v_term text := nullif(btrim(coalesce(p_search, '')), '');
  v_linked boolean := false;
  v_account text;
begin
  v_clinic := public.auth_clinic_id();
  v_role := public.auth_role();
  if v_clinic is null or v_role is null
     or v_role not in ('admin'::public.user_role, 'receptionist'::public.user_role) then return; end if;

  -- The boundary, from identity rather than from the transport. Resolved here
  -- against `v_clinic` rather than by calling the helpers, because this
  -- function is already SECURITY DEFINER and re-entering auth_clinic_id() per
  -- helper buys nothing; the rule is the same one, stated once.
  select coalesce(
      (select s.authenticated_account_id
         from public.whatsapp_linked_device_sessions s where s.clinic_id = v_clinic),
      (select a.authenticated_account_id
         from public.whatsapp_linked_accounts a
        where a.clinic_id = v_clinic
        order by a.last_seen_at desc, a.first_linked_at desc, a.authenticated_account_id
        limit 1))
    into v_account;
  v_linked := v_account is not null
    or exists (select 1 from public.clinic_channels cc
        where cc.clinic_id = v_clinic
          and cc.channel = 'whatsapp'::public.message_channel
          and cc.provider = 'linked_device'::public.messaging_provider);
  -- A clinic that is pairing but has proved no account yet is fail-closed. It
  -- must not be shown the legacy scope as a consolation.
  if v_linked and v_account is null then return; end if;

  return query
  with recent as (
    select c.id from public.conversations c
    where c.clinic_id = v_clinic and c.channel = 'whatsapp'::public.message_channel
      and (case when v_linked then c.whatsapp_account_id = v_account
                else c.whatsapp_account_id is null end)
      and (v_term is null or c.participant_address ilike '%' || v_term || '%'
           or c.display_name ilike '%' || v_term || '%')
    order by c.last_message_at desc nulls last, c.created_at desc limit v_limit
  ), chosen as (
    select recent.id from recent
    union
    select c.id from public.conversations c
    where p_requested_conversation_id is not null and c.id = p_requested_conversation_id
      and c.clinic_id = v_clinic and c.channel = 'whatsapp'::public.message_channel
      and (case when v_linked then c.whatsapp_account_id = v_account
                else c.whatsapp_account_id is null end)
  )
  select c.id, c.channel, c.status, c.patient_id, c.participant_address,
    c.assigned_to, c.last_message_at, inbound_latest.received_at,
    c.window_expires_at, coalesce(latest.body, ''), coalesce(unread.count, 0)
  from chosen join public.conversations c on c.id = chosen.id and c.clinic_id = v_clinic
  left join lateral (
    select im.received_at from public.inbound_messages im
    where im.conversation_id = c.id and im.clinic_id = v_clinic
    order by im.received_at desc, im.id desc limit 1
  ) inbound_latest on true
  left join lateral (
    select event.body from (
      select im.body, im.received_at occurred_at, im.id from public.inbound_messages im
      where im.conversation_id = c.id and im.clinic_id = v_clinic
      union all
      select coalesce(om.body, om.body_preview, ''), om.created_at, om.id
      from public.outbound_messages om
      where om.related_type = 'manual'::public.outbound_related_type
        and om.related_id = c.id and om.clinic_id = v_clinic
    ) event order by event.occurred_at desc, event.id desc limit 1
  ) latest on true
  left join lateral (
    select count(*) from public.inbound_messages im
    where im.conversation_id = c.id and im.clinic_id = v_clinic
      and im.received_at > coalesce((select max(om.created_at)
        from public.outbound_messages om
        where om.related_type = 'manual'::public.outbound_related_type
          and om.related_id = c.id and om.clinic_id = v_clinic
          and om.status in ('sent'::public.outbound_message_status,
            'delivered'::public.outbound_message_status,
            'read'::public.outbound_message_status)), '-infinity'::timestamptz)
  ) unread on true
  order by c.last_message_at desc nulls last, c.created_at desc;
end;
$$;

revoke all on function public.get_inbox_conversation_summaries(uuid, integer, text)
  from public, anon;
grant execute on function public.get_inbox_conversation_summaries(uuid, integer, text)
  to authenticated;

comment on function public.get_inbox_conversation_summaries(uuid, integer, text) is
  'Inbox list restricted to the clinic''s proved WhatsApp account boundary, which is identity state and does not change when the linked device disconnects. Ambiguous legacy rows are never attributed.';
