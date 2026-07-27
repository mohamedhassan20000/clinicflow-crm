-- Phase 6: dedicated Replace workflow — chain linkage, slot handling, the
-- future-only transition rule, and the atomic replace RPC.

-- ── Chain linkage (supports arbitrarily long chains A -> B -> C -> ...) ───────
alter table public.appointments
  add column if not exists replaces_appointment_id uuid
    references public.appointments(id) on delete set null,
  add column if not exists replaced_by_appointment_id uuid
    references public.appointments(id) on delete set null,
  add column if not exists original_appointment_id uuid
    references public.appointments(id) on delete set null;

create index if not exists appointments_original_appointment_idx
  on public.appointments (original_appointment_id)
  where original_appointment_id is not null;
create index if not exists appointments_replaced_by_idx
  on public.appointments (replaced_by_appointment_id)
  where replaced_by_appointment_id is not null;

comment on column public.appointments.replaces_appointment_id is
  'The appointment this row supersedes (immediate predecessor in a replace chain).';
comment on column public.appointments.replaced_by_appointment_id is
  'The appointment that superseded this row (immediate successor).';
comment on column public.appointments.original_appointment_id is
  'Stable chain root — the first appointment in the replace chain. Null for a row that is itself the root.';

-- ── `replaced` frees the patient slot, exactly like cancelled / no_show ───────
drop index if exists "appointments_patient_active_slot_key";
create unique index "appointments_patient_active_slot_key"
  on public.appointments (patient_id, scheduled_at)
  where status <> all (array[
      'cancelled'::public.appointment_status,
      'no_show'::public.appointment_status,
      'replaced'::public.appointment_status
    ])
    and deleted_at is null;

-- ── Transition rule: a future pending/confirmed appointment may become replaced ─
create or replace function public.enforce_appointment_transition()
returns trigger
language plpgsql
as $$
begin
  if old.status = new.status then
    return new;
  end if;

  if old.status = 'pending'::public.appointment_status
    and new.status in (
      'confirmed'::public.appointment_status,
      'cancelled'::public.appointment_status,
      'replaced'::public.appointment_status
    )
  then
    return new;
  end if;

  if old.status = 'confirmed'::public.appointment_status
    and new.status in (
      'arrived'::public.appointment_status,
      'completed'::public.appointment_status,
      'cancelled'::public.appointment_status,
      'no_show'::public.appointment_status,
      'replaced'::public.appointment_status
    )
  then
    return new;
  end if;

  if old.status = 'arrived'::public.appointment_status
    and new.status in (
      'in_session'::public.appointment_status,
      'completed'::public.appointment_status,
      'confirmed'::public.appointment_status,
      'cancelled'::public.appointment_status,
      'no_show'::public.appointment_status
    )
  then
    return new;
  end if;

  if old.status = 'in_session'::public.appointment_status
    and new.status in (
      'completed'::public.appointment_status,
      'arrived'::public.appointment_status,
      'cancelled'::public.appointment_status,
      'no_show'::public.appointment_status
    )
  then
    return new;
  end if;

  raise exception 'Invalid appointment status transition: % -> %', old.status, new.status
    using errcode = 'check_violation';
end;
$$;

-- ── Atomic replace: create the linked replacement, mark the original replaced ─
-- SECURITY INVOKER so the caller's RLS governs both the INSERT (replacement) and
-- the UPDATE (original) — an assistant is limited to their assigned doctors, a
-- doctor (read-only on appointments) cannot replace at all, and no caller can
-- point the replacement at an out-of-scope doctor. The original row is never
-- overwritten: only its status + forward link change.
create or replace function public.replace_appointment(
  p_original_id uuid,
  p_scheduled_at timestamptz,
  p_doctor_id uuid default null,
  p_duration_minutes integer default null,
  p_department_id uuid default null,
  p_notes text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_orig public.appointments%rowtype;
  v_new_id uuid := gen_random_uuid();
  v_root uuid;
  v_doctor uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  -- RLS-scoped read: an assistant only sees their assigned doctors' rows.
  select * into v_orig from public.appointments where id = p_original_id;
  if not found then
    raise exception 'Appointment not found' using errcode = '23514';
  end if;

  if v_orig.status not in (
    'pending'::public.appointment_status,
    'confirmed'::public.appointment_status
  ) then
    raise exception 'Only a pending or confirmed appointment can be replaced'
      using errcode = 'check_violation';
  end if;

  if v_orig.scheduled_at <= now() then
    raise exception 'Only a future appointment can be replaced'
      using errcode = 'check_violation';
  end if;

  v_root := coalesce(v_orig.original_appointment_id, v_orig.id);
  v_doctor := coalesce(p_doctor_id, v_orig.doctor_id);

  -- INSERT is RLS-checked (assistant: v_doctor must be in their scope).
  insert into public.appointments (
    id, clinic_id, patient_id, doctor_id, scheduled_at, duration_minutes,
    department_id, notes, insurance_provider_id, package_id,
    package_session_number, status, created_by,
    replaces_appointment_id, original_appointment_id
  )
  values (
    v_new_id, v_orig.clinic_id, v_orig.patient_id, v_doctor, p_scheduled_at,
    coalesce(p_duration_minutes, v_orig.duration_minutes),
    coalesce(p_department_id, v_orig.department_id),
    coalesce(p_notes, v_orig.notes), v_orig.insurance_provider_id,
    v_orig.package_id, v_orig.package_session_number,
    'confirmed'::public.appointment_status, auth.uid(),
    p_original_id, v_root
  );

  -- UPDATE is RLS-checked; the transition trigger permits pending/confirmed ->
  -- replaced. Only status + forward link + audit columns change.
  update public.appointments
  set status = 'replaced'::public.appointment_status,
      replaced_by_appointment_id = v_new_id,
      updated_by = auth.uid(),
      updated_at = now()
  where id = p_original_id;

  return v_new_id;
end;
$$;

revoke all on function public.replace_appointment(
  uuid, timestamptz, uuid, integer, uuid, text
) from public;
grant execute on function public.replace_appointment(
  uuid, timestamptz, uuid, integer, uuid, text
) to authenticated;

-- ── Ordered replace chain for one appointment (original -> ... -> active) ─────
create or replace function public.get_appointment_replacement_chain(p_appointment_id uuid)
returns table (
  id uuid,
  status public.appointment_status,
  scheduled_at timestamptz,
  doctor_id uuid,
  replaces_appointment_id uuid,
  replaced_by_appointment_id uuid,
  chain_position integer
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with target as (
    select coalesce(a.original_appointment_id, a.id) as root
    from public.appointments a
    where a.id = p_appointment_id
  )
  select a.id, a.status, a.scheduled_at, a.doctor_id,
         a.replaces_appointment_id, a.replaced_by_appointment_id,
         row_number() over (order by a.scheduled_at, a.created_at)::int as chain_position
  from public.appointments a, target
  where a.clinic_id = public.auth_clinic_id()
    and (a.id = target.root or a.original_appointment_id = target.root)
  order by a.scheduled_at, a.created_at;
$$;
revoke all on function public.get_appointment_replacement_chain(uuid) from public;
grant execute on function public.get_appointment_replacement_chain(uuid) to authenticated;
