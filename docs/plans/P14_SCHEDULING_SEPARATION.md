# P14 · Clinic working hours vs. staff shift templates

## Root cause

`Clinic settings → Working hours` was serving two different concepts at once.
It stored the clinic's opening intervals in `clinic_working_hours` (rightly
validated as non-overlapping, max 2 per day), and the staff schedule editor then
*derived* the staff shift choices from those same rows — the "Shift 1 / Shift 2 /
Both shifts" buttons in `StaffScheduleTab` came straight from
`staffIntervalForClinicShift(clinicDay.shifts, choice)`.

To give staff a Morning 09:00–17:00 and an Evening 15:00–22:00, an admin had to
enter those as two *clinic* intervals, which the clinic-hours overlap rule
correctly rejected. The rule was right; the concept was overloaded.

## Model

Two independent concepts, and a third that stays authoritative:

| Concept | Table | Overlap | Meaning |
|---|---|---|---|
| Clinic opening intervals | `clinic_working_hours` | forbidden | when the clinic is open |
| Staff shift templates | `staff_shift_templates` | **allowed** | reusable named shifts |
| Staff schedule | `doctor_schedules` | merged disjoint | the concrete hours the engine reads |

## Template persistence — model B (copy by value)

Selecting a template copies its concrete hours into `doctor_schedules`. The
scheduling engine never reads a template name or id.

Consequences, deliberately chosen:

- Editing `Morning` from 09:00–17:00 to 10:00–18:00 does **not** move any saved
  staff schedule, past or future. No silent cascade.
- Historical appointments are concrete timestamps and are untouched either way.
- A schedule whose hours no longer match any template simply reads back as
  *Custom hours* in the editor. Re-picking the template applies the new hours.

Model A (assignments reference the template, availability follows edits) was
rejected: it makes future availability depend on a mutable label, which is the
class of surprise this cleanup exists to remove.

## Multiple templates on one staff day

A staff weekday may now hold more than one interval. Picks are merged before
persisting:

- Morning 09:00–17:00 + Evening 15:00–22:00 → one row, 09:00–22:00.
  The 15:00–17:00 overlap yields no duplicate slots.
- Morning 09:00–13:00 + Evening 16:00–22:00 → two rows, and 13:00–16:00 stays
  unbookable.

## Availability

Unchanged in authority. A bookable slot is inside the clinic's opening
intervals **and** inside the staff member's own intervals, and still passes every
existing appointment/slot/capacity constraint. `computeAvailability` now unions
the staff member's intervals for the day and intersects that union with the
clinic's, instead of reading a single row.

## Backward compatibility

- The pre-P14 staff payload (`{works, start_time, end_time}`) is still accepted
  and normalizes to a single interval.
- Existing `doctor_schedules` rows are untouched; one row per day is simply a
  one-interval day.
- `ds_unique (doctor_id, day_of_week)` is replaced by
  `ds_unique_interval (doctor_id, day_of_week, start_time)`, which every existing
  row already satisfies.
- The SQL booking guards (`exists (… start_time <= t and end_time >= t+dur)`)
  already handled several rows per day correctly and were not changed.
