-- P11K — cooperative, fenced ownership handoff for linked-device sessions.
--
-- Why this exists
-- ---------------
-- `whatsapp_linked_device_sessions` already carries a single-owner invariant:
-- `worker_id` + `last_heartbeat_at` name the one worker process holding the
-- clinic's WhatsApp socket, and every other worker refuses that clinic while the
-- heartbeat is younger than 90 seconds. That invariant is correct and load
-- bearing — two processes opening a socket on the same linked-device identity is
-- split brain, and WhatsApp resolves it by tearing down Signal sessions, not by
-- picking a winner.
--
-- What it did not have was a way to move ownership *deliberately*. The only two
-- ways a session could change hands were a graceful shutdown of the current
-- owner and the 90-second stale window after a crash. That is enough for a
-- redeploy and nothing else: a developer who wants to drive the real linked
-- device from a worker on their laptop has no move that is not either "stop
-- production" or "corrupt the invariant by hand".
--
-- These two columns are that missing move, and nothing more:
--
--   handoff_to           the worker id that has *asked* for this session. It is
--                        a request, never a seizure — the requester cannot write
--                        `worker_id`, and the holder keeps its socket until it
--                        chooses to honour the request. Setting this column has
--                        no effect on any send in flight.
--   handoff_requested_at when the request was made, so an abandoned request
--                        cannot fence a clinic off from its production worker
--                        forever. Past `HANDOFF_TTL` the request is ignored by
--                        the claim predicate exactly as if it were absent.
--
-- The transfer itself stays atomic because the claim is a single conditional
-- UPDATE (see `Store.claimSession`): a worker only ever becomes the owner by
-- winning a compare-and-swap against `worker_id`, which is what makes the
-- handoff fenced rather than merely polite. This migration is purely additive —
-- both columns are nullable with no default, every existing row keeps its exact
-- current meaning, and a worker built before this migration ignores them.

alter table public.whatsapp_linked_device_sessions
  add column if not exists handoff_to text,
  add column if not exists handoff_requested_at timestamptz;

comment on column public.whatsapp_linked_device_sessions.handoff_to is
  'P11K: worker id requesting this session from its current owner. A request, not a claim — only the owner releases, and only a fenced compare-and-swap on worker_id transfers ownership.';
comment on column public.whatsapp_linked_device_sessions.handoff_requested_at is
  'P11K: when handoff_to was set. An expired request is ignored, so an abandoned developer session can never fence a clinic off from its production worker.';

-- A session may not request itself: that would let a worker fence every other
-- worker out of a clinic it is not even holding.
alter table public.whatsapp_linked_device_sessions
  drop constraint if exists whatsapp_linked_device_sessions_handoff_not_self;
alter table public.whatsapp_linked_device_sessions
  add constraint whatsapp_linked_device_sessions_handoff_not_self check (
    handoff_to is null or worker_id is null or handoff_to <> worker_id
  );

-- The owner's sweep for "has anyone asked me for a session?", which runs on
-- every heartbeat tick. Partial, so it costs nothing on the overwhelmingly
-- common state where no handoff is outstanding anywhere.
create index if not exists whatsapp_linked_device_sessions_handoff_idx
  on public.whatsapp_linked_device_sessions (worker_id)
  where handoff_to is not null;
