import "server-only";

import { z } from "zod";
import { resolveDateRange, type ResolvedDateRange } from "@/lib/date-range";
import { ISO_DATE_RE } from "@/lib/ai/tools/context";

/**
 * Shared date-range input for every P4.6A analytics/list tool.
 *
 * It resolves through the same `resolveDateRange` core the reports pages use,
 * so an assistant answer and the report a user can open themselves are computed
 * over byte-identical bounds. The model may name a preset or an explicit
 * from/to pair; it can never supply raw timestamps or a timezone.
 */
export const dateRangeInputSchema = z.object({
  preset: z
    .enum(["today", "this_week", "this_month", "custom"])
    .default("this_month")
    .describe("Named range. Use 'custom' together with date_from/date_to."),
  date_from: z
    .string()
    .regex(ISO_DATE_RE)
    .optional()
    .describe("Start date (YYYY-MM-DD). Required when preset is 'custom'."),
  date_to: z
    .string()
    .regex(ISO_DATE_RE)
    .optional()
    .describe("End date (YYYY-MM-DD). Required when preset is 'custom'."),
});

export type DateRangeInput = z.infer<typeof dateRangeInputSchema>;

/** Hard cap so no tool can be steered into an unbounded historical scan. */
export const MAX_RANGE_DAYS = 400;

/**
 * A resolved range plus what the caller actually asked for. The clamp used to
 * be silent: an over-long or malformed request quietly became `this_month`, and
 * the model learned about the substitution only by noticing the echoed range
 * disagreed with its argument — so the honest failure mode was an assistant
 * confidently answering a question nobody asked. Carrying `clamped` lets it say
 * "I limited that to this month" instead.
 */
export type ToolDateRange = ResolvedDateRange & {
  clamped: boolean;
  requested: { from: string; to: string } | null;
};

/**
 * The single clamping path for every tool range, including the two explicit
 * periods of `compare_revenue_periods`. That tool previously called
 * `resolveDateRange` directly and so escaped the cap entirely — the most
 * expensive tool in the phase (two full aggregate reads over appointments,
 * settlements, and deposits) was the one able to request all of history.
 */
export function resolveToolDateRange(input: DateRangeInput): ToolDateRange {
  const requested =
    input.preset === "custom" && input.date_from && input.date_to
      ? { from: input.date_from, to: input.date_to }
      : null;

  const range =
    requested !== null
      ? resolveDateRange({ preset: "custom", from: requested.from, to: requested.to })
      : resolveDateRange({ preset: input.preset === "custom" ? "this_month" : input.preset });

  // A 'custom' preset without both dates is also a substitution the model needs
  // told about, not just an over-long span.
  const incomplete = input.preset === "custom" && requested === null;
  const spanDays = (range.end.getTime() - range.start.getTime()) / 86_400_000;

  if (incomplete || spanDays > MAX_RANGE_DAYS || range.end < range.start) {
    return {
      ...resolveDateRange({ preset: "this_month" }),
      clamped: true,
      requested,
    };
  }
  return { ...range, clamped: false, requested: null };
}

/** Clamps an explicit from/to pair — the `compare_revenue_periods` shape. */
export function resolveToolPeriod(period: { date_from: string; date_to: string }): ToolDateRange {
  return resolveToolDateRange({
    preset: "custom",
    date_from: period.date_from,
    date_to: period.date_to,
  });
}

/** Compact, content-free range descriptor returned to the model. */
export function describeRange(range: ToolDateRange) {
  return {
    preset: range.preset,
    from: range.from,
    to: range.to,
    clamped: range.clamped,
    ...(range.clamped
      ? {
          clamp_note: range.requested
            ? `The requested range ${range.requested.from}..${range.requested.to} exceeds the ${MAX_RANGE_DAYS}-day limit, so this month was used instead. Tell the user the range was narrowed.`
            : `The requested range was incomplete, so this month was used instead. Tell the user which range was actually used.`,
        }
      : {}),
  };
}
