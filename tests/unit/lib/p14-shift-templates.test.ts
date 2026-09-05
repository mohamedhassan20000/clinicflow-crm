import { describe, expect, it } from "vitest";
import {
  intervalsForSelection,
  intervalsMatchTemplates,
  matchTemplateSelection,
  mergeIntervals,
  templateInterval,
  MAX_ENABLED_SHIFT_TEMPLATES,
} from "@/lib/scheduling/clock";
import {
  clinicDayScheduleSchema,
  doctorScheduleSchema,
  staffShiftTemplatesSchema,
} from "@/lib/validations/settings";

const MORNING = { name: "Morning shift", start_time: "09:00", end_time: "17:00" };
const EVENING = { name: "Evening shift", start_time: "15:00", end_time: "22:00" };

function template(
  overrides: Partial<{
    name: string;
    start_time: string;
    end_time: string;
    is_enabled: boolean;
    sort_order: number;
  }>,
) {
  return {
    name: "Shift",
    start_time: "09:00",
    end_time: "17:00",
    is_enabled: true,
    sort_order: 0,
    ...overrides,
  };
}

describe("P14 · clinic working hours stay non-overlapping", () => {
  it("accepts a single continuous opening interval", () => {
    expect(
      clinicDayScheduleSchema.safeParse({
        day_of_week: 1,
        open: true,
        shifts: [{ shift_start: "09:00", shift_end: "22:00" }],
      }).success,
    ).toBe(true);
  });

  it("accepts genuine split opening hours", () => {
    expect(
      clinicDayScheduleSchema.safeParse({
        day_of_week: 1,
        open: true,
        shifts: [
          { shift_start: "09:00", shift_end: "13:00" },
          { shift_start: "16:00", shift_end: "22:00" },
        ],
      }).success,
    ).toBe(true);
  });

  it("still rejects overlapping clinic opening intervals", () => {
    expect(
      clinicDayScheduleSchema.safeParse({
        day_of_week: 1,
        open: true,
        shifts: [
          { shift_start: "09:00", shift_end: "17:00" },
          { shift_start: "15:00", shift_end: "22:00" },
        ],
      }).success,
    ).toBe(false);
  });

  it("supports closed days", () => {
    expect(
      clinicDayScheduleSchema.safeParse({ day_of_week: 5, open: false, shifts: [] }).success,
    ).toBe(true);
  });
});

describe("P14 · staff shift templates allow overlap", () => {
  it("accepts Morning 09:00–17:00 alongside Evening 15:00–22:00", () => {
    const parsed = staffShiftTemplatesSchema.safeParse([
      template({ ...MORNING, sort_order: 0 }),
      template({ ...EVENING, sort_order: 1 }),
    ]);
    expect(parsed.success).toBe(true);
  });

  it("still requires start before end", () => {
    expect(
      staffShiftTemplatesSchema.safeParse([
        template({ name: "Backwards", start_time: "18:00", end_time: "09:00" }),
      ]).success,
    ).toBe(false);
  });

  it("caps the number of enabled templates", () => {
    const many = Array.from({ length: MAX_ENABLED_SHIFT_TEMPLATES + 1 }, (_, index) =>
      template({ name: `Shift ${index}`, sort_order: index }),
    );
    expect(staffShiftTemplatesSchema.safeParse(many).success).toBe(false);
    // The same set is fine once the extra one is disabled.
    many[many.length - 1]!.is_enabled = false;
    expect(staffShiftTemplatesSchema.safeParse(many).success).toBe(true);
  });

  it("rejects duplicate template names", () => {
    expect(
      staffShiftTemplatesSchema.safeParse([
        template({ name: "Morning shift" }),
        template({ name: "morning shift", sort_order: 1 }),
      ]).success,
    ).toBe(false);
  });

  it("resolves a template to a concrete interval", () => {
    expect(templateInterval(MORNING)).toEqual({ start: "09:00", end: "17:00" });
    expect(templateInterval({ start_time: "17:00", end_time: "09:00" })).toBeNull();
  });
});

describe("P14 · staff day intervals union and gaps", () => {
  it("merges overlapping template picks into one window", () => {
    expect(
      mergeIntervals([
        { start: "09:00", end: "17:00" },
        { start: "15:00", end: "22:00" },
      ]),
    ).toEqual([{ start: "09:00", end: "22:00" }]);
  });

  it("preserves a real gap between shifts", () => {
    expect(
      mergeIntervals([
        { start: "09:00", end: "13:00" },
        { start: "16:00", end: "22:00" },
      ]),
    ).toEqual([
      { start: "09:00", end: "13:00" },
      { start: "16:00", end: "22:00" },
    ]);
  });

  it("recovers the selected templates from saved concrete hours", () => {
    expect(
      intervalsMatchTemplates([{ start: "09:00", end: "22:00" }], [MORNING, EVENING]),
    ).toBe(true);
    expect(intervalsMatchTemplates([{ start: "09:00", end: "17:00" }], [MORNING])).toBe(true);
    expect(intervalsMatchTemplates([{ start: "10:00", end: "18:00" }], [MORNING])).toBe(false);
  });
});

describe("P14 · staff schedule payload", () => {
  function parseDay(day: unknown) {
    const parsed = doctorScheduleSchema.safeParse([day]);
    return parsed.success ? parsed.data[0]! : null;
  }

  it("keeps accepting the legacy single-interval payload", () => {
    expect(
      parseDay({ day_of_week: 1, works: true, start_time: "09:00", end_time: "17:00" }),
    ).toMatchObject({
      works: true,
      start_time: "09:00",
      end_time: "17:00",
      intervals: [{ start_time: "09:00", end_time: "17:00" }],
    });
  });

  it("choosing Morning produces 09:00–17:00", () => {
    expect(
      parseDay({
        day_of_week: 1,
        works: true,
        intervals: [{ start_time: MORNING.start_time, end_time: MORNING.end_time }],
      })?.intervals,
    ).toEqual([{ start_time: "09:00", end_time: "17:00" }]);
  });

  it("choosing Evening produces 15:00–22:00", () => {
    expect(
      parseDay({
        day_of_week: 2,
        works: true,
        intervals: [{ start_time: EVENING.start_time, end_time: EVENING.end_time }],
      })?.intervals,
    ).toEqual([{ start_time: "15:00", end_time: "22:00" }]);
  });

  it("choosing Morning + Evening stores their union once", () => {
    expect(
      parseDay({
        day_of_week: 3,
        works: true,
        intervals: [
          { start_time: "09:00", end_time: "17:00" },
          { start_time: "15:00", end_time: "22:00" },
        ],
      })?.intervals,
    ).toEqual([{ start_time: "09:00", end_time: "22:00" }]);
  });

  it("keeps a gap between non-overlapping templates", () => {
    expect(
      parseDay({
        day_of_week: 4,
        works: true,
        intervals: [
          { start_time: "09:00", end_time: "13:00" },
          { start_time: "16:00", end_time: "22:00" },
        ],
      })?.intervals,
    ).toEqual([
      { start_time: "09:00", end_time: "13:00" },
      { start_time: "16:00", end_time: "22:00" },
    ]);
  });

  it("custom hours still work", () => {
    expect(
      parseDay({
        day_of_week: 4,
        works: true,
        intervals: [{ start_time: "10:00", end_time: "18:00" }],
      })?.intervals,
    ).toEqual([{ start_time: "10:00", end_time: "18:00" }]);
  });

  it("closed / off days still work", () => {
    expect(parseDay({ day_of_week: 5, works: false, start_time: null, end_time: null })).toMatchObject({
      works: false,
      intervals: [],
      start_time: null,
      end_time: null,
    });
  });

  it("rejects a working day with no interval at all", () => {
    expect(doctorScheduleSchema.safeParse([{ day_of_week: 1, works: true }]).success).toBe(false);
  });
});

describe("P14 · staff assignment resolves templates to concrete hours", () => {
  const enabled = [MORNING, EVENING];

  it("Monday → Morning stores 09:00–17:00", () => {
    expect(intervalsForSelection(new Set([0]), enabled)).toEqual([
      { start_time: "09:00", end_time: "17:00" },
    ]);
  });

  it("Tuesday → Evening stores 15:00–22:00", () => {
    expect(intervalsForSelection(new Set([1]), enabled)).toEqual([
      { start_time: "15:00", end_time: "22:00" },
    ]);
  });

  it("Wednesday → Morning + Evening stores their union once", () => {
    expect(intervalsForSelection(new Set([0, 1]), enabled)).toEqual([
      { start_time: "09:00", end_time: "22:00" },
    ]);
  });

  it("non-overlapping picks keep both intervals and the gap", () => {
    const split = [
      { name: "Early", start_time: "09:00", end_time: "13:00" },
      { name: "Late", start_time: "16:00", end_time: "22:00" },
    ];
    expect(intervalsForSelection(new Set([0, 1]), split)).toEqual([
      { start_time: "09:00", end_time: "13:00" },
      { start_time: "16:00", end_time: "22:00" },
    ]);
  });

  it("recovers the template selection from saved hours", () => {
    expect(matchTemplateSelection([{ start_time: "09:00", end_time: "17:00" }], enabled)).toEqual(
      new Set([0]),
    );
    expect(matchTemplateSelection([{ start_time: "15:00", end_time: "22:00" }], enabled)).toEqual(
      new Set([1]),
    );
    expect(matchTemplateSelection([{ start_time: "09:00", end_time: "22:00" }], enabled)).toEqual(
      new Set([0, 1]),
    );
  });

  it("treats hours that match no template as custom", () => {
    expect(matchTemplateSelection([{ start_time: "10:00", end_time: "18:00" }], enabled)).toBeNull();
    expect(matchTemplateSelection([], enabled)).toBeNull();
  });

  it("editing a template later does not move a saved schedule (model B)", () => {
    // A schedule saved from Morning 09:00–17:00 keeps those concrete hours even
    // after the template is re-timed; it simply reads back as custom hours.
    const saved = intervalsForSelection(new Set([0]), enabled);
    const retimed = [{ name: "Morning shift", start_time: "10:00", end_time: "18:00" }];
    expect(saved).toEqual([{ start_time: "09:00", end_time: "17:00" }]);
    expect(matchTemplateSelection(saved, retimed)).toBeNull();
  });
});
