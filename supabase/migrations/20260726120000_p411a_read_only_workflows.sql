-- P4.11A: server-authoritative, read-only workflow orchestration ledger.
--
-- This phase adds no action step, confirmation mutation, message send, booking
-- write, UI, scheduled workflow, or patient-facing workflow. Runtime plans may
-- contain typed tool inputs in memory, but this table stores only tool names,
-- parameter names/shapes, dependencies, timings, and safe error codes. Tool
-- outputs, patient ids, names, prompts, completions, and message bodies are
-- never persisted here.

create table public.ai_workflow_runs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  user_id uuid not null,
  -- Links the run to the content-free AI budget reservation for the planning
  -- turn without making workflow retention depend on reservation retention.
  ai_request_id uuid,
  task_class text not null default 'staff_workflow'
    check (task_class = 'staff_workflow'),
  mode text not null check (mode in ('dry_run', 'execute')),
  state text not null
    check (
      state in (
        'previewed',
        'running',
        'succeeded',
        'partially_failed',
        'failed'
      )
    ),
  plan jsonb not null check (jsonb_typeof(plan) = 'object'),
  step_states jsonb not null default '[]'::jsonb
    check (jsonb_typeof(step_states) = 'array'),
  step_count smallint not null check (step_count between 1 and 6),
  cost_units smallint not null check (cost_units between 1 and 12),
  dry_run_snapshot_hash text check (
    dry_run_snapshot_hash is null
    or dry_run_snapshot_hash ~ '^[0-9a-f]{64}$'
  ),
  -- Reserved by the P4.11 persistence contract for P4.11B. P4.11A has no
  -- confirmation API or action execution path and always leaves both null.
  confirmed_by uuid,
  confirmed_at timestamptz,
  error_code text check (
    error_code is null or length(error_code) between 1 and 100
  ),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint ai_workflow_runs_user_clinic_fkey
    foreign key (user_id, clinic_id)
    references public.profiles(id, clinic_id)
    on delete cascade,
  constraint ai_workflow_runs_confirmation_clinic_fkey
    foreign key (confirmed_by, clinic_id)
    references public.profiles(id, clinic_id)
    on delete set null (confirmed_by),
  constraint ai_workflow_runs_confirmation_pair_check
    check (
      (confirmed_by is null and confirmed_at is null)
      or (confirmed_by is not null and confirmed_at is not null)
    ),
  constraint ai_workflow_runs_mode_state_check
    check (
      (mode = 'dry_run' and state = 'previewed' and dry_run_snapshot_hash is not null)
      or
      (mode = 'execute' and state <> 'previewed' and dry_run_snapshot_hash is null)
    ),
  constraint ai_workflow_runs_terminal_time_check
    check (
      (state = 'running' and started_at is not null and completed_at is null)
      or
      (state = 'previewed' and completed_at is not null)
      or
      (
        state in ('succeeded', 'partially_failed', 'failed')
        and started_at is not null
        and completed_at is not null
      )
    ),
  unique (id, clinic_id)
);

create index ai_workflow_runs_owner_idx
  on public.ai_workflow_runs (clinic_id, user_id, created_at desc);

create trigger trg_ai_workflow_runs_updated_at
  before update on public.ai_workflow_runs
  for each row execute function public.set_updated_at();

alter table public.ai_workflow_runs enable row level security;

-- Owners may inspect their own content-free ledger rows. All writes stay behind
-- the reviewed clinic-scoped service boundary, so a browser cannot forge plan,
-- step, completion, or future confirmation state.
create policy "ai_workflow_runs_owner_read"
on public.ai_workflow_runs for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and user_id = auth.uid()
);

revoke all on table public.ai_workflow_runs from public, anon, authenticated;
grant select on table public.ai_workflow_runs to authenticated;
grant select, insert, update, delete on table public.ai_workflow_runs to service_role;

comment on table public.ai_workflow_runs is
  'P4.11A owner-readable, server-write-only, content-free read-workflow run ledger. Stores no prompts, completions, tool inputs/outputs, patient ids, names, notes, or message bodies.';
comment on column public.ai_workflow_runs.plan is
  'Versioned content-free summary: tool names, step ids/dependencies, and parameter names/shapes only; never runtime parameter values.';
comment on column public.ai_workflow_runs.step_states is
  'Content-free per-step status/timing/error-code ledger; never tool inputs or outputs.';

-- AI remains exclusive to the stable pro_ai catalog. The entitlement is
-- independently re-checked at mount time and immediately before every run.
update public.plans
set features = features || jsonb_build_object(
      'ai.workflows', slug = 'pro_ai'
    ),
    updated_at = clock_timestamp()
where slug in ('basic', 'pro', 'pro_ai');
