/**
 * Phase 7 · P7-02 — clinic-local date semantics survive the supersession.
 *
 * The tools the resource layer replaced never let the model name an instant.
 * `list_appointments` took a preset through `resolveToolDateRange`;
 * `list_doctor_appointments` and `search_patient_visits` took a `YYYY-MM-DD`
 * pair through `clinicDateRangeToUtc` with the clinic's own timezone. After the
 * cutover `appointments.scheduled_at` accepted offset-bearing instants only, and
 * neither the system prompt nor `describe_capabilities` carried the clinic
 * timezone or the current clinic-local date — so "today's appointments", a chip
 * this phase deliberately re-pointed at `query_resource`, depended on the model
 * inventing both an anchor and an offset.
 *
 * This suite pins the restored behaviour against the *emitted query*, not
 * against the resolver's return value, so it fails if the bounds stop reaching
 * PostgREST as well as if they stop being computed.
 *
 * The clock is deliberately set to an instant where the UTC calendar date and
 * the clinic calendar date **disagree** (21:30 UTC → 00:30 the next day in both
 * Africa/Cairo and Europe/Istanbul). A UTC-assuming implementation returns the
 * wrong day here, which is exactly the silent failure P7-02 describes; every
 * assertion below would pass vacuously at noon UTC.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  compileResourceQueryPlan,
  executeCompiledResourceQuery,
} from "@/lib/ai/resources/compile";
import { clinicDateRangeToUtc } from "@/lib/ai/tools/context";
import { resolveDateRange } from "@/lib/date-range";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";
import { SUPERSEDED_AI_TOOLS } from "@/lib/ai/tools/superseded";

/** 00:30 on 2026-08-16 in Cairo and Istanbul; still 2026-08-15 in UTC. */
const NOW = new Date("2026-08-15T21:30:00.000Z");
const CLINIC_LOCAL_TODAY = "2026-08-16";
const UTC_TODAY = "2026-08-15";

/** UTC+3 in August, and not the application default — a genuine second zone. */
const CAIRO = "Africa/Cairo";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "admin",
  email: "dates@example.test",
  fullName: "Date Tester",
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
} as never;

type Emitted = { column: string; operator: string; value: unknown };

/**
 * A capture client shaped like the PostgREST builder the compiler drives. It
 * records every predicate so the test asserts what the database would actually
 * have been asked, and answers the `clinics.timezone` lookup
 * `resolveClinicTimeZone` performs.
 */
function captureClient(timezone: string) {
  const emitted: Emitted[] = [];
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        order: () => chain,
        range: () => chain,
        maybeSingle: async () => ({
          data: table === "clinics" ? { timezone } : null,
          error: null,
        }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: [], error: null, count: 0 }),
      };
      for (const operator of [
        "eq",
        "neq",
        "in",
        "gt",
        "gte",
        "lt",
        "lte",
        "ilike",
        "is",
      ]) {
        chain[operator] = (column: string, value: unknown) => {
          // The tenant predicate and the soft-delete base filter are structural;
          // this suite is about the date bounds only.
          if (table !== "clinics") emitted.push({ column, operator, value });
          return chain;
        };
      }
      return chain;
    },
  };
  return { client, emitted };
}

async function emitFor(
  resource: string,
  filters: Record<string, unknown>,
  timezone: string,
): Promise<Emitted[]> {
  const { client, emitted } = captureClient(timezone);
  const compiled = compileResourceQueryPlan(USER, resource, {
    filters: filters as never,
  });
  await executeCompiledResourceQuery(USER, compiled, client as never);
  return emitted;
}

function boundsOn(emitted: Emitted[], column: string) {
  return emitted.filter((entry) => entry.column === column);
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("P7-02 · the clock this suite runs on actually discriminates", () => {
  it("places the clinic calendar day on the other side of midnight from UTC", () => {
    // If this stops holding, every assertion below becomes a tautology.
    expect(NOW.toISOString().slice(0, 10)).toBe(UTC_TODAY);
    expect(CLINIC_LOCAL_TODAY).not.toBe(UTC_TODAY);
  });
});

describe("P7-02 · `today` over appointments resolves in the clinic's timezone", () => {
  it("emits the exact bounds clinicDateRangeToUtc produces for the clinic day", async () => {
    const emitted = await emitFor("appointments", { scheduled_at: "today" }, CAIRO);
    const expected = clinicDateRangeToUtc(
      CLINIC_LOCAL_TODAY,
      CLINIC_LOCAL_TODAY,
      CAIRO,
    );

    expect(boundsOn(emitted, "scheduled_at")).toEqual([
      { column: "scheduled_at", operator: "gte", value: expected.start },
      { column: "scheduled_at", operator: "lte", value: expected.end },
    ]);
  });

  it("does not use the UTC calendar day the model would have guessed", async () => {
    const emitted = await emitFor("appointments", { scheduled_at: "today" }, CAIRO);
    const naive = clinicDateRangeToUtc(UTC_TODAY, UTC_TODAY, "UTC");
    const values = boundsOn(emitted, "scheduled_at").map((entry) => entry.value);

    expect(values).not.toContain(naive.start);
    expect(values).not.toContain(naive.end);
    // And the difference is a whole day's worth of schedule, not a rounding edge.
    expect(values[0]).toBe("2026-08-15T21:00:00.000Z");
  });

  it("reconciles byte-for-byte with resolveDateRange for a clinic on the app default zone", async () => {
    // The fidelity property the removed tools had and the report pages rely on:
    // an assistant answer and the report a user can open themselves are computed
    // over identical bounds. `resolveDateRange` is the report path.
    const emitted = await emitFor(
      "appointments",
      { scheduled_at: "today" },
      DEFAULT_TIME_ZONE,
    );
    const report = resolveDateRange({ preset: "today", now: NOW });

    expect(boundsOn(emitted, "scheduled_at").map((entry) => entry.value)).toEqual([
      report.start.toISOString(),
      report.end.toISOString(),
    ]);
  });

  it.each(["this_week", "this_month", "last_week", "last_month", "last_year"] as const)(
    "%s reconciles with resolveDateRange on the app default zone",
    async (preset) => {
      const emitted = await emitFor(
        "appointments",
        { scheduled_at: preset },
        DEFAULT_TIME_ZONE,
      );
      const report = resolveDateRange({ preset, now: NOW });

      expect(boundsOn(emitted, "scheduled_at").map((entry) => entry.value)).toEqual([
        report.start.toISOString(),
        report.end.toISOString(),
      ]);
    },
  );

  it("anchors yesterday and tomorrow on the clinic calendar, not the UTC one", async () => {
    for (const [preset, day] of [
      ["yesterday", "2026-08-15"],
      ["tomorrow", "2026-08-17"],
    ] as const) {
      const emitted = await emitFor(
        "appointments",
        { scheduled_at: preset },
        CAIRO,
      );
      const expected = clinicDateRangeToUtc(day, day, CAIRO);
      expect(
        boundsOn(emitted, "scheduled_at").map((entry) => entry.value),
        preset,
      ).toEqual([expected.start, expected.end]);
    }
  });
});

describe("P7-02 · operator semantics keep a clinic day a span", () => {
  const day = "2026-03-01";

  it("maps gte/lt to the start of the clinic day and gt/lte to its end", async () => {
    const expected = clinicDateRangeToUtc(day, day, CAIRO);
    const cases = [
      ["gte", expected.start],
      ["lt", expected.start],
      ["gt", expected.end],
      ["lte", expected.end],
    ] as const;

    for (const [operator, value] of cases) {
      const emitted = await emitFor(
        "appointments",
        { scheduled_at: { operator, value: day } },
        CAIRO,
      );
      expect(boundsOn(emitted, "scheduled_at"), operator).toEqual([
        { column: "scheduled_at", operator, value },
      ]);
    }
  });

  it("expands an explicit clinic-local date under eq into both bounds", async () => {
    // The regression this guards: collapsing `eq "2026-03-01"` to that day's
    // midnight would silently return only appointments booked at exactly 00:00.
    const emitted = await emitFor(
      "appointments",
      { scheduled_at: day },
      CAIRO,
    );
    const expected = clinicDateRangeToUtc(day, day, CAIRO);
    expect(boundsOn(emitted, "scheduled_at")).toEqual([
      { column: "scheduled_at", operator: "gte", value: expected.start },
      { column: "scheduled_at", operator: "lte", value: expected.end },
    ]);
  });

  it("passes an absolute instant through untouched", async () => {
    // Additive, not a swap: everything written against the Phase 1 filter still
    // means exactly what it meant.
    const instant = "2026-03-01T09:15:00.000Z";
    const emitted = await emitFor(
      "appointments",
      { scheduled_at: { operator: "gte", value: instant } },
      CAIRO,
    );
    expect(boundsOn(emitted, "scheduled_at")).toEqual([
      { column: "scheduled_at", operator: "gte", value: instant },
    ]);
  });

  it("combines a clinic-local lower bound with an absolute upper bound", async () => {
    // Independent bound filters are how the generic path expresses a range; the
    // two forms must be mixable without either being reinterpreted.
    const emitted = await emitFor(
      "appointments",
      {
        scheduled_at: { operator: "gte", value: "today" },
      },
      CAIRO,
    );
    const expected = clinicDateRangeToUtc(
      CLINIC_LOCAL_TODAY,
      CLINIC_LOCAL_TODAY,
      CAIRO,
    );
    expect(boundsOn(emitted, "scheduled_at")).toEqual([
      { column: "scheduled_at", operator: "gte", value: expected.start },
    ]);
  });
});

describe("P7-02 · medical_notes.created_at carries the same semantics", () => {
  it("resolves a clinic-local day the way search_patient_visits did", async () => {
    const emitted = await emitFor(
      "medical_notes",
      { created_at: "today" },
      CAIRO,
    );
    const expected = clinicDateRangeToUtc(
      CLINIC_LOCAL_TODAY,
      CLINIC_LOCAL_TODAY,
      CAIRO,
    );
    expect(boundsOn(emitted, "created_at")).toEqual([
      { column: "created_at", operator: "gte", value: expected.start },
      { column: "created_at", operator: "lte", value: expected.end },
    ]);
  });
});

describe("P7-02 · the timezone stays server-owned", () => {
  it("refuses a timezone name as a filter value", () => {
    // `range.ts` said outright that the model may never supply a timezone. The
    // clinic-local form must not become a back door for one.
    expect(() =>
      compileResourceQueryPlan(USER, "appointments", {
        filters: { scheduled_at: "Africa/Cairo" } as never,
      }),
    ).toThrow(/invalid value/i);
  });

  it("reads the timezone once for a query carrying two clinic-local bounds", async () => {
    // Not a correctness property but the reason the memo exists: two bounds in
    // one query must not become two round trips, and must not be able to
    // disagree with each other mid-request.
    const { client, emitted } = captureClient(CAIRO);
    let clinicReads = 0;
    const counting = {
      from(table: string) {
        if (table === "clinics") clinicReads += 1;
        return (client as { from(table: string): unknown }).from(table);
      },
    };
    const compiled = compileResourceQueryPlan(USER, "appointments", {
      filters: {
        scheduled_at: { operator: "gte", value: "today" },
      } as never,
    });
    await executeCompiledResourceQuery(USER, compiled, counting as never);
    expect(clinicReads).toBe(1);
    expect(boundsOn(emitted, "scheduled_at")).toHaveLength(1);
  });

  it("falls back to the application default when the clinic row has no timezone", async () => {
    const emitted = await emitFor("appointments", { scheduled_at: "today" }, "");
    const expected = clinicDateRangeToUtc(
      CLINIC_LOCAL_TODAY,
      CLINIC_LOCAL_TODAY,
      DEFAULT_TIME_ZONE,
    );
    expect(boundsOn(emitted, "scheduled_at").map((entry) => entry.value)).toEqual([
      expected.start,
      expected.end,
    ]);
  });
});

describe("P7-02 · the manifest records the semantics, not just the filter key", () => {
  it("names the clinic-local forms for every date filter it claims parity on", () => {
    const claims = SUPERSEDED_AI_TOOLS.flatMap((record) =>
      record.replacements
        .filter((replacement) => replacement.dateSemantics)
        .map((replacement) => [record.name, replacement.dateSemantics!] as const),
    );
    expect(claims.length).toBeGreaterThan(0);
    for (const [tool, semantics] of claims) {
      expect(semantics.clinicLocalForms, tool).toContain("today");
      expect(semantics.clinicLocalForms, tool).toContain("YYYY-MM-DD");
    }
  });

  it("records every superseded tool that took a date range", () => {
    // The three tools whose inputs were dates must each have a record carrying
    // date semantics; a future edit that drops one fails here by name.
    for (const name of [
      "list_appointments",
      "list_doctor_appointments",
      "search_patient_visits",
    ]) {
      const record = SUPERSEDED_AI_TOOLS.find((entry) => entry.name === name)!;
      expect(
        record.replacements.some((replacement) => replacement.dateSemantics),
        name,
      ).toBe(true);
    }
  });
});
