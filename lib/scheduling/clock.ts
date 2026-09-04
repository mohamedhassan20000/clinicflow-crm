export type ClockShift = {
  shift_start: string;
  shift_end: string;
};

export type StaffIntervalValidation =
  | {
      ok: true;
      start: string;
      end: string;
      clinicOpen: string;
      clinicClose: string;
    }
  | {
      ok: false;
      reason: "invalid_interval" | "outside_clinic_hours";
      clinicOpen: string | null;
      clinicClose: string | null;
    };

/** Parse database `HH:mm:ss` and form `HH:mm` values into one comparable unit. */
export function clockMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Canonical form persisted by settings forms; seconds are display/database noise. */
export function canonicalClock(value: string | null | undefined): string | null {
  const minutes = clockMinutes(value);
  if (minutes === null) return null;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function clinicShiftsOverlap(shifts: readonly ClockShift[]): boolean {
  const ordered = shifts
    .map((shift) => ({
      start: clockMinutes(shift.shift_start),
      end: clockMinutes(shift.shift_end),
    }))
    .filter((shift): shift is { start: number; end: number } =>
      shift.start !== null && shift.end !== null && shift.end > shift.start,
    )
    .sort((left, right) => left.start - right.start);
  return ordered.some((shift, index) => index > 0 && shift.start < ordered[index - 1]!.end);
}

/**
 * Validate a single stored staff interval against one or two clinic shifts.
 * A doctor selecting both shifts stores their outer boundaries; availability
 * still intersects that interval with each clinic shift, so a gap stays closed.
 */
export function validateStaffInterval(
  startValue: string,
  endValue: string,
  shifts: readonly ClockShift[],
): StaffIntervalValidation {
  const normalized = shifts
    .map((shift) => ({
      start: clockMinutes(shift.shift_start),
      end: clockMinutes(shift.shift_end),
      startLabel: canonicalClock(shift.shift_start),
      endLabel: canonicalClock(shift.shift_end),
    }))
    .filter((shift): shift is {
      start: number;
      end: number;
      startLabel: string;
      endLabel: string;
    } => shift.start !== null && shift.end !== null && shift.startLabel !== null && shift.endLabel !== null && shift.end > shift.start)
    .sort((left, right) => left.start - right.start);
  const clinicOpen = normalized[0]?.startLabel ?? null;
  const clinicClose = normalized.at(-1)?.endLabel ?? null;
  const start = clockMinutes(startValue);
  const end = clockMinutes(endValue);
  if (start === null || end === null || end <= start) {
    return { ok: false, reason: "invalid_interval", clinicOpen, clinicClose };
  }
  if (normalized.length === 0) {
    return { ok: false, reason: "outside_clinic_hours", clinicOpen, clinicClose };
  }

  // Inclusive outer boundaries. Each endpoint must also touch a real shift;
  // this rejects intervals wholly inside a between-shift closure while still
  // allowing the explicit "both shifts" outer interval.
  const startInside = normalized.some((shift) => start >= shift.start && start < shift.end);
  const endInside = normalized.some((shift) => end > shift.start && end <= shift.end);
  if (
    start < normalized[0]!.start ||
    end > normalized.at(-1)!.end ||
    !startInside ||
    !endInside
  ) {
    return { ok: false, reason: "outside_clinic_hours", clinicOpen, clinicClose };
  }
  return {
    ok: true,
    start: canonicalClock(startValue)!,
    end: canonicalClock(endValue)!,
    clinicOpen: clinicOpen!,
    clinicClose: clinicClose!,
  };
}

// ── Staff shift templates (P14) ───────────────────────────────────────────────
// Staff shift templates are a separate concept from clinic opening intervals:
// clinic intervals answer "when is the clinic open?" and must not overlap,
// while templates are reusable named staff shifts that MAY overlap
// (Morning 09:00–17:00 and Evening 15:00–22:00 are both valid at once).

export type ClockInterval = { start: string; end: string };

/** Maximum number of enabled templates surfaced in the settings UI. */
export const MAX_ENABLED_SHIFT_TEMPLATES = 3;

/**
 * Merge staff intervals into a minimal disjoint set.
 * Overlapping or touching intervals collapse into their union so a staff day
 * never produces duplicate slots; a genuine gap between intervals is kept.
 */
export function mergeIntervals(
  intervals: readonly { start: string; end: string }[],
): ClockInterval[] {
  const ordered = intervals
    .map((interval) => ({
      start: clockMinutes(interval.start),
      end: clockMinutes(interval.end),
    }))
    .filter((interval): interval is { start: number; end: number } =>
      interval.start !== null && interval.end !== null && interval.end > interval.start,
    )
    .sort((left, right) => left.start - right.start);

  const merged: { start: number; end: number }[] = [];
  for (const interval of ordered) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
      continue;
    }
    merged.push({ ...interval });
  }
  return merged.map((interval) => ({
    start: minutesToClock(interval.start),
    end: minutesToClock(interval.end),
  }));
}

export function minutesToClock(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

/** A template resolves to the concrete interval copied into a staff schedule. */
export function templateInterval(template: {
  start_time: string;
  end_time: string;
}): ClockInterval | null {
  const start = canonicalClock(template.start_time);
  const end = canonicalClock(template.end_time);
  if (!start || !end || clockMinutes(end)! <= clockMinutes(start)!) return null;
  return { start, end };
}

/** True when the staff day's merged intervals exactly match this template set. */
export function intervalsMatchTemplates(
  intervals: readonly { start: string; end: string }[],
  templates: readonly { start_time: string; end_time: string }[],
): boolean {
  const left = mergeIntervals(intervals);
  const right = mergeIntervals(
    templates.flatMap((template) => {
      const interval = templateInterval(template);
      return interval ? [interval] : [];
    }),
  );
  if (left.length !== right.length) return false;
  return left.every(
    (interval, index) =>
      interval.start === right[index]!.start && interval.end === right[index]!.end,
  );
}

type NamedTemplate = { start_time: string; end_time: string };

/**
 * Which templates (if any) exactly reproduce a staff day's saved intervals.
 * Templates are copied by value into the schedule, so the selection is
 * recovered from the concrete hours rather than a stored template id —
 * renaming or re-timing a template can never move a saved staff schedule.
 */
export function matchTemplateSelection(
  intervals: readonly { start_time: string; end_time: string }[],
  templates: readonly NamedTemplate[],
): Set<number> | null {
  if (intervals.length === 0 || templates.length === 0) return null;
  const normalized = intervals.map((i) => ({ start: i.start_time, end: i.end_time }));
  const total = 1 << templates.length;
  for (let mask = 1; mask < total; mask += 1) {
    const picked = templates.filter((_, index) => (mask >> index) & 1);
    if (!intervalsMatchTemplates(normalized, picked)) continue;
    const selection = new Set<number>();
    templates.forEach((_, index) => {
      if ((mask >> index) & 1) selection.add(index);
    });
    return selection;
  }
  return null;
}

/** The concrete, merged intervals a template selection resolves to. */
export function intervalsForSelection(
  selection: ReadonlySet<number>,
  templates: readonly NamedTemplate[],
): { start_time: string; end_time: string }[] {
  return mergeIntervals(
    [...selection]
      .sort((a, b) => a - b)
      .flatMap((index) => {
        const template = templates[index];
        return template ? [{ start: template.start_time, end: template.end_time }] : [];
      }),
  ).map((interval) => ({ start_time: interval.start, end_time: interval.end }));
}
