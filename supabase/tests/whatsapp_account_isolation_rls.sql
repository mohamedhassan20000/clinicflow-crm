-- Behavioural proof of the WhatsApp account-isolation RLS boundary.
--
-- Run against a database with every migration applied, as a superuser:
--
--   docker exec -i supabase_db_<project> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/whatsapp_account_isolation_rls.sql
--
-- Everything happens inside one transaction that is rolled back at the end, so
-- the script leaves no rows behind and can be run repeatedly.
--
-- The whole point is that these are *executed* checks, not assertions about SQL
-- text. Each one sets a real `authenticated` session with a real JWT claim and
-- reads through RLS exactly as the application does. The static test in
-- tests/unit/db/ guards the shape of the migration; this guards its behaviour.

\set ON_ERROR_STOP on
begin;

-- ---------------------------------------------------------------------------
-- Fixtures: two clinics, one of which has re-paired to a second WhatsApp
-- account, and one of which has never paired at all.
-- ---------------------------------------------------------------------------

create temporary table t_ids (k text primary key, v uuid not null) on commit drop;
insert into t_ids (k, v) values
  ('clinic_a',      '0a000000-0000-4000-8000-00000000000a'),
  ('clinic_b',      '0b000000-0000-4000-8000-00000000000b'),
  ('clinic_u',      '0c000000-0000-4000-8000-00000000000c'), -- never paired
  ('staff_a',       '1a000000-0000-4000-8000-00000000000a'),
  ('staff_b',       '1b000000-0000-4000-8000-00000000000b'),
  ('staff_u',       '1c000000-0000-4000-8000-00000000000c'),
  ('conv_a_current','2a000000-0000-4000-8000-00000000000a'),
  ('conv_a_old',    '2a000000-0000-4000-8000-00000000000d'), -- clinic A, previous account
  ('conv_a_legacy', '2a000000-0000-4000-8000-00000000000e'), -- clinic A, NULL scope
  ('conv_b_current','2b000000-0000-4000-8000-00000000000b'),
  ('conv_u_legacy', '2c000000-0000-4000-8000-00000000000c'),
  ('in_a_current',  '3a000000-0000-4000-8000-00000000000a'),
  ('in_a_old',      '3a000000-0000-4000-8000-00000000000d'),
  ('in_a_legacy',   '3a000000-0000-4000-8000-00000000000e'),
  ('in_b_current',  '3b000000-0000-4000-8000-00000000000b'),
  ('in_u_legacy',   '3c000000-0000-4000-8000-00000000000c'),
  ('out_a_current', '4a000000-0000-4000-8000-00000000000a'),
  ('out_a_old',     '4a000000-0000-4000-8000-00000000000d'),
  ('out_b_current', '4b000000-0000-4000-8000-00000000000b');

create or replace function pg_temp.id(text) returns uuid language sql stable as
  $$ select v from t_ids where k = $1 $$;
-- Some checks resolve a fixture id while already acting as `authenticated`.
-- The lookup table is scratch space for this script, not part of the boundary
-- under test, so it is readable; nothing in it is a secret.
grant select on t_ids to authenticated, service_role;

-- Account keys. `ACCOUNT_OLD` is the number clinic A used before it re-paired:
-- its rows must become invisible the moment the new device is authoritative.
create or replace function pg_temp.account_current() returns text language sql immutable as
  $$ select '+201111111111'::text $$;
create or replace function pg_temp.account_old() returns text language sql immutable as
  $$ select '+202222222222'::text $$;
create or replace function pg_temp.account_b() returns text language sql immutable as
  $$ select '+203333333333'::text $$;

insert into public.clinics (id, name) values
  (pg_temp.id('clinic_a'), 'RLS Clinic A'),
  (pg_temp.id('clinic_b'), 'RLS Clinic B'),
  (pg_temp.id('clinic_u'), 'RLS Clinic Unpaired');

insert into auth.users (id, instance_id, aud, role, email)
select v, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       k || '@rls.test'
from t_ids where k in ('staff_a', 'staff_b', 'staff_u');

insert into public.profiles (id, clinic_id, full_name, role, is_active, is_deleted)
values
  (pg_temp.id('staff_a'), pg_temp.id('clinic_a'), 'Staff A', 'receptionist', true, false),
  (pg_temp.id('staff_b'), pg_temp.id('clinic_b'), 'Staff B', 'receptionist', true, false),
  (pg_temp.id('staff_u'), pg_temp.id('clinic_u'), 'Staff U', 'receptionist', true, false);

-- A and B are on linked-device WhatsApp. The unpaired clinic has no channel at
-- all, which is the state every clinic was in before linked-device shipped.
insert into public.clinic_channels (clinic_id, channel, provider, sender_identity, status)
values
  (pg_temp.id('clinic_a'), 'whatsapp', 'linked_device', pg_temp.account_current(), 'active'),
  (pg_temp.id('clinic_b'), 'whatsapp', 'linked_device', pg_temp.account_b(), 'active');

insert into public.whatsapp_linked_device_sessions (clinic_id, authenticated_account_id)
values
  (pg_temp.id('clinic_a'), pg_temp.account_current()),
  (pg_temp.id('clinic_b'), pg_temp.account_b());

insert into public.conversations (id, clinic_id, channel, participant_address, whatsapp_account_id)
values
  (pg_temp.id('conv_a_current'), pg_temp.id('clinic_a'), 'whatsapp', '+209000000001', pg_temp.account_current()),
  (pg_temp.id('conv_a_old'),     pg_temp.id('clinic_a'), 'whatsapp', '+209000000002', pg_temp.account_old()),
  (pg_temp.id('conv_a_legacy'),  pg_temp.id('clinic_a'), 'whatsapp', '+209000000003', null),
  (pg_temp.id('conv_b_current'), pg_temp.id('clinic_b'), 'whatsapp', '+209000000004', pg_temp.account_b()),
  (pg_temp.id('conv_u_legacy'),  pg_temp.id('clinic_u'), 'whatsapp', '+209000000005', null);

insert into public.inbound_messages (id, clinic_id, channel, sender, conversation_id, body)
values
  (pg_temp.id('in_a_current'), pg_temp.id('clinic_a'), 'whatsapp', '+209000000001', pg_temp.id('conv_a_current'), 'current'),
  (pg_temp.id('in_a_old'),     pg_temp.id('clinic_a'), 'whatsapp', '+209000000002', pg_temp.id('conv_a_old'),     'old account'),
  (pg_temp.id('in_a_legacy'),  pg_temp.id('clinic_a'), 'whatsapp', '+209000000003', pg_temp.id('conv_a_legacy'),  'legacy'),
  (pg_temp.id('in_b_current'), pg_temp.id('clinic_b'), 'whatsapp', '+209000000004', pg_temp.id('conv_b_current'), 'clinic b'),
  (pg_temp.id('in_u_legacy'),  pg_temp.id('clinic_u'), 'whatsapp', '+209000000005', pg_temp.id('conv_u_legacy'),  'unpaired legacy');

insert into public.outbound_messages (id, clinic_id, channel, provider, recipient, related_type, related_id, body)
values
  (pg_temp.id('out_a_current'), pg_temp.id('clinic_a'), 'whatsapp', 'linked_device', '+209000000001', 'manual', pg_temp.id('conv_a_current'), 'reply'),
  (pg_temp.id('out_a_old'),     pg_temp.id('clinic_a'), 'whatsapp', 'linked_device', '+209000000002', 'manual', pg_temp.id('conv_a_old'),     'old reply'),
  (pg_temp.id('out_b_current'), pg_temp.id('clinic_b'), 'whatsapp', 'linked_device', '+209000000004', 'manual', pg_temp.id('conv_b_current'), 'b reply');

-- Media is the same disclosure as the message it hangs off, so it gets the same
-- matrix: a row on the current account, one on the superseded account, and one
-- belonging to the other clinic entirely.
insert into public.inbound_message_attachments
  (clinic_id, conversation_id, inbound_message_id, media_kind, mime_type, byte_size, status, storage_path)
values
  (pg_temp.id('clinic_a'), pg_temp.id('conv_a_current'), pg_temp.id('in_a_current'), 'image', 'image/jpeg', 10, 'stored', 'a/current.jpg'),
  (pg_temp.id('clinic_a'), pg_temp.id('conv_a_old'),     pg_temp.id('in_a_old'),     'image', 'image/jpeg', 10, 'stored', 'a/old.jpg'),
  (pg_temp.id('clinic_a'), pg_temp.id('conv_a_legacy'),  pg_temp.id('in_a_legacy'),  'image', 'image/jpeg', 10, 'stored', 'a/legacy.jpg'),
  (pg_temp.id('clinic_b'), pg_temp.id('conv_b_current'), pg_temp.id('in_b_current'), 'image', 'image/jpeg', 10, 'stored', 'b/current.jpg'),
  (pg_temp.id('clinic_u'), pg_temp.id('conv_u_legacy'),  pg_temp.id('in_u_legacy'),  'image', 'image/jpeg', 10, 'stored', 'u/legacy.jpg');

insert into public.outbound_message_media
  (clinic_id, conversation_id, outbound_message_id, source, media_kind, mime_type, byte_size, bucket, storage_path, status)
values
  (pg_temp.id('clinic_a'), pg_temp.id('conv_a_current'), pg_temp.id('out_a_current'), 'upload', 'image', 'image/jpeg', 10, 'whatsapp-outbound', pg_temp.id('clinic_a') || '/current.jpg', 'sent'),
  (pg_temp.id('clinic_a'), pg_temp.id('conv_a_old'),     pg_temp.id('out_a_old'),     'upload', 'image', 'image/jpeg', 10, 'whatsapp-outbound', pg_temp.id('clinic_a') || '/old.jpg', 'sent'),
  (pg_temp.id('clinic_b'), pg_temp.id('conv_b_current'), pg_temp.id('out_b_current'), 'upload', 'image', 'image/jpeg', 10, 'whatsapp-outbound', pg_temp.id('clinic_b') || '/current.jpg', 'sent');

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------

create temporary table t_results (
  ord serial primary key,
  name text not null,
  ok boolean not null,
  detail text
) on commit drop;

/** Runs `p_query` as `p_staff` through RLS and records whether it matched. */
create or replace function pg_temp.check_read(
  p_name text, p_staff uuid, p_query text, p_expected bigint
) returns void language plpgsql as $fn$
declare v_actual bigint;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_staff::text, 'role', 'authenticated')::text,
    true
  );
  execute p_query into v_actual;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  insert into t_results (name, ok, detail)
  values (
    p_name, v_actual = p_expected,
    format('expected %s row(s), read %s', p_expected, v_actual)
  );
exception when others then
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  insert into t_results (name, ok, detail) values (p_name, false, 'ERROR: ' || sqlerrm);
end;
$fn$;

/** Records a check that is expected to *fail* with a permission error. */
create or replace function pg_temp.check_denied(
  p_name text, p_staff uuid, p_query text
) returns void language plpgsql as $fn$
declare v_actual bigint;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_staff::text, 'role', 'authenticated')::text,
    true
  );
  execute p_query into v_actual;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  -- Reaching here at all means the read was permitted. Zero rows is still a
  -- pass for a deny-all table (RLS with no policy returns nothing), but a
  -- non-zero count is a leak.
  insert into t_results (name, ok, detail)
  values (p_name, v_actual = 0, format('read was permitted and returned %s row(s)', v_actual));
exception when insufficient_privilege then
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  insert into t_results (name, ok, detail) values (p_name, true, 'denied: ' || sqlerrm);
when others then
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  insert into t_results (name, ok, detail) values (p_name, false, 'ERROR: ' || sqlerrm);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 1. Clinic A staff read clinic A's current-account rows
-- ---------------------------------------------------------------------------

select pg_temp.check_read(
  'A staff read the current-account conversation',
  pg_temp.id('staff_a'),
  format('select count(*) from public.conversations where id = %L', pg_temp.id('conv_a_current')),
  1);

select pg_temp.check_read(
  'A staff read the current-account inbound message',
  pg_temp.id('staff_a'),
  format('select count(*) from public.inbound_messages where id = %L', pg_temp.id('in_a_current')),
  1);

select pg_temp.check_read(
  'A staff read the current-account outbound message',
  pg_temp.id('staff_a'),
  format('select count(*) from public.outbound_messages where id = %L', pg_temp.id('out_a_current')),
  1);

select pg_temp.check_read(
  'A staff read the current-account inbound attachment',
  pg_temp.id('staff_a'),
  format('select count(*) from public.inbound_message_attachments where conversation_id = %L', pg_temp.id('conv_a_current')),
  1);

select pg_temp.check_read(
  'A staff read the current-account outbound media',
  pg_temp.id('staff_a'),
  format('select count(*) from public.outbound_message_media where conversation_id = %L', pg_temp.id('conv_a_current')),
  1);

-- ---------------------------------------------------------------------------
-- 2. Clinic A staff cannot read clinic B — the tenant boundary
-- ---------------------------------------------------------------------------

select pg_temp.check_read(
  'A staff cannot read a clinic B conversation',
  pg_temp.id('staff_a'),
  format('select count(*) from public.conversations where id = %L', pg_temp.id('conv_b_current')),
  0);

select pg_temp.check_read(
  'A staff cannot read a clinic B inbound message',
  pg_temp.id('staff_a'),
  format('select count(*) from public.inbound_messages where id = %L', pg_temp.id('in_b_current')),
  0);

select pg_temp.check_read(
  'A staff cannot read clinic B media',
  pg_temp.id('staff_a'),
  format('select count(*) from public.outbound_message_media where conversation_id = %L', pg_temp.id('conv_b_current')),
  0);

select pg_temp.check_read(
  'B staff cannot read a clinic A conversation',
  pg_temp.id('staff_b'),
  format('select count(*) from public.conversations where id = %L', pg_temp.id('conv_a_current')),
  0);

-- ---------------------------------------------------------------------------
-- 3. Another WhatsApp account boundary inside the same clinic
-- ---------------------------------------------------------------------------
-- The clinic re-paired. Rows the *previous* device received are still owned by
-- this clinic, and are still invisible: they are not this account's traffic.

select pg_temp.check_read(
  'A staff cannot read the superseded account''s conversation',
  pg_temp.id('staff_a'),
  format('select count(*) from public.conversations where id = %L', pg_temp.id('conv_a_old')),
  0);

select pg_temp.check_read(
  'A staff cannot read the superseded account''s inbound message',
  pg_temp.id('staff_a'),
  format('select count(*) from public.inbound_messages where id = %L', pg_temp.id('in_a_old')),
  0);

select pg_temp.check_read(
  'A staff cannot read the superseded account''s outbound message',
  pg_temp.id('staff_a'),
  format('select count(*) from public.outbound_messages where id = %L', pg_temp.id('out_a_old')),
  0);

select pg_temp.check_read(
  'A staff cannot read the superseded account''s attachment',
  pg_temp.id('staff_a'),
  format('select count(*) from public.inbound_message_attachments where conversation_id = %L', pg_temp.id('conv_a_old')),
  0);

select pg_temp.check_read(
  'A staff cannot read the superseded account''s outbound media',
  pg_temp.id('staff_a'),
  format('select count(*) from public.outbound_message_media where conversation_id = %L', pg_temp.id('conv_a_old')),
  0);

-- ---------------------------------------------------------------------------
-- 4. A live account hides legacy NULL rows
-- ---------------------------------------------------------------------------
-- Legacy rows predate account attribution and cannot be proved to belong to the
-- current device, so they are kept and not shown. Never adopted, never rewritten.

select pg_temp.check_read(
  'A live account hides clinic A''s legacy NULL conversation',
  pg_temp.id('staff_a'),
  format('select count(*) from public.conversations where id = %L', pg_temp.id('conv_a_legacy')),
  0);

select pg_temp.check_read(
  'A live account hides clinic A''s legacy NULL inbound message',
  pg_temp.id('staff_a'),
  format('select count(*) from public.inbound_messages where id = %L', pg_temp.id('in_a_legacy')),
  0);

select pg_temp.check_read(
  'A live account hides clinic A''s legacy NULL attachment',
  pg_temp.id('staff_a'),
  format('select count(*) from public.inbound_message_attachments where conversation_id = %L', pg_temp.id('conv_a_legacy')),
  0);

do $$
declare v_scope text;
begin
  -- The legacy row is still on disk, untouched, with its NULL scope intact.
  select coalesce(whatsapp_account_id, '<null>') into v_scope
  from public.conversations where id = pg_temp.id('conv_a_legacy');
  insert into t_results (name, ok, detail)
  values ('legacy rows are hidden, never adopted or rewritten',
          v_scope = '<null>', 'whatsapp_account_id = ' || v_scope);
end $$;

-- ---------------------------------------------------------------------------
-- 5. An unlinked clinic keeps the legacy NULL fallback, exactly as before
-- ---------------------------------------------------------------------------
-- The clinic that never paired must be completely unaffected by any of this.

select pg_temp.check_read(
  'unpaired clinic still reads its legacy NULL conversation',
  pg_temp.id('staff_u'),
  format('select count(*) from public.conversations where id = %L', pg_temp.id('conv_u_legacy')),
  1);

select pg_temp.check_read(
  'unpaired clinic still reads its legacy NULL inbound message',
  pg_temp.id('staff_u'),
  format('select count(*) from public.inbound_messages where id = %L', pg_temp.id('in_u_legacy')),
  1);

select pg_temp.check_read(
  'unpaired clinic still reads its legacy NULL attachment',
  pg_temp.id('staff_u'),
  format('select count(*) from public.inbound_message_attachments where conversation_id = %L', pg_temp.id('conv_u_legacy')),
  1);

-- ---------------------------------------------------------------------------
-- 6. Fail closed: a linked channel with no proved Baileys identity
-- ---------------------------------------------------------------------------
-- The channel is active but the worker has not proved which account it is. The
-- correct answer is nothing at all — not "fall back to legacy".

update public.whatsapp_linked_device_sessions
set authenticated_account_id = null where clinic_id = pg_temp.id('clinic_a');

select pg_temp.check_read(
  'unproved identity hides the current-account conversation',
  pg_temp.id('staff_a'),
  format('select count(*) from public.conversations where id = %L', pg_temp.id('conv_a_current')),
  0);

select pg_temp.check_read(
  'unproved identity does NOT fall back to legacy rows',
  pg_temp.id('staff_a'),
  format('select count(*) from public.conversations where id = %L', pg_temp.id('conv_a_legacy')),
  0);

update public.whatsapp_linked_device_sessions
set authenticated_account_id = pg_temp.account_current() where clinic_id = pg_temp.id('clinic_a');

-- ---------------------------------------------------------------------------
-- 7. clinic_channels itself stays unreadable
-- ---------------------------------------------------------------------------
-- The helper exists precisely so this never has to change.

select pg_temp.check_denied(
  'clinic_channels is unreadable to authenticated (own clinic)',
  pg_temp.id('staff_a'),
  format('select count(*) from public.clinic_channels where clinic_id = %L', pg_temp.id('clinic_a')));

select pg_temp.check_denied(
  'clinic_channels is unreadable to authenticated (any clinic)',
  pg_temp.id('staff_a'),
  'select count(*) from public.clinic_channels');

do $$
declare v_count integer;
begin
  select count(*) into v_count from pg_policies where tablename = 'clinic_channels';
  insert into t_results (name, ok, detail)
  values ('clinic_channels still has zero policies', v_count = 0, 'policies: ' || v_count);
end $$;

-- The helper answers one boolean about the caller's own clinic and cannot be
-- aimed anywhere else: it takes no argument.
do $$
declare v_args integer;
begin
  select pronargs into v_args from pg_proc
  where proname = 'whatsapp_linked_device_active' and pronamespace = 'public'::regnamespace;
  insert into t_results (name, ok, detail)
  values ('boundary helper takes no clinic argument', v_args = 0, 'pronargs = ' || coalesce(v_args::text, 'missing'));
end $$;

do $$
declare v_ok boolean;
begin
  -- `set search_path = ''` is stored as the literal `search_path=""`. Stable,
  -- not volatile, so the planner folds it per query rather than per row.
  select prosecdef
     and provolatile = 's'
     and proconfig @> array['search_path=""']
  into v_ok
  from pg_proc
  where proname = 'whatsapp_linked_device_active' and pronamespace = 'public'::regnamespace;
  insert into t_results (name, ok, detail)
  values ('boundary helper is security definer, stable, fixed search_path',
          coalesce(v_ok, false), 'secdef+stable+search_path = ' || coalesce(v_ok::text, 'missing'));
end $$;

do $$
declare v_ok boolean;
begin
  -- Least privilege: authenticated and service_role only, never anon or PUBLIC.
  select has_function_privilege('authenticated', 'public.whatsapp_linked_device_active()', 'execute')
     and has_function_privilege('service_role', 'public.whatsapp_linked_device_active()', 'execute')
     and not has_function_privilege('anon', 'public.whatsapp_linked_device_active()', 'execute')
  into v_ok;
  insert into t_results (name, ok, detail)
  values ('boundary helper grants are least-privilege', v_ok, 'authenticated+service_role only = ' || v_ok::text);
end $$;

-- Each staff member gets their *own* clinic's answer and no way to ask about
-- another one. Clinic U has no channel, so its staff get false.
do $$
declare v_a boolean; v_u boolean;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id('staff_a')::text, 'role', 'authenticated')::text, true);
  select public.whatsapp_linked_device_active() into v_a;
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id('staff_u')::text, 'role', 'authenticated')::text, true);
  select public.whatsapp_linked_device_active() into v_u;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  insert into t_results (name, ok, detail)
  values ('boundary helper is clinic-scoped to the caller', v_a and not v_u,
          format('clinic A = %s, unpaired clinic = %s', v_a, v_u));
end $$;

-- ---------------------------------------------------------------------------
-- 8. Service role is unchanged
-- ---------------------------------------------------------------------------
-- The isolation policies are `to authenticated`; the worker must still see
-- every row of every account, including the superseded one it is retiring.

do $$
declare v_count bigint;
begin
  perform set_config('role', 'service_role', true);
  select count(*) into v_count from public.conversations
  where clinic_id = pg_temp.id('clinic_a');
  perform set_config('role', 'postgres', true);
  insert into t_results (name, ok, detail)
  values ('service role still reads every account in the clinic', v_count = 3,
          format('expected 3 (current + superseded + legacy), read %s', v_count));
end $$;

do $$
declare v_count bigint;
begin
  perform set_config('role', 'service_role', true);
  select count(*) into v_count from public.clinic_channels;
  perform set_config('role', 'postgres', true);
  insert into t_results (name, ok, detail)
  values ('service role still reads clinic_channels', v_count >= 2, 'rows: ' || v_count);
end $$;

-- ---------------------------------------------------------------------------
-- 9. loadInboxData: the list and the metadata read now agree
-- ---------------------------------------------------------------------------
-- The original symptom. `get_inbox_conversation_summaries` is the security
-- definer RPC the Inbox list uses; the metadata read right after it is a plain
-- authenticated `from("conversations")`. Before the fix the first returned the
-- thread and the second returned nothing, and the Inbox silently lost every
-- badge. They have to return the same set.

do $$
declare v_summary uuid[]; v_meta uuid[];
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id('staff_a')::text, 'role', 'authenticated')::text, true);

  select array_agg(s.id order by s.id) into v_summary
  from public.get_inbox_conversation_summaries(null, 100, null) s;

  select array_agg(c.id order by c.id) into v_meta
  from public.conversations c
  where c.clinic_id = pg_temp.id('clinic_a')
    and c.id = any (coalesce(v_summary, '{}'::uuid[]));

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);

  -- Both aggregates are NULL when their read matched nothing, which is exactly
  -- the failure being tested for, so neither comparison may be NULL-propagating.
  insert into t_results (name, ok, detail)
  values (
    'loadInboxData: summary RPC and authenticated metadata read agree',
    v_summary is not null and v_summary is not distinct from v_meta,
    format('summary %s vs metadata %s',
           coalesce(v_summary::text, '<none>'), coalesce(v_meta::text, '<none>')));

  insert into t_results (name, ok, detail)
  values (
    'loadInboxData: metadata covers exactly the current-account thread',
    v_meta is not distinct from array[pg_temp.id('conv_a_current')],
    format('metadata = %s', coalesce(v_meta::text, '<none>')));
end $$;

-- ---------------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------------

select ord, case when ok then 'PASS' else 'FAIL' end as result, name, detail
from t_results order by ord;

do $$
declare v_failed integer;
begin
  select count(*) into v_failed from t_results where not ok;
  if v_failed > 0 then
    raise exception '% of % account-isolation RLS checks FAILED',
      v_failed, (select count(*) from t_results);
  end if;
  raise notice 'all % account-isolation RLS checks passed', (select count(*) from t_results);
end $$;

rollback;
