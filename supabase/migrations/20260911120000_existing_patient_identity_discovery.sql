-- Item #3 — finding a beneficiary who is already a patient here.
--
-- ## The defect
--
-- A third-party beneficiary ("جهاد علي") was already a patient of this clinic,
-- with the same authoritative identity number, and the assistant treated her as
-- a stranger: it asked which department she wanted and headed towards opening a
-- second file.
--
-- There was no path that could have found her. The only existing-patient reuse
-- lives in `stage_patient_intake_from_conversation`, and it is keyed on the
-- *sender's phone* (`conversations.participant_address`). A beneficiary who is
-- not the person holding the handset can never match it. An exact national-ID
-- match on somebody else returns `duplicate_review` there — a refusal, not a
-- reuse — which is correct for *staging a file* and useless for *finding the
-- person a booking is for*.
--
-- ## What this adds
--
-- One read-only, service-role-only lookup that answers exactly one question:
-- "does this clinic already have a patient with this civil/national id, and
-- does the name given match it?" — plus, when it does, the clinical
-- relationships that booking needs (which departments they are known in, and
-- who treats them there).
--
-- ## The identity rule, in full
--
--   * **The id is the identity fact.** Matching is on `fold_national_id`, the
--     same normalizer `stage_patient_intake_from_conversation` and the P8
--     duplicate checks already use. Exact after folding; nothing fuzzy.
--   * **The name is confirmation, never identification.** A matching id with a
--     non-matching name returns nothing at all. `fold_patient_name` is the same
--     comparison the staging RPC applies to a phone match. There is no
--     similarity score here and no threshold to tune: a name either folds equal
--     or it does not.
--   * **Ambiguity fails closed.** More than one non-deleted patient folding to
--     the same id is a data problem for staff, not something to guess at, and
--     returns nothing.
--   * **Clinic isolation.** `p_clinic_id` scopes every read and the function is
--     service-role-only, reachable only through the already-authorized patient
--     tool boundary. It cannot be pointed at another tenant.
--   * **No disclosure on a miss.** A wrong id returns zero rows — never "close
--     but not quite", never a name, never a count. Nothing here can be used to
--     probe whether a given person is a patient, because the caller must
--     already hold the exact id *and* the exact name.
--
-- What comes back is deliberately narrow: the patient's own id and name, and
-- the departments and treating doctors *of that patient*. No contact details,
-- no history, no appointment content, and nothing about anybody else.
--
-- Nothing is read, written, backfilled or deleted at migration time. The only
-- schema change is one new nullable column on `ai_patient_intakes`, carrying a
-- same-clinic composite foreign key; no table, column, constraint or policy is
-- dropped, retyped or narrowed. One existing function is replaced —
-- `approve_ai_patient_intake` — because approval has to understand that new
-- column or it will keep refusing the very people this migration can now find.
-- Its behaviour for an intake without a match is unchanged; see the section at
-- the end.

create or replace function public.find_clinic_patient_by_identity(
  p_clinic_id uuid,
  p_national_id text,
  p_full_name text
)
returns table (
  patient_id uuid,
  full_name text,
  department_id uuid,
  department_name text,
  doctor_id uuid,
  doctor_name text,
  is_primary boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_folded_id text;
  v_match_id uuid;
  v_match_count integer;
  v_match public.patients%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  v_folded_id := public.fold_national_id(p_national_id);
  -- A too-short id is not an identity claim. The bound is the same one the
  -- staging RPC validates against, so the two cannot disagree about what
  -- counts as an id at all.
  if v_folded_id is null or char_length(v_folded_id) not between 5 and 32 then
    return;
  end if;
  if p_full_name is null or public.fold_patient_name(p_full_name) is null then
    return;
  end if;

  select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
    into v_match_id, v_match_count
  from public.patients p
  where p.clinic_id = p_clinic_id
    and not p.is_deleted
    and p.deleted_at is null
    and public.fold_national_id(p.national_id) = v_folded_id;

  -- Nothing, or more than one. Both are "do not proceed as if this were
  -- settled", and both say so by returning no rows.
  if v_match_count <> 1 then return; end if;

  select p.* into v_match from public.patients p where p.id = v_match_id;
  -- The name is the confirmation half of the identity rule.
  if public.fold_patient_name(v_match.full_name)
     is distinct from public.fold_patient_name(p_full_name) then
    return;
  end if;

  -- The relationships this patient actually has, newest first.
  --
  -- Two sources, unioned rather than chosen between: the file's own
  -- `department_id`/`assigned_doctor_id`, which is what staff set when they
  -- opened it, and the departments and doctors they have really been seen by.
  -- A patient can legitimately be known in more than one department, and the
  -- booking flow has to be able to ask which one rather than assume.
  --
  -- Only real, bookable doctors are named: a doctor who has left is not an
  -- answer to "shall we book you with your usual doctor?".
  return query
  with relationships as (
    select
      v_match.department_id as department_id,
      v_match.assigned_doctor_id as doctor_id,
      true as is_primary,
      now() as seen_at
    where v_match.department_id is not null
    union all
    select a.department_id, a.doctor_id, false, max(a.scheduled_at)
    from public.appointments a
    where a.clinic_id = p_clinic_id
      and a.patient_id = v_match.id
      and a.deleted_at is null
      and a.department_id is not null
    group by a.department_id, a.doctor_id
  ), ranked as (
    select
      r.department_id,
      r.doctor_id,
      bool_or(r.is_primary) as is_primary,
      max(r.seen_at) as seen_at
    from relationships r
    group by r.department_id, r.doctor_id
  )
  select
    v_match.id,
    v_match.full_name,
    d.id,
    d.name,
    doc.id,
    doc.full_name,
    ranked.is_primary
  from ranked
  join public.departments d
    on d.id = ranked.department_id
   and d.clinic_id = p_clinic_id
   and d.is_active
   and d.deleted_at is null
  left join public.profiles doc
    on doc.id = ranked.doctor_id
   and doc.clinic_id = p_clinic_id
   and doc.role = 'doctor'::public.user_role
   and doc.is_active
   and not doc.is_deleted
   and doc.deleted_at is null
  order by ranked.is_primary desc, ranked.seen_at desc nulls last, d.name;
end;
$$;

comment on function public.find_clinic_patient_by_identity(uuid, text, text) is
  'Item #3 — the beneficiary a booking is for, when this clinic already has their file. Exact folded national/civil id within one clinic, confirmed by an exactly folded name; ambiguous or unmatched input returns no rows and discloses nothing. Returns the patient plus their own active departments and treating doctors, and nothing else.';

revoke all on function public.find_clinic_patient_by_identity(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.find_clinic_patient_by_identity(uuid, text, text)
  to service_role;

-- Makes the id lookup an index scan rather than a folded sequential one. The
-- expression is the same one the function and the staging RPC compare on.
create index if not exists patients_clinic_folded_national_id_idx
  on public.patients (clinic_id, public.fold_national_id(national_id))
  where not is_deleted and deleted_at is null;

-- ---------------------------------------------------------------------------
-- Staging an intake that is not a new person
-- ---------------------------------------------------------------------------
--
-- The brief's rule is "do not create/stage a duplicate patient file". Once the
-- lookup above has proved the beneficiary is someone this clinic already has,
-- the intake row must stop being a *proposed new person* and become a pointer
-- at the existing one. Everything downstream then keeps working unchanged:
-- `create_preliminary_booking` still finds a pending third-party intake,
-- `createPatientPendingBooking` still files a provisional request that the
-- clinic must confirm, and staff still review it — but they are reviewing
-- "this is Jihad Ali's file, book her in" rather than "here is a second Jihad
-- Ali, please merge".
--
-- `matched_patient_id` is deliberately *not* `approved_patient_id`.
-- `approved_patient_id` is the staff decision and is written when a human
-- approves. This is the server's finding, offered to that human. Nothing about
-- the review flow is changed by its presence, and every existing row keeps a
-- NULL that means exactly what it meant before.

alter table public.ai_patient_intakes
  add column if not exists matched_patient_id uuid;

-- Defence in depth, on the convention this table already uses for
-- `approved_patient_id`: the reference carries `clinic_id` with it, so the
-- database itself — not only the RPCs — refuses a row whose matched patient
-- belongs to another tenant. `on delete restrict` matches the sibling
-- constraint: patients are soft-deleted here, and a hard delete that would
-- orphan a pending review is an error to surface, not one to null away.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_patient_intakes_matched_patient_clinic_fkey'
  ) then
    alter table public.ai_patient_intakes
      add constraint ai_patient_intakes_matched_patient_clinic_fkey
      foreign key (matched_patient_id, clinic_id)
      references public.patients(id, clinic_id) on delete restrict;
  end if;
end;
$$;

comment on column public.ai_patient_intakes.matched_patient_id is
  'Item #3 — the existing patient this intake was proved to be, by exact folded national/civil id confirmed by an exactly folded name within the same clinic. Server finding, not a staff decision (that is approved_patient_id). NULL means no existing file was proved, which is every row written before this column existed.';

create index if not exists ai_patient_intakes_matched_patient_idx
  on public.ai_patient_intakes (clinic_id, matched_patient_id)
  where matched_patient_id is not null;

-- Stages a third-party intake for a beneficiary who already has a file here.
--
-- A sibling of `stage_patient_intake_from_conversation` rather than a change to
-- it: that function is the certified path for opening a *new* file and is
-- reached by every other flow, and the safest way to add this case is to not
-- touch it. The identity checks here are strictly *stronger* — the exact id and
-- name have already been proved by `find_clinic_patient_by_identity`, which
-- this function calls again itself rather than trusting an argument.
create or replace function public.stage_matched_third_party_intake(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_full_name text,
  p_national_id text,
  p_phone text,
  p_department_id uuid,
  p_doctor_id uuid
)
returns table (status text, intake_id uuid, matched_patient_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_patient public.patients%rowtype;
  v_match uuid;
  v_intake_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select c.* into v_conversation
  from public.conversations c
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id
    and c.channel = 'whatsapp'::public.message_channel
    and c.status = 'open'::public.conversation_status
  for update;
  if not found then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  if v_conversation.ai_paused_at is not null then
    raise exception 'HUMAN_TAKEOVER_ACTIVE' using errcode = '42501';
  end if;

  -- The identity is re-proved here, from the same function and the same rule.
  -- An argument saying "this is patient X" would be a way to file an
  -- appointment onto any record whose uuid a caller could name.
  select f.patient_id into v_match
  from public.find_clinic_patient_by_identity(p_clinic_id, p_national_id, p_full_name) f
  limit 1;
  if v_match is null then
    status := 'no_match'; intake_id := null; matched_patient_id := null;
    return next; return;
  end if;
  select p.* into v_patient from public.patients p where p.id = v_match;

  if not exists (
    select 1 from public.departments d
    where d.id = p_department_id and d.clinic_id = p_clinic_id
      and d.is_active and d.deleted_at is null
  ) or not exists (
    select 1 from public.profiles pr
    where pr.id = p_doctor_id and pr.clinic_id = p_clinic_id
      and pr.department_id = p_department_id
      and pr.role = 'doctor'::public.user_role
      and pr.is_active and not pr.is_deleted and pr.deleted_at is null
  ) then raise exception 'INVALID_INTAKE_ASSIGNMENT'; end if;

  insert into public.ai_patient_intakes (
    clinic_id, conversation_id, full_name, date_of_birth, phone, email,
    national_id, department_id, doctor_id, is_third_party, matched_patient_id,
    requested_by_patient_id
  ) values (
    p_clinic_id, p_conversation_id, v_patient.full_name, v_patient.date_of_birth,
    coalesce(nullif(btrim(coalesce(p_phone, '')), ''), v_patient.phone),
    v_patient.email, v_patient.national_id, p_department_id, p_doctor_id, true, v_match,
    v_conversation.patient_id
  )
  on conflict (clinic_id, conversation_id) do update
    set full_name = excluded.full_name,
        date_of_birth = excluded.date_of_birth,
        email = excluded.email,
        national_id = excluded.national_id,
        department_id = excluded.department_id,
        doctor_id = excluded.doctor_id,
        is_third_party = true,
        matched_patient_id = excluded.matched_patient_id,
        updated_at = clock_timestamp()
    where ai_patient_intakes.review_status = 'pending_review'
  returning id into v_intake_id;
  if v_intake_id is null then
    status := 'already_reviewed'; intake_id := null; matched_patient_id := v_match;
    return next; return;
  end if;

  -- The file's own details are what is filed, not what the sender typed. The
  -- sender proved the id and the name; they are not the source of truth for the
  -- beneficiary's date of birth or email, and copying their version over the
  -- clinic's would let a third party edit somebody else's record by proxy.
  insert into public.audit_logs (
    clinic_id, action, table_name, record_id, actor_type, source, new_data
  ) values (
    p_clinic_id, 'AI_PATIENT_INTAKE_MATCHED_EXISTING', 'ai_patient_intakes', v_intake_id,
    'ai', 'ai_assistant', jsonb_build_object(
      'review_status', 'pending_review', 'department_id', p_department_id,
      'doctor_id', p_doctor_id, 'conversation_id', p_conversation_id,
      'matched_patient_id', v_match
    )
  );
  update public.conversations c
  set ai_collected_data = coalesce(c.ai_collected_data, '{}'::jsonb)
    || jsonb_build_object('department_id', p_department_id, 'doctor_id', p_doctor_id)
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id;

  status := 'staged_existing'; intake_id := v_intake_id; matched_patient_id := v_match;
  return next;
end;
$$;

comment on function public.stage_matched_third_party_intake(uuid, uuid, text, text, text, uuid, uuid) is
  'Item #3 — stages a third-party intake that points at an existing patient file instead of proposing a duplicate. Re-proves the identity itself through find_clinic_patient_by_identity; a caller cannot name a patient id. Files the clinic''s own stored details, never the sender''s version of them.';

revoke all on function public.stage_matched_third_party_intake(uuid, uuid, text, text, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.stage_matched_third_party_intake(uuid, uuid, text, text, text, uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Approving an intake that is not a new person
-- ---------------------------------------------------------------------------
--
-- Staging can now prove a beneficiary is someone this clinic already has, and
-- writes that finding to `matched_patient_id`. Approval did not know the column
-- existed. It resolved every intake by the same arithmetic — one live patient
-- on the *sender's* phone, or none — and a beneficiary booked from a relative's
-- handset satisfies neither: the id is already on file, so the id count is 1
-- with no phone match, and the function raised
-- `INTAKE_DUPLICATE_REVIEW_REQUIRED`. The discovery above would have found her
-- and the review would still have refused her.
--
-- This replaces the function with one that takes a second branch when, and only
-- when, `matched_patient_id` is set, and re-proves the match itself. Everything
-- else in it is the P10 function unchanged, character for character: the
-- authorization gate, the already-approved short circuit, the stale-assignment
-- check, the conversation lock, the new-file path with its file-number advisory
-- lock, the approval-marker settings, the conversation/message relinking, the
-- provisional-booking resolution with its one-active-booking invariant and its
-- slot-collision handling, the `approved_patient_id` write, and the audit row.
-- An intake with a NULL `matched_patient_id` — which is every intake staged by
-- any other path, and every row that predates the column — takes exactly the
-- code it took before.
--
-- `approved_patient_id` therefore ends up on the reused file, because it is
-- written from the same `v_patient_id` for every branch. A reused patient is
-- approved the same way a created one is; only where the uuid came from
-- differs.

create or replace function public.approve_ai_patient_intake(
  p_intake_id uuid,
  p_actor_id uuid
)
returns table (patient_id uuid, appointment_id uuid, already_processed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intake public.ai_patient_intakes%rowtype;
  v_conversation public.conversations%rowtype;
  v_existing public.patients%rowtype;
  v_matched public.patients%rowtype;
  v_phone_count integer;
  v_id_count integer;
  v_patient_id uuid;
  v_request public.ai_appointment_requests%rowtype;
  v_appointment_id uuid;
  v_next integer;
  v_file text;
  v_previous_approval_id text;
  v_previous_approval_actor text;
  v_has_active_patient_booking boolean := false;
begin
  if p_actor_id is distinct from auth.uid()
     or coalesce(public.auth_role()::text, '') not in ('admin', 'manager', 'receptionist')
  then raise exception 'INTAKE_REVIEW_FORBIDDEN' using errcode = '42501'; end if;
  select i.* into v_intake from public.ai_patient_intakes i
  where i.id = p_intake_id and i.clinic_id = public.auth_clinic_id() for update;
  if not found then raise exception 'INTAKE_NOT_FOUND'; end if;
  if v_intake.review_status = 'approved' then
    select r.appointment_id into v_appointment_id
    from public.ai_appointment_requests r
    where r.intake_id = v_intake.id and r.clinic_id = v_intake.clinic_id
      and r.status = 'linked' limit 1;
    return query select v_intake.approved_patient_id, v_appointment_id, true;
    return;
  end if;
  if v_intake.review_status <> 'pending_review' then
    raise exception 'INTAKE_ALREADY_REVIEWED';
  end if;
  if not exists (
    select 1 from public.departments d
    where d.id = v_intake.department_id and d.clinic_id = v_intake.clinic_id
      and d.is_active and d.deleted_at is null
  ) or not exists (
    select 1 from public.profiles p
    where p.id = v_intake.doctor_id and p.clinic_id = v_intake.clinic_id
      and p.department_id = v_intake.department_id
      and p.role = 'doctor'::public.user_role
      and p.is_active and not p.is_deleted and p.deleted_at is null
  ) then raise exception 'INTAKE_ASSIGNMENT_STALE'; end if;

  select c.* into v_conversation from public.conversations c
  where c.id = v_intake.conversation_id and c.clinic_id = v_intake.clinic_id
  for update;
  if not found then raise exception 'CONVERSATION_NOT_FOUND'; end if;

  -- Item #3 — an intake that already points at a file this clinic holds.
  --
  -- `matched_patient_id` is the server's finding from
  -- `find_clinic_patient_by_identity`, written when the intake was staged. It
  -- is a hint, never an authority. The file may have been merged, deleted,
  -- renamed, or moved between staging and this review, so the identity is
  -- re-proved here from scratch, under this transaction's lock, with exactly
  -- the rules discovery used. Nothing about a caller-supplied uuid is trusted:
  -- the column is only ever written by the staging RPC, and it still has to
  -- survive every check below before a single row is reused.
  --
  -- The whole point of this branch is that the sender's phone is *not* the
  -- beneficiary's. Running the phone/id duplicate arithmetic below on a
  -- proved-existing file would reject it as `INTAKE_DUPLICATE_REVIEW_REQUIRED`
  -- — the exact failure this path exists to remove. So the branch is taken
  -- instead of it, not in addition to it.
  --
  -- Every way of failing raises the one deterministic error, so a reviewer
  -- learns "this needs a human" and nothing else: not whether the id exists,
  -- not whose it is, not which clinic holds it. There is no fall-through to
  -- creating a second file — a match that no longer proves is a review, never
  -- a duplicate.
  if v_intake.matched_patient_id is not null then
    select p.* into v_matched from public.patients p
    where p.id = v_intake.matched_patient_id
      and p.clinic_id = v_intake.clinic_id
      and not p.is_deleted
      and p.deleted_at is null;
    if not found then
      raise exception 'INTAKE_MATCHED_PATIENT_REVIEW_REQUIRED';
    end if;

    -- The identity rule of `find_clinic_patient_by_identity`, in its order and
    -- with its bounds: a folded id that is an identity claim at all, an exact
    -- folded id match, and an exactly folded name confirming it. Nothing fuzzy,
    -- no threshold.
    if v_intake.national_id_folded is null
       or char_length(v_intake.national_id_folded) not between 5 and 32
       or public.fold_national_id(v_matched.national_id)
            is distinct from v_intake.national_id_folded
       or public.fold_patient_name(v_matched.full_name)
            is distinct from public.fold_patient_name(v_intake.full_name)
    then
      raise exception 'INTAKE_MATCHED_PATIENT_REVIEW_REQUIRED';
    end if;

    -- And its ambiguity rule: a second live patient folding to the same id is
    -- a data problem for staff, not something to pick a winner from.
    select count(*)::integer into v_id_count from public.patients p
    where p.clinic_id = v_intake.clinic_id
      and public.fold_national_id(p.national_id) = v_intake.national_id_folded
      and not p.is_deleted and p.deleted_at is null;
    if v_id_count <> 1 then
      raise exception 'INTAKE_MATCHED_PATIENT_REVIEW_REQUIRED';
    end if;

    -- Proved. Reuse the existing file; create nothing.
    v_patient_id := v_matched.id;
  else
    select count(*)::integer into v_phone_count from public.patients p
    where p.clinic_id = v_intake.clinic_id and p.phone = v_intake.phone
      and not p.is_deleted and p.deleted_at is null;
    select count(*)::integer into v_id_count from public.patients p
    where p.clinic_id = v_intake.clinic_id
      and public.fold_national_id(p.national_id) = v_intake.national_id_folded
      and not p.is_deleted and p.deleted_at is null;
    if v_phone_count > 1 or v_id_count > 1 then raise exception 'INTAKE_DUPLICATE_REVIEW_REQUIRED'; end if;
    if v_phone_count = 1 then
      select p.* into v_existing from public.patients p
      where p.clinic_id = v_intake.clinic_id and p.phone = v_intake.phone
        and not p.is_deleted and p.deleted_at is null limit 1;
      if public.fold_national_id(v_existing.national_id)
           is distinct from v_intake.national_id_folded
         or v_existing.date_of_birth is distinct from v_intake.date_of_birth then
        raise exception 'INTAKE_DUPLICATE_REVIEW_REQUIRED';
      end if;
      v_patient_id := v_existing.id;
    elsif v_id_count > 0 then
      raise exception 'INTAKE_DUPLICATE_REVIEW_REQUIRED';
    else
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_intake.clinic_id::text || ':patient-file-number', 0)
      );
      select coalesce(max((substring(p.file_number from 4))::integer), 0) + 1 into v_next
      from public.patients p
      where p.clinic_id = v_intake.clinic_id and p.file_number ~ '^CF-\d+$';
      v_file := 'CF-' || lpad(v_next::text, 4, '0');
      insert into public.patients (
        clinic_id, full_name, national_id, date_of_birth, phone, email,
        department_id, assigned_doctor_id, file_number, created_by, blood_type
      ) values (
        v_intake.clinic_id, v_intake.full_name, v_intake.national_id,
        v_intake.date_of_birth, v_intake.phone, v_intake.email,
        v_intake.department_id, v_intake.doctor_id, v_file, p_actor_id, v_intake.blood_type
      ) returning id into v_patient_id;
    end if;
  end if;

  -- The caller remains the real authenticated staff member. These local,
  -- intake-bound markers authorize only the guarded writes performed by this
  -- reviewed transaction; the trigger helper also verifies the function owner,
  -- actor, clinic, conversation, and pending intake before accepting them.
  v_previous_approval_id := current_setting('clinicflow.ai_intake_approval_id', true);
  v_previous_approval_actor := current_setting('clinicflow.ai_intake_approval_actor', true);
  perform pg_catalog.set_config(
    'clinicflow.ai_intake_approval_id', v_intake.id::text, true
  );
  perform pg_catalog.set_config(
    'clinicflow.ai_intake_approval_actor', p_actor_id::text, true
  );

  update public.conversations c
  set patient_id = v_patient_id, patient_link_status = 'manual'
  where c.id = v_intake.conversation_id and c.clinic_id = v_intake.clinic_id;
  update public.conversations c
  set identity_verified_at = clock_timestamp(), identity_verification_failures = 0,
      identity_verification_locked_until = null
  where c.id = v_intake.conversation_id and c.clinic_id = v_intake.clinic_id;
  update public.inbound_messages m set patient_id = v_patient_id
  where m.conversation_id = v_intake.conversation_id
    and m.clinic_id = v_intake.clinic_id and m.patient_id is null;
  update public.inbound_message_attachments a set patient_id = v_patient_id
  where a.conversation_id = v_intake.conversation_id
    and a.clinic_id = v_intake.clinic_id and a.patient_id is null;

  select r.* into v_request from public.ai_appointment_requests r
  where r.intake_id = v_intake.id and r.clinic_id = v_intake.clinic_id
    and r.status = 'pending' for update;
  if found then
    if v_request.expires_at <= clock_timestamp()
       or not public.ai_requested_slot_is_available(
         v_request.clinic_id, v_request.doctor_id,
         v_request.scheduled_at, v_request.duration_minutes
       ) then
      update public.ai_appointment_requests
      set status = 'expired', updated_at = clock_timestamp()
      where id = v_request.id;
    else
      -- Preserve the one-active-AI-booking-per-patient invariant. Under the
      -- same advisory lock used by the appointment trigger, a pre-existing
      -- pending booking degrades only this request instead of rolling back the
      -- reviewed patient and conversation linkage.
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'p5a-ai-booking:' || v_request.clinic_id::text, 0
        )
      );
      select exists (
        select 1 from public.appointments a
        where a.clinic_id = v_request.clinic_id
          and a.patient_id = v_patient_id
          and a.status = 'pending'::public.appointment_status
          and a.deleted_at is null and a.expires_at > clock_timestamp()
          and (
            a.ai_patient_conversation_id is not null
            or a.ai_workflow_run_id is not null
            or a.ai_action_receipt_id is not null
          )
      ) into v_has_active_patient_booking;

      if v_has_active_patient_booking then
        update public.ai_appointment_requests
        set status = 'dismissed', updated_at = clock_timestamp()
        where id = v_request.id;
      else
        begin
          insert into public.appointments (
            clinic_id, patient_id, doctor_id, department_id, service_id,
            scheduled_at, duration_minutes, status, created_by,
            ai_patient_conversation_id
          ) values (
            v_request.clinic_id, v_patient_id, v_request.doctor_id,
            v_request.department_id, v_request.service_id, v_request.scheduled_at,
            v_request.duration_minutes, 'pending'::public.appointment_status, null,
            v_request.conversation_id
          ) returning id into v_appointment_id;
          update public.ai_appointment_requests
          set status = 'linked', appointment_id = v_appointment_id,
              updated_at = clock_timestamp()
          where id = v_request.id;
        exception
          when unique_violation or exclusion_violation then
            -- A staff booking may have claimed the exact patient/doctor slot
            -- after staging. Keep the reviewed patient and dismiss only the
            -- stale provisional request.
            v_appointment_id := null;
            update public.ai_appointment_requests
            set status = 'dismissed', updated_at = clock_timestamp()
            where id = v_request.id;
        end;
      end if;
    end if;
  end if;

  perform pg_catalog.set_config(
    'clinicflow.ai_intake_approval_id',
    coalesce(v_previous_approval_id, ''),
    true
  );
  perform pg_catalog.set_config(
    'clinicflow.ai_intake_approval_actor',
    coalesce(v_previous_approval_actor, ''),
    true
  );

  update public.ai_patient_intakes
  set review_status = 'approved', reviewed_at = clock_timestamp(),
      reviewed_by = p_actor_id, approved_patient_id = v_patient_id,
      updated_at = clock_timestamp()
  where id = v_intake.id;
  insert into public.audit_logs (
    clinic_id, actor_id, actor_type, source, action, table_name, record_id, new_data
  ) values (
    v_intake.clinic_id, p_actor_id, 'user', 'ai_assistant_review',
    'AI_PATIENT_INTAKE_APPROVED', 'ai_patient_intakes', v_intake.id,
    jsonb_build_object('patient_id', v_patient_id, 'appointment_id', v_appointment_id)
  );
  return query select v_patient_id, v_appointment_id, false;
end;
$$;

revoke all on function public.approve_ai_patient_intake(uuid, uuid)
  from public, anon;
grant execute on function public.approve_ai_patient_intake(uuid, uuid)
  to authenticated;
