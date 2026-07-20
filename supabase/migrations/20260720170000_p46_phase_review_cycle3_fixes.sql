-- P4.6 phase review #3 fixes — make small-cell suppression a self-contained
-- property of `ai_get_patient_stats` instead of a property of its payload.
--
-- Closes H1 (and, as a consequence, M1 and L4) of
-- docs/reviews/P4.6_PHASE_REVIEW_CYCLE3.md.
--
-- Nothing here loosens an authorization rule. The guard, the role matrix, the
-- entitlement check and the per-user grant check are all untouched.
--
-- ---------------------------------------------------------------------------
-- The defect
-- ---------------------------------------------------------------------------
--
-- Since review #1's H1 fix, suppression protected the hidden buckets by
-- refusing to publish an exact total: `patients_total` was nulled and only a
-- floor-rounded `patients_total_approx` was emitted, so the suppressed residual
-- could not be recovered by subtracting the visible buckets.
--
-- That defence only works if no *other* reachable tool publishes the same
-- total. One does. `ai_get_clinic_summary` returns
--
--     'patients_total', (select count(*) from public.patients pt
--                        where pt.clinic_id = v_clinic_id and not pt.is_deleted)
--
-- exactly and unsuppressed, and it carries the identical `roles` and
-- `requiredFeatures` in the tool registry — so the two tools mount together,
-- for the same user, on the same turn, always. Review #3 reproduced the
-- reversal live: a clinic with 100 O+, 4 A+, 3 B+ published `<5` for both small
-- buckets and 100 for the visible one, while the sibling RPC published 107.
-- 107 - 100 = 7, and two buckets each bounded to 1..4 by their own `<5` label
-- and emitted in descending order give A+ = 4 and B+ = 3 exactly. Both cells
-- recovered with certainty. A second vector existed inside this function's own
-- payload: `patients_new_in_range` is an exact unsuppressed count over the same
-- table, and equals the withheld total whenever the range covers the clinic's
-- history.
--
-- ---------------------------------------------------------------------------
-- The fix, and why this shape
-- ---------------------------------------------------------------------------
--
-- Hiding the total everywhere was the other option and it is the wrong one: it
-- would couple `ai_get_clinic_summary`'s headline figure to whether some
-- *other* grouping would suppress, it would still leave `patients_new_in_range`
-- summable across windows, and it would leave the invariant spread over five
-- functions that each have to keep it independently.
--
-- Instead the distribution stops needing the total to be secret. Suppressed
-- categories are no longer emitted as individually labelled cells with a `<5`
-- bound; they are **generalized into a single aggregate bucket** carrying the
-- exact residual and no category names. This is the standard k-anonymity
-- generalization, and it is what the cycle-2 fixes report gestured at when it
-- said a grouping that needs to be useful at small N "requires a different
-- construction (wider buckets, or a k-anonymity-preserving generalization), not
-- a different label".
--
-- The suppression *selection* is preserved byte-for-byte — primary suppression
-- below the floor, then complementary extension until at least two buckets are
-- hidden and their sum reaches the floor. That loop is what guarantees the
-- aggregate is safe to publish exactly:
--
--   * at least 2 categories are folded in, so the aggregate is never one
--     category's count wearing a different name; and
--   * the aggregate is >= the floor, so it is not itself a small cell.
--
-- Given that, subtraction reveals nothing: `patients_total` minus the visible
-- buckets *is* the aggregate, which is published outright. So the total can go
-- back to being exact, which in turn:
--
--   * removes the contradiction with `ai_get_clinic_summary` (they now agree);
--   * removes `patients_total_approx` entirely, and with it M1 — a clinic with
--     2 patients used to publish `patients_total_approx: 0`, because
--     round(2/5)*5 = 0, i.e. "approximately no patients" for a clinic that has
--     some; and
--   * removes the need for `patients_new_in_range` to be bounded, since there
--     is no longer a secret for it to confirm.
--
-- It also closes L4. Previously a below-floor bucket was still *named* in the
-- partial-suppression case ("this clinic has between 1 and 4 AB+ patients"),
-- while the fully-suppressed case removed the names entirely on the stated
-- reasoning that publishing a label "for nothing in return" was the wrong
-- trade. The two cases now take the same position: a suppressed category is
-- never named.
--
-- The `below_floor` / `complementary` distinction introduced by review #2's H1
-- disappears with the labels it was created to make truthful. That is not a
-- regression of that fix — it is its terminal form. H1 of review #2 was that a
-- complementary bucket was falsely described as "<5"; no bucket now carries any
-- numeric claim about a category at all.
--
-- Fully suppressed distributions are still declined via `distribution_withheld`
-- rather than emitted as one aggregate equal to the total, which would be an
-- information-free payload dressed as data.

create or replace function public.ai_get_patient_stats(
  p_start timestamptz,
  p_end timestamptz,
  p_group_by text default 'department'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid := public.ai_assert_analytics_caller('clinic_analytics');
  v_floor constant integer := 5;
  v_rows jsonb[];
  v_buckets jsonb := '[]'::jsonb;
  v_total bigint;
  v_new bigint;
  v_count integer;
  v_suppressed integer := 0;
  v_suppressed_sum bigint := 0;
  v_index integer;
  v_bucket_total bigint;
  v_withheld boolean;
begin
  if p_group_by not in ('department', 'blood_type', 'assigned_doctor') then
    raise exception 'Unsupported grouping' using errcode = '22023';
  end if;

  select count(*) into v_total
  from public.patients pt
  where pt.clinic_id = v_clinic_id and not pt.is_deleted;

  select count(*) into v_new
  from public.patients pt
  where pt.clinic_id = v_clinic_id and not pt.is_deleted
    and pt.created_at >= p_start and pt.created_at <= p_end;

  -- Ascending by size, so "suppress the smallest still-visible bucket" is
  -- simply "extend the suppressed prefix by one".
  with grouped as (
    select
      case p_group_by
        when 'department' then coalesce(d.name, 'Unassigned')
        when 'blood_type' then coalesce(pt.blood_type::text, 'Unknown')
        else coalesce(doc.full_name, 'Unassigned')
      end as bucket,
      count(*) as total
    from public.patients pt
    left join public.departments d on d.id = pt.department_id
    left join public.profiles doc on doc.id = pt.assigned_doctor_id
    where pt.clinic_id = v_clinic_id and not pt.is_deleted
    group by 1
  )
  select coalesce(
    array_agg(
      jsonb_build_object('bucket', g.bucket, 'total', g.total)
      order by g.total asc, g.bucket asc
    ),
    array[]::jsonb[]
  )
  into v_rows
  from grouped g;

  v_count := coalesce(array_length(v_rows, 1), 0);

  -- 1. Primary suppression: every bucket strictly below the floor. Unchanged.
  while v_suppressed < v_count
    and (v_rows[v_suppressed + 1] ->> 'total')::bigint < v_floor
  loop
    v_suppressed := v_suppressed + 1;
    v_suppressed_sum := v_suppressed_sum + (v_rows[v_suppressed] ->> 'total')::bigint;
  end loop;

  -- 2. Complementary suppression: never fold in a single category on its own
  --    (the aggregate would just be that category's count under another name),
  --    and never publish an aggregate that is itself below the floor.
  --    Unchanged — this loop is precisely what makes the aggregate publishable.
  while v_suppressed > 0
    and v_suppressed < v_count
    and (v_suppressed < 2 or v_suppressed_sum < v_floor)
  loop
    v_suppressed := v_suppressed + 1;
    v_suppressed_sum := v_suppressed_sum + (v_rows[v_suppressed] ->> 'total')::bigint;
  end loop;

  -- A distribution in which nothing survives is declined, not emitted: one
  -- aggregate bucket equal to the total says nothing the total does not.
  v_withheld := v_count > 0 and v_suppressed = v_count;

  if not v_withheld then
    -- Visible buckets, largest first, exact.
    for v_index in reverse v_count..(v_suppressed + 1) loop
      v_bucket_total := (v_rows[v_index] ->> 'total')::bigint;
      v_buckets := v_buckets || jsonb_build_array(
        jsonb_build_object(
          'bucket', v_rows[v_index] ->> 'bucket',
          'count', v_bucket_total,
          'display', v_bucket_total::text,
          'suppressed', false,
          'suppression_reason', null,
          'grouped_bucket_count', null
        )
      );
    end loop;

    -- One generalized bucket for everything suppressed. Its count is exact and
    -- safe to publish (>= 2 categories, >= the floor), and it names none of the
    -- categories it covers — which is the whole of the privacy claim.
    if v_suppressed > 0 then
      v_buckets := v_buckets || jsonb_build_array(
        jsonb_build_object(
          'bucket', 'Other',
          'count', v_suppressed_sum,
          'display', v_suppressed_sum::text,
          'suppressed', true,
          'suppression_reason', 'aggregated',
          'grouped_bucket_count', v_suppressed
        )
      );
    end if;
  end if;

  return jsonb_build_object(
    'range', jsonb_build_object('start', p_start, 'end', p_end),
    'group_by', p_group_by,
    -- Exact, always. The aggregate bucket is published outright, so subtracting
    -- the visible buckets from the total yields a number the payload already
    -- states. This also means this figure agrees with `ai_get_clinic_summary`'s
    -- `patients_total` instead of contradicting it.
    'patients_total', v_total,
    'patients_total_exact', true,
    'patients_new_in_range', v_new,
    'suppression_floor', v_floor,
    -- How many categories were folded into the aggregate, and how many patients
    -- that aggregate covers. Both are safe by the loops above.
    'suppressed_bucket_count', v_suppressed,
    'suppressed_patient_count', case when v_suppressed = 0 then 0 else v_suppressed_sum end,
    -- Named for what it is: the distribution is over the whole patient
    -- population, not the requested range. Only `patients_new_in_range`
    -- respects p_start/p_end, and the model must not describe these buckets as
    -- belonging to the range.
    'bucket_scope', 'all_time',
    'distribution_withheld', v_withheld,
    'distribution_withheld_reason',
      case when v_withheld then 'all_buckets_suppressed' else null end,
    'buckets_all_time', v_buckets
  );
end;
$$;
