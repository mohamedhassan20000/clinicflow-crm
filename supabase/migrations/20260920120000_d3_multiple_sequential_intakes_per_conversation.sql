-- ===========================================================================
-- D3 — one conversation, many sequential beneficiaries
-- ===========================================================================
--
-- A WhatsApp thread belongs to one person and serves a family. Requester A
-- registers his wife B, and weeks later his son C, and later his daughter D,
-- from the same thread. Each is a separate patient identity; the thread's owner
-- is A throughout.
--
-- `ai_patient_intakes_conversation_unique (clinic_id, conversation_id)` made
-- that impossible. It is *lifetime* uniqueness, so a conversation could hold
-- one intake row ever. Both staging functions therefore wrote
--
--     on conflict (clinic_id, conversation_id) do update
--       set ... where ai_patient_intakes.review_status = 'pending_review'
--     returning id into v_intake_id;
--
-- and when the conversation's one row had already been approved, the `do
-- update` predicate was false, no row came back, and the function returned
-- `already_reviewed`. Production carries exactly that row: an approved
-- third-party intake on the thread whose requester later tried to register a
-- second child. Nothing could be staged for him.
--
-- The invariant this migration installs instead:
--
--     unlimited historical intakes per conversation,
--     at most one `pending_review` intake per conversation.
--
-- Three parts, and they are inseparable:
--
--   1. the unique index becomes partial, on `review_status = 'pending_review'`.
--      Approved, rejected and dismissed rows leave the index and stop
--      colliding, so a new beneficiary simply inserts;
--
--   2. both `on conflict` arbiters gain the matching `where` clause. This is
--      not optional: PostgreSQL infers the arbiter index from the inference
--      clause, and without a predicate that implies the partial index's own,
--      the statement fails at runtime with `42P10 there is no unique or
--      exclusion constraint matching the ON CONFLICT specification`;
--
--   3. a pending intake for a *different* beneficiary is superseded rather
--      than reused. Part 1 alone would leave the reuse path rewriting a
--      pending row's identity into somebody else's while an
--      `ai_appointment_requests` row bound to that `intake_id` stayed
--      attached — a defect that exists today and that part 1 would make
--      routine. The discriminator is the folded national id; phone is never
--      consulted, because families share a number.
--
-- `ai_patient_intakes_review_shape_check` is widened by exactly one shape, to
-- let a system supersession say so honestly: `dismissed` with a `reviewed_at`,
-- a null `reviewed_by` (no human reviewed it) and a null `approved_patient_id`
-- (nothing was approved). `approved` and `rejected` keep every requirement they
-- have today, and `dismissed` additionally gains `approved_patient_id is null`,
-- which the old check did not require. `dismissed` has no rows and no writer in
-- production, so this widens nothing that exists.
--
-- ======================= WHAT IS DELIBERATELY UNTOUCHED =====================
--
-- Every authorization surface, because the audit found all of them already
-- bound to an exact intake or an exact beneficiary and safe under N rows:
--
--   * `approve_ai_patient_intake` — selects `i.id = p_intake_id`, and reads
--     its appointment request by `intake_id`. B's approval cannot see C's row
--     and C's cannot consume B's request.
--   * `reject_ai_patient_intake` — same, by id.
--   * `ai_intake_approval_context_matches` — pins `i.id = v_intake_id` and
--     requires the executing role to own `approve_ai_patient_intake`, so a
--     session cannot forge the markers with `set_config`.
--   * `ai_conversation_booking_beneficiary_matches` — ranges over the
--     conversation, but both disjuncts re-bind to the beneficiary:
--     `i.approved_patient_id = p_patient_id` (B's approved row authorizes B
--     and nobody else) or the in-flight `i.id = v_marked_intake`. It must stay
--     durable, because a reschedule keeps the appointment `pending` and
--     re-fires the trigger long after the approval transaction is gone.
--   * `enforce_ai_pending_booking_policy`, RLS, and the admin review surface,
--     which is keyed on `intake.id` throughout.
--
-- `create_provisional_ai_appointment_request` gains an `order by`/`limit` on
-- its pending-intake lookup and nothing else. The partial index makes that
-- redundant; it is defence in depth against the invariant being lost.
--
-- No backfill. A read-only production preflight confirms no conversation holds
-- more than one intake, none holds more than one `pending_review`, every row
-- already satisfies the new check, and no appointment request is orphaned.

-- ---------------------------------------------------------------------------
-- 1. Lifetime uniqueness becomes active-only uniqueness
-- ---------------------------------------------------------------------------
--
-- Created before the old one is dropped so the table is never, even within
-- this transaction, without a uniqueness guard on the pending row.

create unique index if not exists ai_patient_intakes_one_pending_per_conversation
  on public.ai_patient_intakes (clinic_id, conversation_id)
  where review_status = 'pending_review';

drop index if exists public.ai_patient_intakes_conversation_unique;

comment on index public.ai_patient_intakes_one_pending_per_conversation is
  'D3 - a conversation may hold unlimited historical intakes and at most one pending_review intake. Replaces the lifetime unique (clinic_id, conversation_id), which allowed a WhatsApp thread only one patient intake ever and so refused a second family member. Both staging functions name this predicate in their ON CONFLICT inference clause.';

-- ---------------------------------------------------------------------------
-- 2. The review shape admits a system supersession
-- ---------------------------------------------------------------------------
--
-- Restated in full rather than patched, because a CHECK cannot be altered in
-- place. Against the deployed constraint:
--
--   pending_review   identical.
--   approved         identical - reviewed_at and reviewed_by both required.
--   rejected         identical - reviewed_at and reviewed_by both required.
--   dismissed        new shape. reviewed_at required (when it happened),
--                    reviewed_by free (null for a system supersession, a
--                    profile id if a human ever dismisses one), and
--                    approved_patient_id must be null - a requirement the old
--                    constraint did not impose on any non-pending status.
--
-- Nothing that validates today stops validating.

alter table public.ai_patient_intakes
  drop constraint ai_patient_intakes_review_shape_check,
  add constraint ai_patient_intakes_review_shape_check check (
    (review_status = 'pending_review'
      and reviewed_at is null and reviewed_by is null and approved_patient_id is null)
    or
    (review_status = 'dismissed'
      and reviewed_at is not null and approved_patient_id is null)
    or
    (review_status in ('approved', 'rejected')
      and reviewed_at is not null and reviewed_by is not null)
  );

-- ---------------------------------------------------------------------------
-- 3. The two staging functions
-- ---------------------------------------------------------------------------
--
-- Restated verbatim from the deployed bodies - verified byte-for-byte against
-- `pg_get_functiondef` before this migration was written - with exactly two
-- changes each, both described above: the supersession block immediately
-- before the insert, and the `where` on the `on conflict` inference clause.
-- Every guard, status return, identity rule, phone rule, requester precondition
-- and audit row is the deployed one.

create or replace function public.stage_patient_intake_from_conversation(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_full_name text,
  p_national_id text,
  p_date_of_birth date,
  p_email text,
  p_department_id uuid,
  p_doctor_id uuid,
  p_for_third_party boolean default false,
  p_phone text default null::text,
  p_blood_type text default null::text,
  p_full_name_original text default null::text,
  p_full_name_ar text default null::text,
  p_full_name_en text default null::text
)
returns table(status text, intake_id uuid, attempts_remaining integer)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_conversation public.conversations%rowtype;
  v_phone text;
  v_phone_match public.patients%rowtype;
  v_phone_count integer;
  v_id_match_id uuid;
  v_id_count integer;
  v_failures integer;
  v_intake_id uuid;
  v_requested_by uuid;
  v_blood public.blood_type;
  v_original text;
  v_name_ar text;
  v_name_en text;
  -- True when the one patient on this number is demonstrably somebody else:
  -- a relative on a shared phone. Not an identity failure, and not a link.
  v_phone_is_other_person boolean := false;
  -- The pending intake this staging replaces, when it belongs to somebody
  -- else, and how many of its provisional bookings went with it.
  v_superseded_id uuid;
  v_superseded_requests integer := 0;
begin
  attempts_remaining := null;
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
  if v_conversation.patient_id is not null and not exists (
    select 1 from public.patients p
    where p.id = v_conversation.patient_id
      and p.clinic_id = p_clinic_id
      and not p.is_deleted and p.deleted_at is null
  ) then
    update public.conversations c
    set patient_id = null, patient_link_status = 'unlinked'
    where c.id = p_conversation_id and c.clinic_id = p_clinic_id;
    update public.inbound_messages m
    set patient_id = null
    where m.conversation_id = p_conversation_id
      and m.clinic_id = p_clinic_id
      and m.patient_id = v_conversation.patient_id;
    update public.inbound_message_attachments a
    set patient_id = null
    where a.conversation_id = p_conversation_id
      and a.clinic_id = p_clinic_id
      and a.patient_id = v_conversation.patient_id;
    v_conversation.patient_id := null;
  end if;

  -- ===================================================================
  -- A third-party intake has a requester, or it is not staged.
  -- ===================================================================
  --
  -- `requested_by_patient_id` is the whole accountability record of a
  -- third-party intake: it is the only column that says *who* asked the clinic
  -- to open a file for somebody who never messaged it. The deployed body
  -- derived it from the conversation and accepted a null — so an unlinked
  -- sender answering "for someone else" staged a named third person, with
  -- their national id, their date of birth and a contact number, attributed to
  -- nobody. Nothing in the application prevented it: the booking flow's
  -- beneficiary question runs at `identity: "none"`, and the `register_patient`
  -- tool's only linkage check refuses a linked sender registering *themselves*.
  --
  -- So the requester is a precondition rather than an outcome: the conversation
  -- must be linked to a live patient of *this* clinic. The stale-link repair
  -- immediately above has already unlinked a conversation whose patient was
  -- deleted, so a surviving `patient_id` here is a real, in-clinic, undeleted
  -- file; the existence check is repeated all the same, because an invariant
  -- this column depends on should not be an inference about the block above it.
  --
  -- Archived is deliberately not a rejection: `is_archived` is a filing state,
  -- an archived patient is still a patient of this clinic, and no other guard
  -- in this function treats it as absence.
  --
  -- Self-intake is untouched. An unlinked sender registering *themselves* is
  -- the ordinary stranger path and still stages exactly as before, with
  -- `requested_by_patient_id` null — which is what that column means on a
  -- self-intake. This guard is reached only when `p_for_third_party` is true.
  --
  -- An exception rather than a new `status` value, because the v2 assistant's
  -- `stageIntake` boundary reads only the RPC's error and not the returned
  -- status: a status row would be read as a successful staging and the flow
  -- would continue to a booking with no file behind it.
  if coalesce(p_for_third_party, false) and (
    v_conversation.patient_id is null
    or not exists (
      select 1 from public.patients p
      where p.id = v_conversation.patient_id
        and p.clinic_id = p_clinic_id
        and not p.is_deleted and p.deleted_at is null
    )
  ) then
    raise exception 'THIRD_PARTY_REQUESTER_NOT_LINKED';
  end if;

  if v_conversation.patient_id is not null and not coalesce(p_for_third_party, false) then
    status := 'already_linked'; intake_id := null; return next; return;
  end if;
  if v_conversation.identity_verification_locked_until > clock_timestamp()
     and not coalesce(p_for_third_party, false) then
    status := 'identity_locked'; intake_id := null; attempts_remaining := 0; return next; return;
  end if;

  -- The patient's **contact** number, and only that.
  --
  -- For a third party the number the requester gave is preferred, and the
  -- conversation's verified `participant_address` is the fallback: when a
  -- parent books for a child and gives no separate number, the parent's phone
  -- is genuinely how the clinic reaches that child. It is a contact detail, it
  -- is not ownership, and nothing treats it as ownership — the phone-matching
  -- block below is gated on `not p_for_third_party`, so a third-party intake
  -- is never linked to an existing patient by phone, and
  -- `approve_ai_patient_intake` no longer consults phone at all. Two patient
  -- records sharing one number is a family, which `patients.phone` has always
  -- permitted: it carries a plain index and no unique constraint.
  v_phone := case
    when coalesce(p_for_third_party, false)
      then coalesce(
        nullif(btrim(coalesce(p_phone, '')), ''),
        nullif(btrim(coalesce(v_conversation.participant_address, '')), '')
      )
    else nullif(btrim(coalesce(v_conversation.participant_address, '')), '')
  end;
  if v_phone is null
     or p_full_name is null or char_length(btrim(p_full_name)) not between 2 and 100
     or p_national_id is null or public.fold_national_id(p_national_id) is null
     or char_length(public.fold_national_id(p_national_id)) not between 5 and 32
     or p_date_of_birth not between date '1900-01-01' and current_date
     or p_email is null or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'INVALID_PATIENT_DETAILS';
  end if;
  -- An unreadable blood type is dropped rather than raised: it is an optional
  -- convenience field and refusing the whole intake over it would lose a name,
  -- a national id and a date of birth the patient has already given.
  begin
    v_blood := nullif(btrim(coalesce(p_blood_type, '')), '')::public.blood_type;
  exception when others then
    v_blood := null;
  end;
  v_original := nullif(btrim(coalesce(p_full_name_original, '')), '');
  if v_original is not null and char_length(v_original) not between 2 and 100 then
    v_original := null;
  end if;
  -- The two display names get exactly the treatment the blood type gets: an
  -- optional convenience field is dropped when it is unusable, never raised
  -- over. Losing a display name must not lose an intake.
  v_name_ar := nullif(btrim(coalesce(p_full_name_ar, '')), '');
  if v_name_ar is not null and char_length(v_name_ar) not between 2 and 100 then
    v_name_ar := null;
  end if;
  v_name_en := nullif(btrim(coalesce(p_full_name_en, '')), '');
  if v_name_en is not null and char_length(v_name_en) not between 2 and 100 then
    v_name_en := null;
  end if;
  if not exists (
    select 1 from public.departments d
    where d.id = p_department_id and d.clinic_id = p_clinic_id
      and d.is_active and d.deleted_at is null
  ) or not exists (
    select 1 from public.profiles p
    where p.id = p_doctor_id and p.clinic_id = p_clinic_id
      and p.department_id = p_department_id
      and p.role = 'doctor'::public.user_role
      and p.is_active and not p.is_deleted and p.deleted_at is null
  ) then raise exception 'INVALID_INTAKE_ASSIGNMENT'; end if;

  select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
    into v_id_match_id, v_id_count
  from public.patients p
  where p.clinic_id = p_clinic_id and not p.is_deleted and p.deleted_at is null
    and public.fold_national_id(p.national_id) = public.fold_national_id(p_national_id);

  if not coalesce(p_for_third_party, false) then
    -- ===================================================================
    -- Identity is the folded national id. The phone is a second factor.
    -- ===================================================================
    --
    -- The deployed body decided this block from `count(patients on this
    -- number)`, and every branch of that was a phone-uniqueness assumption:
    -- two patients on one number returned `duplicate_ambiguous`, and one
    -- patient on one number whose details did not match counted as a failed
    -- identity verification — five of which lock the conversation for half an
    -- hour. Families share a number, so both refused a legitimate caller for
    -- somebody else's record: a son messaging from his father's phone could
    -- never register, and once a family had two files on a number nobody on it
    -- could ever be linked again, including the number's own owner.
    --
    -- So identity chooses the file, and the phone is only ever asked one
    -- question afterwards: *is this the registered number of the file the
    -- national id already picked?* That keeps the protection the phone was
    -- really providing — an automatic link, which hands a sender access to a
    -- patient's record, still requires the conversation's verified number to be
    -- that patient's own — while making how many relatives share the number
    -- irrelevant, which is what it always should have been.
    select count(*)::integer into v_phone_count
    from public.patients p
    where p.clinic_id = p_clinic_id and p.phone = v_phone
      and not p.is_deleted and p.deleted_at is null;

    if v_id_count = 1 then
      select p.* into v_phone_match from public.patients p
      where p.id = v_id_match_id and p.clinic_id = p_clinic_id
        and not p.is_deleted and p.deleted_at is null;

      -- A real identity conflict: the clinic holds this national id, and the
      -- name or the date of birth given with it is not the one on that file.
      -- Unchanged, and deliberately so — the comparison is against `full_name`,
      -- folded. The two display names are not part of it and must never be;
      -- see the "Not identity" note at the top of this file.
      if v_phone_match.date_of_birth is distinct from p_date_of_birth
         or public.fold_patient_name(v_phone_match.full_name)
            is distinct from public.fold_patient_name(p_full_name) then
        update public.conversations c
        set identity_verification_failures = least(c.identity_verification_failures + 1, 5),
            identity_verification_locked_until = case
              when c.identity_verification_failures + 1 >= 5
                then clock_timestamp() + interval '30 minutes'
              else c.identity_verification_locked_until end
        where c.id = p_conversation_id and c.clinic_id = p_clinic_id
        returning c.identity_verification_failures into v_failures;
        status := case when v_failures >= 5 then 'identity_locked' else 'identity_mismatch' end;
        intake_id := null; attempts_remaining := greatest(5 - v_failures, 0);
        return next; return;
      end if;

      -- Proven, and from that patient's own registered number. However many
      -- relatives also use it.
      if v_phone_match.phone is not distinct from v_phone then
        update public.conversations c
        set patient_id = v_phone_match.id, patient_link_status = 'automatic'
        where c.id = p_conversation_id and c.clinic_id = p_clinic_id;
        update public.conversations c
        set identity_verified_at = clock_timestamp(), identity_verification_failures = 0,
            identity_verification_locked_until = null
        where c.id = p_conversation_id and c.clinic_id = p_clinic_id;
        update public.inbound_messages m set patient_id = v_phone_match.id
        where m.conversation_id = p_conversation_id and m.clinic_id = p_clinic_id and m.patient_id is null;
        update public.inbound_message_attachments a set patient_id = v_phone_match.id
        where a.conversation_id = p_conversation_id and a.clinic_id = p_clinic_id and a.patient_id is null;
        update public.conversations c
        set ai_collected_data = coalesce(c.ai_collected_data, '{}'::jsonb)
          || jsonb_build_object(
            'department_id', p_department_id,
            'doctor_id', p_doctor_id
          )
        where c.id = p_conversation_id and c.clinic_id = p_clinic_id;
        status := 'linked_existing'; intake_id := null; return next; return;
      end if;

      -- Proven identity, but not from that file's own number, so there is no
      -- second factor and nothing is linked automatically. Falls through to
      -- `duplicate_review` below, which is a person at the clinic — exactly
      -- where this case went before.

    elsif v_id_count = 0 and v_phone_count > 0 and exists (
      select 1 from public.patients p
      where p.clinic_id = p_clinic_id and p.phone = v_phone
        and not p.is_deleted and p.deleted_at is null
        and public.fold_patient_name(p.full_name)
            = public.fold_patient_name(p_full_name)
    ) then
      -- The impersonation shape, and the reason the lockout exists: somebody on
      -- this number already carries this name, and the national id offered
      -- alongside it belongs to nobody at this clinic. A relative registering
      -- themselves gives their *own* name and does not reach this branch.
      v_phone_is_other_person := false;
      update public.conversations c
      set identity_verification_failures = least(c.identity_verification_failures + 1, 5),
          identity_verification_locked_until = case
            when c.identity_verification_failures + 1 >= 5
              then clock_timestamp() + interval '30 minutes'
            else c.identity_verification_locked_until end
      where c.id = p_conversation_id and c.clinic_id = p_clinic_id
      returning c.identity_verification_failures into v_failures;
      status := case when v_failures >= 5 then 'identity_locked' else 'identity_mismatch' end;
      intake_id := null; attempts_remaining := greatest(5 - v_failures, 0);
      return next; return;
    else
      -- Nobody here holds the national id given, and nobody on this number
      -- carries the name given: a different person on a shared phone, which is
      -- a new patient and is staged as one. Recorded so the audit trail says
      -- so rather than leaving it to be inferred.
      v_phone_is_other_person := v_phone_count > 0;
    end if;
  end if;

  if v_id_count > 0 then
    status := 'duplicate_review'; intake_id := null; return next; return;
  end if;

  v_requested_by := case
    when coalesce(p_for_third_party, false) then v_conversation.patient_id
    else null
  end;
  -- Unreachable given the guard above, and asserted rather than trusted: no
  -- later edit to this function may reach the insert with a third-party intake
  -- that has no requester.
  if coalesce(p_for_third_party, false) and v_requested_by is null then
    raise exception 'THIRD_PARTY_REQUESTER_NOT_LINKED';
  end if;


  -- =================================================================
  -- A pending intake for a *different* beneficiary is superseded, never
  -- overwritten.
  -- =================================================================
  --
  -- The partial unique index below permits one `pending_review` intake per
  -- conversation, and the `on conflict` that follows reuses it. Reuse is
  -- right for a retry — the same person, re-stated, possibly with a
  -- correction — and wrong for a different person: it would rewrite the
  -- pending row's name, date of birth and national id into somebody else's
  -- while any `ai_appointment_requests` row already bound to that
  -- `intake_id` stayed attached. Approving it would then create the new
  -- beneficiary's file and hand them the previous beneficiary's slot.
  --
  -- The discriminator is the folded national id, because that is the
  -- identity boundary everywhere else in this file. **Phone is never
  -- consulted**: families share a number, and two people on one number are
  -- two people. Same folded id -> fall through to the upsert, which updates
  -- in place exactly as it does today. Different folded id -> the pending
  -- row is dismissed and a new row is inserted beside it.
  --
  -- `dismissed` is the status for this and not `rejected`: no human
  -- rejected anything. It carries `reviewed_at` so the moment is on the
  -- record, a null `reviewed_by` because there is no reviewer to name, and
  -- a null `approved_patient_id` because nothing was approved — the exact
  -- shape `ai_patient_intakes_review_shape_check` now admits.
  --
  -- Running under the conversation's `for update` lock, which every caller
  -- of this function already holds by here, makes the supersede and the
  -- insert one indivisible step: a concurrent staging on this conversation
  -- waits, and cannot observe the window between them.
  select i.id into v_superseded_id
  from public.ai_patient_intakes i
  where i.clinic_id = p_clinic_id
    and i.conversation_id = p_conversation_id
    and i.review_status = 'pending_review'
    and i.national_id_folded
        is distinct from public.fold_national_id(p_national_id)
  for update;

  if v_superseded_id is not null then
    update public.ai_patient_intakes i
    set review_status = 'dismissed',
        reviewed_at = clock_timestamp(),
        reviewed_by = null,
        approved_patient_id = null,
        review_reason = 'superseded_by_new_beneficiary',
        updated_at = clock_timestamp()
    where i.id = v_superseded_id and i.clinic_id = p_clinic_id
      and i.review_status = 'pending_review';

    -- The dismissed intake's own provisional booking goes with it, and only
    -- its own: bound by `intake_id`, never by `conversation_id`. A request
    -- belonging to an *approved* historical intake on this thread is another
    -- beneficiary's real booking and is not touched.
    update public.ai_appointment_requests r
    set status = 'dismissed', updated_at = clock_timestamp()
    where r.clinic_id = p_clinic_id and r.intake_id = v_superseded_id
      and r.status = 'pending';
    get diagnostics v_superseded_requests = row_count;

    insert into public.audit_logs (
      clinic_id, action, table_name, record_id, actor_type, source, new_data
    ) values (
      p_clinic_id, 'AI_PATIENT_INTAKE_SUPERSEDED', 'ai_patient_intakes',
      v_superseded_id, 'ai', 'ai_assistant', jsonb_build_object(
        'review_status', 'dismissed',
        'review_reason', 'superseded_by_new_beneficiary',
        'conversation_id', p_conversation_id,
        'dismissed_appointment_requests', v_superseded_requests
      )
    );
  end if;

  insert into public.ai_patient_intakes (
    clinic_id, conversation_id, full_name, date_of_birth, phone, email,
    national_id, department_id, doctor_id, is_third_party, requested_by_patient_id,
    blood_type, full_name_original, full_name_ar, full_name_en
  ) values (
    p_clinic_id, p_conversation_id, btrim(p_full_name), p_date_of_birth, v_phone,
    lower(btrim(p_email)), btrim(p_national_id),
    p_department_id, p_doctor_id, coalesce(p_for_third_party, false), v_requested_by,
    v_blood, v_original, v_name_ar, v_name_en
  )
  on conflict (clinic_id, conversation_id)
    where review_status = 'pending_review'
  do update
    set full_name = excluded.full_name,
        date_of_birth = excluded.date_of_birth,
        phone = excluded.phone,
        email = excluded.email,
        national_id = excluded.national_id,
        department_id = excluded.department_id,
        doctor_id = excluded.doctor_id,
        is_third_party = excluded.is_third_party,
        requested_by_patient_id = excluded.requested_by_patient_id,
        -- A later call that carries no blood type must not erase one an earlier
        -- turn already collected.
        blood_type = coalesce(excluded.blood_type, ai_patient_intakes.blood_type),
        full_name_original = coalesce(
          excluded.full_name_original, ai_patient_intakes.full_name_original
        ),
        -- Same rule, same reason: a turn that re-stages without a display name
        -- must not erase one an earlier turn collected.
        full_name_ar = coalesce(excluded.full_name_ar, ai_patient_intakes.full_name_ar),
        full_name_en = coalesce(excluded.full_name_en, ai_patient_intakes.full_name_en),
        updated_at = clock_timestamp()
    where ai_patient_intakes.review_status = 'pending_review'
  returning id into v_intake_id;
  if v_intake_id is null then
    status := 'already_reviewed'; intake_id := null; return next; return;
  end if;

  insert into public.audit_logs (
    clinic_id, action, table_name, record_id, actor_type, source, new_data
  ) values (
    p_clinic_id, 'AI_PATIENT_INTAKE_STAGED', 'ai_patient_intakes', v_intake_id,
    'ai', 'ai_assistant', jsonb_build_object(
      'review_status', 'pending_review', 'department_id', p_department_id,
      'doctor_id', p_doctor_id, 'conversation_id', p_conversation_id,
      'is_third_party', coalesce(p_for_third_party, false),
      'blood_type_supplied', v_blood is not null,
      -- Visible in the trail rather than inferred from it: this intake was
      -- staged past a number an existing patient also uses.
      'shared_contact_phone', v_phone_is_other_person
    )
  );
  update public.conversations c
  set ai_collected_data = coalesce(c.ai_collected_data, '{}'::jsonb)
    || jsonb_build_object(
      'department_id', p_department_id,
      'doctor_id', p_doctor_id
    )
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id;
  status := 'staged'; intake_id := v_intake_id; return next;
end;
$function$;

-- Grants restated to match exactly what the function carries today.
revoke all on function public.stage_patient_intake_from_conversation(
  uuid, uuid, text, text, date, text, uuid, uuid, boolean, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.stage_patient_intake_from_conversation(
  uuid, uuid, text, text, date, text, uuid, uuid, boolean, text, text, text, text, text
) to service_role;

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
  v_requested_by uuid;
  -- Same two as the sibling stager, for the same supersession.
  v_superseded_id uuid;
  v_superseded_requests integer := 0;
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

  -- Every row this function writes is a third-party intake, so the requester
  -- is a precondition of calling it at all — checked before the identity is
  -- proved, because an unattributable request is refused whether or not the
  -- beneficiary turns out to have a file here, and proving the identity first
  -- would let a caller with no standing use `no_match` as an oracle for
  -- whether a given national id is registered at this clinic.
  --
  -- Archived is not absence; deleted is. Same rule as section 6.
  select p.id into v_requested_by
  from public.patients p
  where p.id = v_conversation.patient_id
    and p.clinic_id = p_clinic_id
    and not p.is_deleted and p.deleted_at is null;
  if v_requested_by is null then
    raise exception 'THIRD_PARTY_REQUESTER_NOT_LINKED';
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

  -- Unreachable given the guard above, and asserted rather than trusted.
  if v_requested_by is null then
    raise exception 'THIRD_PARTY_REQUESTER_NOT_LINKED';
  end if;


  -- =================================================================
  -- A pending intake for a *different* beneficiary is superseded, never
  -- overwritten.
  -- =================================================================
  --
  -- The partial unique index below permits one `pending_review` intake per
  -- conversation, and the `on conflict` that follows reuses it. Reuse is
  -- right for a retry — the same person, re-stated, possibly with a
  -- correction — and wrong for a different person: it would rewrite the
  -- pending row's name, date of birth and national id into somebody else's
  -- while any `ai_appointment_requests` row already bound to that
  -- `intake_id` stayed attached. Approving it would then create the new
  -- beneficiary's file and hand them the previous beneficiary's slot.
  --
  -- The discriminator is the folded national id, because that is the
  -- identity boundary everywhere else in this file. **Phone is never
  -- consulted**: families share a number, and two people on one number are
  -- two people. Same folded id -> fall through to the upsert, which updates
  -- in place exactly as it does today. Different folded id -> the pending
  -- row is dismissed and a new row is inserted beside it.
  --
  -- `dismissed` is the status for this and not `rejected`: no human
  -- rejected anything. It carries `reviewed_at` so the moment is on the
  -- record, a null `reviewed_by` because there is no reviewer to name, and
  -- a null `approved_patient_id` because nothing was approved — the exact
  -- shape `ai_patient_intakes_review_shape_check` now admits.
  --
  -- Running under the conversation's `for update` lock, which every caller
  -- of this function already holds by here, makes the supersede and the
  -- insert one indivisible step: a concurrent staging on this conversation
  -- waits, and cannot observe the window between them.
  select i.id into v_superseded_id
  from public.ai_patient_intakes i
  where i.clinic_id = p_clinic_id
    and i.conversation_id = p_conversation_id
    and i.review_status = 'pending_review'
    and i.national_id_folded
        is distinct from public.fold_national_id(v_patient.national_id)
  for update;

  if v_superseded_id is not null then
    update public.ai_patient_intakes i
    set review_status = 'dismissed',
        reviewed_at = clock_timestamp(),
        reviewed_by = null,
        approved_patient_id = null,
        review_reason = 'superseded_by_new_beneficiary',
        updated_at = clock_timestamp()
    where i.id = v_superseded_id and i.clinic_id = p_clinic_id
      and i.review_status = 'pending_review';

    -- The dismissed intake's own provisional booking goes with it, and only
    -- its own: bound by `intake_id`, never by `conversation_id`. A request
    -- belonging to an *approved* historical intake on this thread is another
    -- beneficiary's real booking and is not touched.
    update public.ai_appointment_requests r
    set status = 'dismissed', updated_at = clock_timestamp()
    where r.clinic_id = p_clinic_id and r.intake_id = v_superseded_id
      and r.status = 'pending';
    get diagnostics v_superseded_requests = row_count;

    insert into public.audit_logs (
      clinic_id, action, table_name, record_id, actor_type, source, new_data
    ) values (
      p_clinic_id, 'AI_PATIENT_INTAKE_SUPERSEDED', 'ai_patient_intakes',
      v_superseded_id, 'ai', 'ai_assistant', jsonb_build_object(
        'review_status', 'dismissed',
        'review_reason', 'superseded_by_new_beneficiary',
        'conversation_id', p_conversation_id,
        'dismissed_appointment_requests', v_superseded_requests
      )
    );
  end if;

  insert into public.ai_patient_intakes (
    clinic_id, conversation_id, full_name, date_of_birth, phone, email,
    national_id, department_id, doctor_id, is_third_party, matched_patient_id,
    requested_by_patient_id
  ) values (
    p_clinic_id, p_conversation_id, v_patient.full_name, v_patient.date_of_birth,
    coalesce(nullif(btrim(coalesce(p_phone, '')), ''), v_patient.phone),
    v_patient.email, v_patient.national_id, p_department_id, p_doctor_id, true, v_match,
    v_requested_by
  )
  on conflict (clinic_id, conversation_id)
    where review_status = 'pending_review'
  do update
    set full_name = excluded.full_name,
        date_of_birth = excluded.date_of_birth,
        email = excluded.email,
        national_id = excluded.national_id,
        department_id = excluded.department_id,
        doctor_id = excluded.doctor_id,
        is_third_party = true,
        matched_patient_id = excluded.matched_patient_id,
        -- Written on conflict too: a row being turned into a third-party
        -- intake must gain the requester in the same statement, or an earlier
        -- self-intake on this conversation would keep its null one.
        requested_by_patient_id = excluded.requested_by_patient_id,
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
  'Item #3 - stages a third-party intake that points at an existing patient file instead of proposing a duplicate. Re-proves the identity itself through find_clinic_patient_by_identity; a caller cannot name a patient id. Requires the conversation to be linked to a live patient of this clinic, which becomes requested_by_patient_id. Files the clinic''s own stored details, never the sender''s version of them. D3 - supersedes a pending intake staged for a different folded national id rather than overwriting it.';

revoke all on function public.stage_matched_third_party_intake(uuid, uuid, text, text, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.stage_matched_third_party_intake(uuid, uuid, text, text, text, uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. The provisional request reads one pending intake, deterministically
-- ---------------------------------------------------------------------------
--
-- Ownership and linkage semantics are unchanged: the request is still bound to
-- `v_intake.id`, the per-intake pending cap is still per `intake_id`, and the
-- expiry sweep still touches only this intake's own rows.

create or replace function public.create_provisional_ai_appointment_request(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_doctor_id uuid,
  p_scheduled_at timestamptz,
  p_duration_minutes integer,
  p_service_id uuid default null
)
returns table (request_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_intake public.ai_patient_intakes%rowtype;
  v_ttl integer;
  v_cap integer;
  v_request public.ai_appointment_requests%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  select c.* into v_conversation from public.conversations c
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id
    and c.status = 'open'::public.conversation_status for update;
  if not found then
    raise exception 'PROVISIONAL_INTAKE_REQUIRED';
  end if;
  if v_conversation.ai_paused_at is not null then
    raise exception 'HUMAN_TAKEOVER_ACTIVE' using errcode = '42501';
  end if;
  -- Defence in depth. The partial unique index makes at most one
  -- `pending_review` intake per conversation a database fact, so this can
  -- select only one row; an unordered `select ... into` would silently take an
  -- arbitrary one if that invariant were ever lost. Newest-first is the
  -- correct tie-break, because the newest pending intake is by construction
  -- the one the current beneficiary was staged into.
  select i.* into v_intake from public.ai_patient_intakes i
  where i.clinic_id = p_clinic_id and i.conversation_id = p_conversation_id
    and i.review_status = 'pending_review'
  order by i.created_at desc, i.id desc
  limit 1
  for update;
  if not found or v_intake.doctor_id <> p_doctor_id then
    raise exception 'PROVISIONAL_INTAKE_REQUIRED';
  end if;
  -- A linked conversation reaches this path only on behalf of somebody else.
  if v_conversation.patient_id is not null and not coalesce(v_intake.is_third_party, false) then
    raise exception 'PROVISIONAL_INTAKE_REQUIRED';
  end if;
  if p_service_id is not null and not exists (
    select 1 from public.services s
    where s.id = p_service_id and s.clinic_id = p_clinic_id
      and s.department_id = v_intake.department_id
      and s.is_active and s.deleted_at is null
  ) then raise exception 'AI_BOOKING_SERVICE_UNAVAILABLE'; end if;
  if p_scheduled_at < clock_timestamp() + interval '24 hours' then
    raise exception 'AI_BOOKING_MINIMUM_NOTICE' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ai-intake-booking:' || p_clinic_id::text, 0)
  );
  update public.ai_appointment_requests r
  set status = 'expired', updated_at = clock_timestamp()
  where r.clinic_id = p_clinic_id and r.intake_id = v_intake.id
    and r.status = 'pending' and r.expires_at <= clock_timestamp();
  if not public.ai_requested_slot_is_available(
    p_clinic_id, p_doctor_id, p_scheduled_at, p_duration_minutes
  ) then raise exception 'AI_BOOKING_SLOT_UNAVAILABLE'; end if;
  select c.ai_pending_booking_ttl_minutes, c.ai_pending_slot_cap into v_ttl, v_cap
  from public.clinics c where c.id = p_clinic_id and c.is_active;
  if exists (
    select 1 from public.ai_appointment_requests r
    where r.clinic_id = p_clinic_id and r.intake_id = v_intake.id
      and r.status = 'pending' and r.expires_at > clock_timestamp()
  ) then raise exception 'AI_PENDING_PATIENT_CAP'; end if;
  if (
    (select count(*) from public.ai_appointment_requests r
      where r.clinic_id = p_clinic_id and r.doctor_id = p_doctor_id
        and r.scheduled_at = p_scheduled_at and r.status = 'pending'
        and r.expires_at > clock_timestamp())
    +
    (select count(*) from public.appointments a
      where a.clinic_id = p_clinic_id and a.doctor_id = p_doctor_id
        and a.scheduled_at = p_scheduled_at and a.status = 'pending'::public.appointment_status
        and a.deleted_at is null and a.expires_at > clock_timestamp()
        and (
          a.ai_patient_conversation_id is not null
          or a.ai_workflow_run_id is not null
          or a.ai_action_receipt_id is not null
        ))
  ) >= v_cap then raise exception 'AI_PENDING_SLOT_CAP'; end if;

  insert into public.ai_appointment_requests (
    clinic_id, intake_id, conversation_id, department_id, doctor_id,
    service_id, scheduled_at, duration_minutes, expires_at
  ) values (
    p_clinic_id, v_intake.id, p_conversation_id, v_intake.department_id,
    p_doctor_id, p_service_id, p_scheduled_at, p_duration_minutes,
    clock_timestamp() + make_interval(mins => v_ttl)
  ) returning * into v_request;
  insert into public.audit_logs (
    clinic_id, action, table_name, record_id, actor_type, source, new_data
  ) values (
    p_clinic_id, 'AI_APPOINTMENT_REQUEST_STAGED', 'ai_appointment_requests',
    v_request.id, 'ai', 'ai_assistant', jsonb_build_object(
      'status', 'pending', 'intake_id', v_intake.id,
      'scheduled_at', v_request.scheduled_at, 'doctor_id', p_doctor_id,
      'is_third_party', coalesce(v_intake.is_third_party, false)
    )
  );
  return query select v_request.id, v_request.expires_at;
end;
$$;

revoke all on function public.create_provisional_ai_appointment_request(
  uuid, uuid, uuid, timestamptz, integer, uuid
) from public, anon, authenticated;
grant execute on function public.create_provisional_ai_appointment_request(
  uuid, uuid, uuid, timestamptz, integer, uuid
) to service_role;
