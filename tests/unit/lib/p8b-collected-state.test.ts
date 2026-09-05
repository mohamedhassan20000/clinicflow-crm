import { describe, expect, it } from "vitest";
import {
  clarificationGuidance,
  describeCollectedData,
  parseCollectedData,
  parsePendingClarification,
  resolveField,
  type CollectedData,
  type FieldResolution,
  type PendingClarification,
} from "@/lib/ai/collected-state";

/**
 * P8B §1 — the conversation that used to loop.
 *
 * The reported failure was not "the date parser is wrong". The parser was right
 * every time; the *conversation* had no memory, so an answer assembled over
 * three messages was thrown away twice and asked for a fourth time. These tests
 * are written as conversations for that reason — a case that passes each message
 * in isolation and still loops is exactly the bug.
 */

const NOW = new Date("2026-08-18T09:00:00Z");

/**
 * One turn of the exchange, threading state forward the way the tools do.
 * Nothing here is clever: it is the same three lines the tool wrapper runs.
 */
function turn(
  field: Parameters<typeof resolveField>[0]["field"],
  raw: string,
  state: { collected: CollectedData; pending: PendingClarification | null },
  country = "EG",
): { resolution: FieldResolution; collected: CollectedData; pending: PendingClarification | null } {
  const resolution = resolveField({
    field,
    raw,
    collected: state.collected,
    pending: state.pending,
    country,
    now: NOW,
    timeZone: "Africa/Cairo",
  });
  const collected = { ...state.collected };
  let pending = state.pending;
  if (resolution.status === "resolved") {
    collected[field] = resolution.value;
    pending = null;
  } else if (resolution.status === "ambiguous" || resolution.status === "incomplete") {
    pending = resolution.pending;
  }
  return { resolution, collected, pending };
}

type TurnState = ReturnType<typeof turn>;

const empty = { collected: {} as CollectedData, pending: null as PendingClarification | null };

/** A conversation that has not started yet, in the shape a turn returns. */
const fresh = (): TurnState => ({
  resolution: { status: "unresolved", field: "full_name", reason: "empty" },
  collected: {},
  pending: null,
});

describe("P8B §1 — fragmented date of birth", () => {
  it("resolves 12/9/2000 → سبتمبر → نعم 2000 without ever asking twice", () => {
    // Message 1: genuinely ambiguous under a day-first convention.
    const first = turn("date_of_birth", "12/9/2000", empty);
    expect(first.resolution.status).toBe("ambiguous");
    expect(first.resolution.status === "ambiguous" && first.resolution.candidates).toEqual([
      "2000-09-12",
      "2000-12-09",
    ]);

    // Message 2: the patient names the month. This is the turn that used to be
    // dropped on the floor — "سبتمبر" is not a date, so the old stateless tool
    // could only fail and re-ask.
    const second = turn("date_of_birth", "سبتمبر", first);
    expect(second.resolution.status).toBe("resolved");
    expect(second.resolution.status === "resolved" && second.resolution.value).toBe("2000-09-12");
    expect(second.pending).toBeNull();

    // Message 3: a confirmation carrying nothing new. The assistant must answer
    // from memory, not ask a third time.
    const third = turn("date_of_birth", "نعم 2000", second);
    expect(third.resolution.status).toBe("resolved");
    expect(third.resolution.status === "resolved" && third.resolution.value).toBe("2000-09-12");
    expect(third.resolution.status === "resolved" && third.resolution.fromMemory).toBe(true);
    expect(clarificationGuidance(third.resolution)).toBeNull();
  });

  it("accepts the English half of the same exchange", () => {
    const first = turn("date_of_birth", "12/9/2000", empty);
    const second = turn("date_of_birth", "September", first);
    expect(second.resolution.status === "resolved" && second.resolution.value).toBe("2000-09-12");
    const third = turn("date_of_birth", "yes, 2000", second);
    expect(third.resolution.status === "resolved" && third.resolution.fromMemory).toBe(true);
  });

  it("takes the other reading when the patient names December instead", () => {
    const first = turn("date_of_birth", "12/9/2000", empty);
    const second = turn("date_of_birth", "ديسمبر", first);
    expect(second.resolution.status === "resolved" && second.resolution.value).toBe("2000-12-09");
  });

  it("reads Arabic-Indic digits and Arabic month names as one answer", () => {
    const only = turn("date_of_birth", "١٢ سبتمبر ٢٠٠٠", empty);
    expect(only.resolution.status).toBe("resolved");
    expect(only.resolution.status === "resolved" && only.resolution.value).toBe("2000-09-12");
  });

  it.each([
    ["12/9/2000", "2000-09-12"],
    ["12-9-2000", "2000-09-12"],
    ["12.9.2000", "2000-09-12"],
    ["12 9 2000", "2000-09-12"],
    ["١٢/٩/٢٠٠٠", "2000-09-12"],
  ])("reads %s the same way once the month is settled", (written, expected) => {
    const first = turn("date_of_birth", written, empty);
    // Every separator produces the same ambiguity and the same resolution — the
    // punctuation was never the question.
    expect(first.resolution.status).toBe("ambiguous");
    const second = turn("date_of_birth", "سبتمبر", first);
    expect(second.resolution.status === "resolved" && second.resolution.value).toBe(expected);
  });

  it("never asks about a date that has only one reading", () => {
    for (const unambiguous of ["25/12/1990", "1990-12-25", "25 ديسمبر 1990", "Dec 25 1990"]) {
      const only = turn("date_of_birth", unambiguous, empty);
      expect(only.resolution.status).toBe("resolved");
      expect(only.resolution.status === "resolved" && only.resolution.value).toBe("1990-12-25");
    }
  });

  it("asks exactly once, then stops asking", () => {
    const first = turn("date_of_birth", "3/4/1995", empty);
    expect(first.resolution.status).toBe("ambiguous");
    // The clinic's own convention is named first, so a patient who simply says
    // "yes" gets the reading the clinic would have assumed anyway.
    expect(clarificationGuidance(first.resolution)).toContain("April or March");

    const second = turn("date_of_birth", "أبريل", first);
    expect(second.resolution.status === "resolved" && second.resolution.value).toBe("1995-04-03");

    // Anything further, however phrased, is answered from state.
    for (const echo of ["اه", "تمام", "1995", "أبريل"]) {
      const later = turn("date_of_birth", echo, second);
      expect(later.resolution.status).toBe("resolved");
      expect(later.resolution.status === "resolved" && later.resolution.value).toBe("1995-04-03");
    }
  });

  it("completes a date given without a year", () => {
    const first = turn("date_of_birth", "12/9", empty);
    expect(first.resolution.status).toBe("incomplete");
    expect(first.resolution.status === "incomplete" && first.resolution.missing).toBe("year");
    expect(clarificationGuidance(first.resolution)).toContain("only for the year");

    const second = turn("date_of_birth", "1998", first);
    expect(second.resolution.status === "resolved" && second.resolution.value).toBe("1998-09-12");
  });

  it("treats a plain 'no' as choosing the reading that was not offered first", () => {
    const first = turn("date_of_birth", "12/9/2000", empty);
    const second = turn("date_of_birth", "لأ", first);
    expect(second.resolution.status === "resolved" && second.resolution.value).toBe("2000-12-09");
  });
});

describe("P8B §1 — contradictions are asked about, never merged", () => {
  it("flags a year that disagrees with the established date", () => {
    const state = { collected: { date_of_birth: "2000-09-12" } as CollectedData, pending: null };
    const next = turn("date_of_birth", "لا, 1999", state);
    expect(next.resolution.status).toBe("conflict");
    expect(next.resolution.status === "conflict" && next.resolution.established).toBe("2000-09-12");
    expect(next.resolution.status === "conflict" && next.resolution.offered).toBe(1999);
    // Nothing is written on a conflict: the established value survives until the
    // patient says which is right.
    expect(next.collected.date_of_birth).toBe("2000-09-12");
    expect(clarificationGuidance(next.resolution)).toContain("contradicts");
  });

  it("flags a month that disagrees with the established date", () => {
    const state = { collected: { date_of_birth: "2000-09-12" } as CollectedData, pending: null };
    const next = turn("date_of_birth", "مارس", state);
    expect(next.resolution.status).toBe("conflict");
  });

  it("accepts a complete rewrite as a correction rather than a conflict", () => {
    const state = { collected: { date_of_birth: "2000-09-12" } as CollectedData, pending: null };
    const next = turn("date_of_birth", "25 December 1990", state);
    expect(next.resolution.status).toBe("resolved");
    expect(next.resolution.status === "resolved" && next.resolution.value).toBe("1990-12-25");
  });

  it("refuses a fragment that answers a different question entirely", () => {
    const first = turn("date_of_birth", "12/9/2000", empty);
    const second = turn("date_of_birth", "the blue one", first);
    expect(second.resolution.status).toBe("unresolved");
    expect(second.resolution.status === "unresolved" && second.resolution.reason).toBe(
      "clarification_unmatched",
    );
    // The question stays outstanding rather than being silently resolved.
    expect(second.pending).not.toBeNull();
  });
});

describe("P8B §1 — the same machinery for every other field", () => {
  it("collects a fragmented registration without re-asking", () => {
    let state: TurnState = fresh();
    state = turn("full_name", "أحمد علي حسن", state);
    expect(state.resolution.status === "resolved" && state.resolution.value).toBe("أحمد علي حسن");
    state = turn("national_id", "٢٩٠٠٩١٢٠١٢٣٤٥", state);
    expect(state.resolution.status === "resolved" && state.resolution.value).toBe("29009120123456".slice(0, 13));
    state = turn("email", " Ahmed.Ali@Example.COM ", state);
    expect(state.resolution.status === "resolved" && state.resolution.value).toBe("ahmed.ali@example.com");
    state = turn("date_of_birth", "12/9/2000", state);
    state = turn("date_of_birth", "سبتمبر", state);

    expect(state.collected).toMatchObject({
      full_name: "أحمد علي حسن",
      email: "ahmed.ali@example.com",
      date_of_birth: "2000-09-12",
    });

    // The whole point: a later turn that names nothing new returns everything.
    const summary = describeCollectedData(state.collected);
    expect(summary).toContain("do not ask for any of it again");
    expect(summary).toContain("2000-09-12");
    expect(summary).toContain("not proof of who the patient is");
  });

  it("keeps a name it already has when a later message is unreadable as a name", () => {
    const state = { collected: { full_name: "أحمد علي" } as CollectedData, pending: null };
    const next = turn("full_name", "???", state);
    expect(next.resolution.status).toBe("resolved");
    expect(next.resolution.status === "resolved" && next.resolution.fromMemory).toBe(true);
  });

  it("normalizes a local phone number against the clinic's country", () => {
    const next = turn("phone", "٠١٠٠ ١٢٣ ٤٥٦٧", empty, "EG");
    expect(next.resolution.status).toBe("resolved");
    expect(next.resolution.status === "resolved" && next.resolution.value).toBe("+201001234567");
  });

  it("reads a gender in either language", () => {
    expect(turn("gender", "ذكر", empty).resolution).toMatchObject({ value: "male" });
    expect(turn("gender", "female please", empty).resolution).toMatchObject({ value: "female" });
    expect(turn("gender", "purple", empty).resolution.status).toBe("unresolved");
  });
});

describe("P8B §1 — fragmented appointment preferences", () => {
  it("assembles 'بكرا' plus 'الساعة ٥ العصر' into a day and a time", () => {
    let state: TurnState = fresh();
    state = turn("appointment_date", "بكرا", state);
    expect(state.resolution.status).toBe("resolved");
    // 2026-08-18 in Africa/Cairo, plus one day.
    expect(state.resolution.status === "resolved" && state.resolution.value).toBe("2026-08-19");

    state = turn("appointment_time", "الساعة ٥ العصر", state);
    expect(state.resolution.status === "resolved" && state.resolution.value).toBe(17 * 60);
  });

  it("asks once about a bare hour and accepts the answer", () => {
    let state: TurnState = fresh();
    state = turn("appointment_time", "at 5", state);
    expect(state.resolution.status).toBe("incomplete");
    expect(state.resolution.status === "incomplete" && state.resolution.missing).toBe("meridiem");

    state = turn("appointment_time", "مساءً", state);
    expect(state.resolution.status === "resolved" && state.resolution.value).toBe(17 * 60);
  });

  it("does not ask about a time that states its own half of the day", () => {
    expect(turn("appointment_time", "17:30", empty).resolution).toMatchObject({
      status: "resolved",
      value: 17 * 60 + 30,
    });
    expect(turn("appointment_time", "5pm", empty).resolution).toMatchObject({
      status: "resolved",
      value: 17 * 60,
    });
  });
});

describe("P8B §1 — state read off the wire is rebuilt, not trusted", () => {
  it("drops unknown keys, wrong types and malformed dates", () => {
    expect(
      parseCollectedData({
        date_of_birth: "2000-09-12",
        appointment_date: "not-a-date",
        appointment_time: 1020,
        full_name: 42,
        patient_id: "11111111-1111-4111-8111-111111111111",
        is_admin: true,
      }),
    ).toEqual({ date_of_birth: "2000-09-12", appointment_time: 1020 });
  });

  it("refuses a time outside a day and a value that is not an object", () => {
    expect(parseCollectedData({ appointment_time: 5000 })).toEqual({});
    expect(parseCollectedData(["date_of_birth"])).toEqual({});
    expect(parseCollectedData(null)).toEqual({});
  });

  it("rebuilds a pending clarification and refuses a malformed one", () => {
    const pending = parsePendingClarification({
      field: "date_of_birth",
      kind: "which_reading",
      candidates: ["2000-09-12", "2000-12-09"],
      askedAt: "2026-08-18T09:00:00.000Z",
    });
    expect(pending?.candidates).toHaveLength(2);
    expect(parsePendingClarification({ field: "sudo", kind: "which_reading" })).toBeNull();
    expect(parsePendingClarification({ field: "date_of_birth", kind: "elevate" })).toBeNull();
  });

  it("ignores a pending clarification belonging to a different field", () => {
    const pending: PendingClarification = {
      field: "appointment_date",
      kind: "which_reading",
      candidates: ["2026-09-12", "2026-12-09"],
      askedAt: NOW.toISOString(),
    };
    // "سبتمبر" answers the appointment question, not a date-of-birth one, so a
    // date-of-birth resolution must not consume it.
    const resolution = resolveField({
      field: "date_of_birth",
      raw: "سبتمبر",
      collected: {},
      pending,
      country: "EG",
      now: NOW,
    });
    expect(resolution.status).toBe("unresolved");
  });
});

describe("P8B §1 — identity protections are not relaxed by any of this", () => {
  it("carries no patient identifier of any kind", () => {
    // Collected state is conversational memory. If a patient id could live in
    // it, a prompt-injected value would become an authorization input.
    const parsed = parseCollectedData({
      patient_id: "11111111-1111-4111-8111-111111111111",
      identity_verified: true,
      clinic_id: "22222222-2222-4222-8222-222222222222",
      date_of_birth: "2000-09-12",
    });
    expect(parsed).toEqual({ date_of_birth: "2000-09-12" });
    expect(Object.keys(parsed)).not.toContain("patient_id");
    expect(Object.keys(parsed)).not.toContain("identity_verified");
  });

  it("resolves a date without asserting anything about whose date it is", () => {
    const resolution = resolveField({
      field: "date_of_birth",
      raw: "12 September 2000",
      collected: {},
      pending: null,
      country: "EG",
      now: NOW,
    });
    expect(resolution).toEqual({
      status: "resolved",
      field: "date_of_birth",
      value: "2000-09-12",
      fromMemory: false,
    });
    // No verification flag, no patient, no lookup — the resolution is a value.
    expect(Object.keys(resolution).sort()).toEqual(["field", "fromMemory", "status", "value"]);
  });

  it("keeps a genuinely undecidable date undecided rather than choosing", () => {
    const first = resolveField({
      field: "date_of_birth",
      raw: "12/9/2000",
      collected: {},
      pending: null,
      country: "EG",
      now: NOW,
    });
    expect(first.status).toBe("ambiguous");
    // Re-sending the identical ambiguous date does not wear the check down into
    // picking one.
    const second = resolveField({
      field: "date_of_birth",
      raw: "12/9/2000",
      collected: {},
      pending: first.status === "ambiguous" ? first.pending : null,
      country: "EG",
      now: NOW,
    });
    expect(second.status).toBe("ambiguous");
  });

  it("does not let an affirmation invent a value that was never given", () => {
    const resolution = resolveField({
      field: "date_of_birth",
      raw: "نعم",
      collected: {},
      pending: null,
      country: "EG",
      now: NOW,
    });
    expect(resolution.status).toBe("unresolved");
  });

  it("refuses a future date of birth in both readings", () => {
    const resolution = resolveField({
      field: "date_of_birth",
      raw: "2030-01-01",
      collected: {},
      pending: null,
      country: "EG",
      now: NOW,
    });
    expect(resolution.status).toBe("unresolved");
    expect(resolution.status === "unresolved" && resolution.reason).toBe("out_of_range");
  });

  it("resolves a US clinic's 9/12 the American way and still reports the alternative", () => {
    const resolution = resolveField({
      field: "date_of_birth",
      raw: "9/12/2000",
      collected: {},
      pending: null,
      country: "US",
      now: NOW,
    });
    expect(resolution.status).toBe("ambiguous");
    expect(resolution.status === "ambiguous" && resolution.candidates[0]).toBe("2000-09-12");
  });
});
