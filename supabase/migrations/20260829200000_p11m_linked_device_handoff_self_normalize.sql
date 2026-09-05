-- P11M — a self-handoff is normalised away instead of raising.
--
-- Why this exists
-- ---------------
-- P11K added `handoff_to` and the check constraint
-- `whatsapp_linked_device_sessions_handoff_not_self`, which refuses any row
-- where a worker has requested a session from itself. The constraint is right:
-- such a row is meaningless, and allowing it would let a worker fence every
-- other worker out of a clinic it is not even holding.
--
-- What P11K did not do was make the state unreachable. The worker's status
-- writes stamped `worker_id` with their own id on every call — including on rows
-- this instance had merely *asked* for, where `handoff_to` already named it. The
-- row that produced was `handoff_to = worker_id`, the constraint refused it with
-- SQLSTATE 23514, and a clinic pressing Disconnect got a 500 raised by a check
-- that was doing exactly its job. The worker-side fix (P11M) removes
-- `worker_id` from every write outside the fenced claim, so no worker can build
-- that row any more.
--
-- This trigger is the half of the fix that does not depend on a worker being
-- correct. `handoff_to = worker_id` is not an error to report to a caller; it is
-- a request that has already been answered, because the requester now holds the
-- session it was asking for. `claimSession` says the same thing in SQL — it
-- clears `handoff_to` in the same statement that takes ownership. So the
-- database now draws that conclusion itself, for every writer: the application,
-- a future worker, a migration, an operator at a psql prompt.
--
-- The check constraint is deliberately kept. It is no longer reachable, and that
-- is the point: it documents the invariant, and if this trigger were ever
-- dropped the old refusal returns rather than silent corruption.
--
-- Purely additive and idempotent. It rewrites no existing row on its own, and
-- it can only ever clear a `handoff_to` that names the row's own owner — a state
-- no correct row is in.

create or replace function public.whatsapp_linked_device_sessions_normalize_handoff()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A request that names the owner is a request the owner has already granted
  -- itself. Drop it, with its timestamp, so no fence outlives the transfer.
  if new.handoff_to is not null
     and new.worker_id is not null
     and new.handoff_to = new.worker_id then
    new.handoff_to := null;
    new.handoff_requested_at := null;
  end if;
  return new;
end;
$$;

comment on function public.whatsapp_linked_device_sessions_normalize_handoff() is
  'P11M: collapses handoff_to = worker_id to NULL before the not-self check runs. A worker holding a session has by definition answered any request naming itself.';

drop trigger if exists whatsapp_linked_device_sessions_normalize_handoff
  on public.whatsapp_linked_device_sessions;

create trigger whatsapp_linked_device_sessions_normalize_handoff
  before insert or update on public.whatsapp_linked_device_sessions
  for each row
  execute function public.whatsapp_linked_device_sessions_normalize_handoff();
