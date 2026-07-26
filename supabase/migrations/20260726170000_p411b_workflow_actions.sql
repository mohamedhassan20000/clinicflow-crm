-- P4.11B: explicit-confirmation action workflows and idempotent pending booking provenance.

alter table public.ai_workflow_runs
  drop constraint ai_workflow_runs_state_check,
  drop constraint ai_workflow_runs_mode_state_check,
  drop constraint ai_workflow_runs_terminal_time_check;

alter table public.ai_workflow_runs
  add constraint ai_workflow_runs_state_check
    check (
      state in (
        'previewed',
        'running',
        'succeeded',
        'partially_failed',
        'needs_clarification',
        'failed'
      )
    ),
  add constraint ai_workflow_runs_mode_state_check
    check (
      (
        mode = 'dry_run'
        and state = 'previewed'
        and dry_run_snapshot_hash is not null
        and confirmed_at is null
      )
      or
      (
        mode = 'execute'
        and state <> 'previewed'
        and (
          (
            dry_run_snapshot_hash is null
            and confirmed_by is null
            and confirmed_at is null
          )
          or
          (
            dry_run_snapshot_hash is not null
            and confirmed_by is not null
            and confirmed_at is not null
          )
        )
      )
    ),
  add constraint ai_workflow_runs_terminal_time_check
    check (
      (state = 'running' and started_at is not null and completed_at is null)
      or
      (state = 'previewed' and completed_at is not null)
      or
      (
        state in (
          'succeeded',
          'partially_failed',
          'needs_clarification',
          'failed'
        )
        and started_at is not null
        and completed_at is not null
      )
    );

alter table public.appointments
  add column ai_workflow_run_id uuid,
  add column ai_workflow_step_id text,
  add constraint appointments_ai_workflow_pair_check
    check (
      (ai_workflow_run_id is null and ai_workflow_step_id is null)
      or
      (
        ai_workflow_run_id is not null
        and ai_workflow_step_id ~ '^[a-z][a-z0-9_]{0,63}$'
      )
    ),
  add constraint appointments_ai_workflow_run_clinic_fkey
    foreign key (ai_workflow_run_id, clinic_id)
    references public.ai_workflow_runs(id, clinic_id);

create unique index appointments_ai_workflow_step_uidx
  on public.appointments (clinic_id, ai_workflow_run_id, ai_workflow_step_id)
  where ai_workflow_run_id is not null;

comment on column public.appointments.ai_workflow_run_id is
  'Content-free P4.11B idempotency provenance for an explicitly confirmed pending-booking step.';
comment on column public.appointments.ai_workflow_step_id is
  'Content-free P4.11B step id. Paired with ai_workflow_run_id; contains no prompt or patient content.';
comment on table public.ai_workflow_runs is
  'P4.11 owner-readable, server-write-only, content-free workflow ledger. Action previews are hash-bound and require a same-user, non-replayable server confirmation.';
comment on column public.ai_workflow_runs.dry_run_snapshot_hash is
  'One-way content-free confirmation binding: full preview snapshot before confirmation, then server-resolved action inputs after the atomic claim so resumed actions cannot target unconfirmed data.';
