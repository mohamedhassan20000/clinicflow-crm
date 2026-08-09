import { resolveDateRange, type ResolvedDateRange } from "@/lib/date-range";
import type { Locale } from "@/lib/i18n/config";

export type FollowupsDateScope = "day" | "yesterday" | "week" | "month" | "custom";

export type FollowupsDateSearchParams = {
  scope?: string;
  date?: string;
  from?: string;
  to?: string;
};

export type ResolvedFollowupsDateRange = ResolvedDateRange & {
  scope: FollowupsDateScope;
};

export type FollowupsDocumentFilters = {
  doctorId?: string | null;
  departmentId?: string | null;
  outcome?: "all_fine" | "has_problem" | "no_response" | null;
  patientQuery?: string | null;
  patientName?: string | null;
  patientFileNumber?: string | null;
  patientNationalId?: string | null;
  patientPhone?: string | null;
};

function isCalendarDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function shiftCalendarDate(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

export function resolveFollowupsDateRange(
  input: FollowupsDateSearchParams,
  now: Date = new Date(),
): ResolvedFollowupsDateRange {
  const today = resolveDateRange({ preset: "today", now }).from;

  if (
    input.scope === "custom"
    && isCalendarDate(input.from)
    && isCalendarDate(input.to)
    && input.from <= input.to
  ) {
    return {
      scope: "custom",
      ...resolveDateRange({ from: input.from, to: input.to, now }),
    };
  }

  if (input.scope === "yesterday") {
    const date = shiftCalendarDate(today, -1);
    return { scope: "yesterday", ...resolveDateRange({ from: date, to: date, now }) };
  }

  if (input.scope === "week") {
    const to = shiftCalendarDate(today, -1);
    const from = shiftCalendarDate(to, -6);
    return { scope: "week", ...resolveDateRange({ from, to, now }) };
  }

  if (input.scope === "month") {
    const to = shiftCalendarDate(today, -1);
    const from = shiftCalendarDate(to, -29);
    return { scope: "month", ...resolveDateRange({ from, to, now }) };
  }

  const date = isCalendarDate(input.date) ? input.date : today;
  return { scope: "day", ...resolveDateRange({ from: date, to: date, now }) };
}

export function buildFollowupsDocumentHref({
  range,
  locale,
  filters,
}: {
  range: Pick<ResolvedFollowupsDateRange, "from" | "to">;
  locale: Locale;
  filters: FollowupsDocumentFilters;
}): string {
  const query = new URLSearchParams({
    preset: "custom",
    from: range.from,
    to: range.to,
    locale,
    origin: "followups",
  });
  const entries: [string, string | null | undefined][] = [
    ["doctor", filters.doctorId],
    ["department", filters.departmentId],
    ["outcome", filters.outcome],
    ["q", filters.patientQuery],
    ["name", filters.patientName],
    ["file", filters.patientFileNumber],
    ["nat", filters.patientNationalId],
    ["phone", filters.patientPhone],
  ];
  for (const [key, value] of entries) {
    const cleaned = value?.trim();
    if (cleaned) query.set(key, cleaned);
  }
  return `/reports/follow-ups/document?${query.toString()}`;
}
