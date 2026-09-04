-- P11S — the Inbox summary RPC stops being O(messages × RLS function calls).
--
-- ## The failure this fixes
--
-- `/inbox` intermittently rendered "The inbox could not be loaded. Please
-- refresh and try again." — `lib/messaging/inbox.ts` returning `error: true`
-- because `get_inbox_conversation_summaries` came back with SQLSTATE 57014,
-- `canceling statement due to statement timeout`. Supabase sets
-- `statement_timeout = 8s` on the `authenticated` role (`service_role` has
-- none), which is why every probe run with the service key looked healthy and
-- the page still failed for the people using it.
--
-- Measured on the production clinic (139 whatsapp conversations, ~5.4k inbound
-- rows) before this migration:
--
--   * as `service_role` (no RLS):      24 ms, 9,110 shared buffers
--   * as `authenticated` (RLS):     6,194 ms, 100,925 shared buffers
--
-- 6.2 s of an 8 s budget, and rising with **every message**, which is exactly
-- why the symptom appeared right after a patient message and an assistant
-- reply: each turn adds rows to the two tables the per-conversation laterals
-- walk, and one turn eventually tips the RPC past the timeout.
--
-- ## Why RLS costs 250×
--
-- The function was `security invoker`, so the three inbox policies
-- (`clinic_id = auth_clinic_id() AND auth_role() = any('{admin,receptionist}')`)
-- were appended to `conversations`, `inbound_messages` *and*
-- `outbound_messages` — including inside the correlated subqueries. The plan
-- shows the cost plainly:
--
--   Index Scan using outbound_messages_related_idx (actual 22.5 ms, loops=65)
--     Filter: (auth_role() = ANY (...)) AND (clinic_id = auth_clinic_id()) ...
--
-- `auth_clinic_id()` and `auth_role()` are STABLE SECURITY DEFINER, so Postgres
-- will not inline them and cannot fold them into an index condition; they are
-- re-evaluated as an ordinary filter for every candidate row of every lateral,
-- once per conversation. The work is quadratic in the thing that grows.
--
-- ## The fix, and why it is not a weakening
--
-- The function becomes `security definer` and resolves the caller's clinic and
-- role **once**, at the top, using the same two helpers the policies use. If
-- the caller is not an active admin or receptionist with a clinic, it returns
-- no rows — the identical outcome the RLS policies produced. Every read below
-- is then explicitly scoped by that one resolved `clinic_id`, so the boundary
-- is stated once in SQL instead of being re-derived per row.
--
-- Authorization is therefore unchanged in what it permits: same two roles, same
-- single clinic, same tables. What changes is how many times the question is
-- asked. This is the pattern the patient-AI RPCs in this schema already use.
--
-- Additive: `create or replace` on one function plus two `if not exists`
-- indexes. No column, table, policy or grant is dropped or widened.

-- The `id` tiebreak the "newest inbound" lateral orders by. Without it the
-- existing (conversation_id, received_at desc) index forces an Incremental Sort
-- on every conversation.
create index if not exists inbound_messages_conversation_recent_idx
  on public.inbound_messages (conversation_id, received_at desc, id desc);

-- The unread cutoff reads max(created_at) of this thread's manual outbound
-- rows. `outbound_messages_related_idx` is (related_type, related_id) only, so
-- the aggregate walked every row of the thread.
create index if not exists outbound_messages_manual_thread_recent_idx
  on public.outbound_messages (related_id, created_at desc)
  where related_type = 'manual'::public.outbound_related_type
    and related_id is not null;

create or replace function public.get_inbox_conversation_summaries(
  p_requested_conversation_id uuid default null,
  p_limit integer default 100,
  p_search text default null
)
returns table (
  id uuid,
  channel public.message_channel,
  status public.conversation_status,
  patient_id uuid,
  participant_address text,
  assigned_to uuid,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  window_expires_at timestamptz,
  preview text,
  unread_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_clinic uuid;
  v_role public.user_role;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 300);
  v_term text := nullif(btrim(coalesce(p_search, '')), '');
begin
  -- The whole authorization boundary, asked once. Identical predicate to
  -- inbox_staff_read_own_conversations / _inbound_messages / _outbound_messages.
  v_clinic := public.auth_clinic_id();
  v_role := public.auth_role();
  if v_clinic is null
     or v_role is null
     or v_role not in ('admin'::public.user_role, 'receptionist'::public.user_role) then
    return;
  end if;

  return query
  with recent as (
    select c.id
    from public.conversations c
    where c.clinic_id = v_clinic
      and c.channel = 'whatsapp'::public.message_channel
      and (
        v_term is null
        or c.participant_address ilike '%' || v_term || '%'
        or c.display_name ilike '%' || v_term || '%'
      )
    order by c.last_message_at desc nulls last, c.created_at desc
    limit v_limit
  ), chosen as (
    select recent.id from recent
    union
    select c.id
    from public.conversations c
    where p_requested_conversation_id is not null
      and c.id = p_requested_conversation_id
      and c.clinic_id = v_clinic
      and c.channel = 'whatsapp'::public.message_channel
  )
  select
    c.id,
    c.channel,
    c.status,
    c.patient_id,
    c.participant_address,
    c.assigned_to,
    c.last_message_at,
    inbound_latest.received_at,
    c.window_expires_at,
    coalesce(latest.body, ''),
    coalesce(unread.count, 0)
  from chosen
  join public.conversations c on c.id = chosen.id and c.clinic_id = v_clinic
  left join lateral (
    select im.received_at
    from public.inbound_messages im
    where im.conversation_id = c.id
      and im.clinic_id = v_clinic
    order by im.received_at desc, im.id desc
    limit 1
  ) inbound_latest on true
  left join lateral (
    select event.body
    from (
      select im.body, im.received_at as occurred_at, im.id
      from public.inbound_messages im
      where im.conversation_id = c.id
        and im.clinic_id = v_clinic
      union all
      -- P8 stores the full sent text on inbox threads; the redacted preview
      -- remains the fallback for rows written before that column existed.
      select coalesce(om.body, om.body_preview, ''), om.created_at, om.id
      from public.outbound_messages om
      where om.related_type = 'manual'::public.outbound_related_type
        and om.related_id = c.id
        and om.clinic_id = v_clinic
    ) event
    order by event.occurred_at desc, event.id desc
    limit 1
  ) latest on true
  left join lateral (
    select count(*)
    from public.inbound_messages im
    where im.conversation_id = c.id
      and im.clinic_id = v_clinic
      and im.received_at > coalesce((
        select max(om.created_at)
        from public.outbound_messages om
        where om.related_type = 'manual'::public.outbound_related_type
          and om.related_id = c.id
          and om.clinic_id = v_clinic
          and om.status in (
            'sent'::public.outbound_message_status,
            'delivered'::public.outbound_message_status,
            'read'::public.outbound_message_status
          )
      ), '-infinity'::timestamptz)
  ) unread on true
  order by c.last_message_at desc nulls last, c.created_at desc;
end;
$$;

comment on function public.get_inbox_conversation_summaries(uuid, integer, text) is
  'P11S — Inbox conversation list. SECURITY DEFINER so the admin/receptionist + clinic check runs once instead of per row inside every lateral; the permitted set is identical to the inbox RLS policies.';

revoke all on function public.get_inbox_conversation_summaries(uuid, integer, text)
  from public, anon;
grant execute on function public.get_inbox_conversation_summaries(uuid, integer, text)
  to authenticated;
