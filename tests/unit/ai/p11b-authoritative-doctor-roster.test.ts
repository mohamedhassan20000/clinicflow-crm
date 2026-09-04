import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11B — the reproduced phantom-doctor defect, and the invariant that replaces
 * the guarantee it broke.
 *
 * ## What was actually sent
 *
 * On 2026-08-23 at 22:46 UTC, against the hosted database, a patient asked
 * "عايز اعرف مين الدكاترة المتاحين الاول" and was sent:
 *
 *     تمام! 👍
 *     **الدكاترة المتاحين في قسم العلاج الطبيعي:**
 *     1. **Dr. Mehmet Yilmaz**
 *     2. **Dr. Ayşe Demir**
 *
 * Neither person exists in that clinic, in any clinic, or anywhere in this
 * repository. The stage trace for the same turn records `tool_called: "none"`,
 * so no roster was ever loaded: the model was answering a roster question with
 * no roster tool mounted, and the grounding check passed the result.
 *
 * ## What this file holds to
 *
 * `Mehmet Yilmaz` and `Ayşe Demir` appear here as **regression inputs** — text
 * pushed *into* the presentation layer to prove it rejects them. They are not
 * an exclusion list, and nothing in `lib/` mentions them; the `no production
 * code names these people` test below asserts that directly, so a fix that
 * worked by naming them would fail rather than pass.
 *
 * Every department in this file is generated, and no test asserts a name it
 * planted in a fixture and then read back out of the same fixture. The roster
 * assertions run through the filter-faithful Supabase mock — `.eq`/`.is`/`.lte`/
 * `.gt` are applied to rows — so removing a `department_id`, `role`,
 * `is_active` or `deleted_at` predicate from a production query makes a test
 * fail instead of returning a longer list.
 */

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-25T09:00:00.000Z");

/** The reproduction's department, as data. Nothing reads its name as a rule. */
const PT = "d0000000-0000-4000-8000-0000000000a1";
const OTHER = "d0000000-0000-4000-8000-0000000000a2";

const HANEEN = "aaaaaaaa-1111-4000-8000-000000000001";
const YOUSSEF = "aaaaaaaa-1111-4000-8000-000000000002";
const MARIAM = "aaaaaaaa-1111-4000-8000-000000000003";
const RETIRED = "aaaaaaaa-1111-4000-8000-000000000004";
const DELETED = "aaaaaaaa-1111-4000-8000-000000000005";
const ON_LEAVE = "aaaaaaaa-1111-4000-8000-000000000006";
const ELSEWHERE = "aaaaaaaa-1111-4000-8000-000000000007";

/** The two names the patient was actually shown. Inputs, never expectations. */
const PHANTOMS = ["Mehmet Yilmaz", "Ayşe Demir"] as const;
/** A name that exists nowhere at all — not staff, not the repo, not the repro. */
const INVENTED = "Zephyrine Quillbottom";

function staffRow(
  id: string,
  full_name: string,
  department_id: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    full_name,
    department_id,
    role: "doctor",
    is_active: true,
    is_deleted: false,
    deleted_at: null,
    ...overrides,
  };
}

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  persist: vi.fn(),
  context: vi.fn(),
  audit: vi.fn(),
  tables: {} as Record<string, Array<Record<string, unknown>>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: mocks.audit }));
vi.mock("@/lib/ai/patient-authorization", async (original) => {
  const actual = await original<typeof import("@/lib/ai/patient-authorization")>();
  return { ...actual, authorizePatientConversation: mocks.authorize };
});
vi.mock("@/lib/supabase/admin", () => ({
  setConversationAiState: mocks.persist,
  resolvePatientAiContext: mocks.context,
  createClinicScopedAdminClient: () => ({
    from(table: string) {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const builder = {
        select: () => builder,
        order: () => builder,
        // The cap is honoured rather than ignored: `loadDoctorDirectory` bounds
        // both reads, and a mock that returned everything would let a test
        // "prove" a cap that production does not actually apply.
        limit: async (count: number) => ({ data: rows().slice(0, count), error: null }),
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        is(column: string, value: unknown) {
          filters.push((row) => (row[column] ?? null) === value);
          return builder;
        },
        lte(column: string, value: string) {
          filters.push((row) => String(row[column]) <= value);
          return builder;
        },
        gt(column: string, value: string) {
          filters.push((row) => String(row[column]) > value);
          return builder;
        },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      };
      function rows() {
        return (mocks.tables[table] ?? []).filter((row) =>
          filters.every((predicate) => predicate(row)),
        );
      }
      return builder;
    },
  }),
}));

import {
  availableDoctorsInDepartment,
  departmentDoctorsPayload,
  loadDoctorDirectory,
} from "@/lib/ai/doctor-directory";
import { listDoctorsTool } from "@/lib/ai/tools/list-doctors";
import {
  checkDoctorGrounding,
  createGroundingLedger,
} from "@/lib/ai/patient-grounding";
import { enforcePatientReplyGrounding } from "@/lib/ai/patient-reply-grounding";
import { isRosterBearingTurn, isRosterQuestion } from "@/lib/ai/roster-intent";
import { EMPTY_BOOKING_STAGE_STATE } from "@/lib/ai/booking-stage";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.audit.mockResolvedValue(undefined);
  mocks.persist.mockResolvedValue({ data: null, error: null });
  mocks.context.mockResolvedValue({
    data: [{ collected_data: { department_id: PT, department_name: "العلاج الطبيعي" } }],
    error: null,
  });
  mocks.authorize.mockResolvedValue({
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: null,
    linked: false,
    identityVerifiedAt: null,
    collectedData: { department_id: PT },
    bookingStage: EMPTY_BOOKING_STAGE_STATE,
    communicationStyle: null,
  });
  mocks.tables = {
    departments: [
      { id: PT, name: "العلاج الطبيعي", is_active: true, deleted_at: null },
      { id: OTHER, name: "الجلدية", is_active: true, deleted_at: null },
    ],
    profiles: [
      staffRow(HANEEN, "Haneen Samir", PT),
      staffRow(YOUSSEF, "Youssef Adel", PT),
      // A receptionist of the same department. Same row shape, different role.
      staffRow(MARIAM, "Mariam Tarek", PT, { role: "receptionist" }),
      staffRow(RETIRED, "Retired Doctor", PT, { is_active: false }),
      staffRow(DELETED, "Deleted Doctor", PT, {
        is_deleted: true,
        deleted_at: "2026-01-01T00:00:00.000Z",
      }),
      staffRow(ON_LEAVE, "Away Doctor", PT),
      staffRow(ELSEWHERE, "Other Department Doctor", OTHER),
    ],
    doctor_unavailability: [
      {
        doctor_id: ON_LEAVE,
        is_active: true,
        starts_at: "2026-08-24T00:00:00.000Z",
        // Keep this in force for both the fixture clock and the real clock used
        // by tool-level calls. A date one day after the fixture clock made this
        // invariant start failing as soon as the calendar reached 2026-08-27.
        ends_at: "2036-08-26T00:00:00.000Z",
      },
    ],
  };
});

const directory = () => loadDoctorDirectory(CLINIC, { now: NOW });

// ---------------------------------------------------------------------------
// 1. The roster boundary, proved through the query filters
// ---------------------------------------------------------------------------

describe("P11B · the authoritative roster is exactly the eligible staff rows", () => {
  /**
   * The expectation is *computed from the fixture's own predicates*, not typed
   * out beside it. Adding a row to the table above changes both sides at once,
   * so this can never become a restatement of a hand-written list — while
   * dropping a filter from `loadDoctorDirectory` or
   * `availableDoctorsInDepartment` changes only one side, and fails.
   */
  function eligibleByDefinition(departmentId: string): string[] {
    const away = new Set(
      (mocks.tables.doctor_unavailability ?? [])
        .filter(
          (row) =>
            row.is_active === true &&
            String(row.starts_at) <= NOW.toISOString() &&
            String(row.ends_at) > NOW.toISOString(),
        )
        .map((row) => row.doctor_id),
    );
    return (mocks.tables.profiles ?? [])
      .filter(
        (row) =>
          row.role === "doctor" &&
          row.department_id === departmentId &&
          row.is_active === true &&
          row.is_deleted === false &&
          row.deleted_at === null &&
          !away.has(row.id),
      )
      .map((row) => String(row.full_name))
      .sort();
  }

  it("returns every eligible doctor and only those", async () => {
    const roster = availableDoctorsInDepartment(await directory(), PT);
    expect(roster.map((item) => item.name).sort()).toEqual(eligibleByDefinition(PT));
    // And it is not vacuous: the fixture really does contain ineligible rows.
    expect(roster.length).toBeGreaterThan(0);
    expect(roster.length).toBeLessThan(mocks.tables.profiles!.length);
  });

  it("never presents a non-doctor of the department", async () => {
    const roster = availableDoctorsInDepartment(await directory(), PT);
    const nonDoctors = mocks.tables.profiles!.filter((row) => row.role !== "doctor");
    expect(nonDoctors.length).toBeGreaterThan(0);
    for (const row of nonDoctors) {
      expect(roster.map((item) => item.id)).not.toContain(row.id);
    }
  });

  it.each([
    ["deactivated", RETIRED],
    ["soft-deleted", DELETED],
    ["on leave right now", ON_LEAVE],
    ["assigned to another department", ELSEWHERE],
    ["a receptionist", MARIAM],
  ])("excludes a doctor who is %s", async (_label, id) => {
    const roster = availableDoctorsInDepartment(await directory(), PT);
    expect(roster.map((item) => item.id)).not.toContain(id);
  });

  it("counts leave that is in force now, and not leave that is over", async () => {
    // The same row, moved into the past, must stop excluding the doctor. The
    // policy is "away now", not "has ever been away".
    mocks.tables.doctor_unavailability = [
      {
        doctor_id: ON_LEAVE,
        is_active: true,
        starts_at: "2026-07-01T00:00:00.000Z",
        ends_at: "2026-07-05T00:00:00.000Z",
      },
    ];
    const roster = availableDoctorsInDepartment(await directory(), PT);
    expect(roster.map((item) => item.id)).toContain(ON_LEAVE);
  });

  it("removes a doctor the moment their department assignment changes", async () => {
    const before = availableDoctorsInDepartment(await directory(), PT);
    expect(before.map((item) => item.id)).toContain(HANEEN);
    mocks.tables.profiles = mocks.tables.profiles!.map((row) =>
      row.id === HANEEN ? { ...row, department_id: OTHER } : row,
    );
    const after = availableDoctorsInDepartment(await directory(), PT);
    expect(after.map((item) => item.id)).not.toContain(HANEEN);
    expect(availableDoctorsInDepartment(await directory(), OTHER).map((i) => i.id)).toContain(
      HANEEN,
    );
  });

  it("includes a doctor created after the process started, with no code change", async () => {
    const NEW_ID = "aaaaaaaa-1111-4000-8000-0000000000ff";
    mocks.tables.profiles!.push(staffRow(NEW_ID, "Brand New Doctor", PT));
    const roster = availableDoctorsInDepartment(await directory(), PT);
    expect(roster.map((item) => item.id)).toContain(NEW_ID);
  });
});

// ---------------------------------------------------------------------------
// 2. Arbitrary departments, in both languages, with zero code changes
// ---------------------------------------------------------------------------

describe("P11B · department count and naming are data, not code", () => {
  it("behaves identically for 3, 20 and 100 departments", async () => {
    for (const count of [3, 20, 100]) {
      const departments = Array.from({ length: count }, (_, index) => ({
        id: `d1111111-0000-4000-8000-${String(index).padStart(12, "0")}`,
        name: index % 2 === 0 ? `Unit ${index}` : `وحدة ${index}`,
        is_active: true,
        deleted_at: null,
      }));
      mocks.tables.departments = departments;
      mocks.tables.profiles = departments.map((department, index) =>
        staffRow(
          `a1111111-0000-4000-8000-${String(index).padStart(12, "0")}`,
          index % 2 === 0 ? `Doctor Number ${index}` : `طبيب رقم ${index}`,
          department.id,
        ),
      );
      mocks.tables.doctor_unavailability = [];
      const loaded = await directory();
      // P11I: the clinic-wide directory is complete, not capped to the first
      // fifty rows. Booking rosters remain disjoint across the whole result.
      expect(loaded.departments).toHaveLength(count);
      for (const department of loaded.departments) {
        const roster = availableDoctorsInDepartment(loaded, department.id);
        // Exactly the one doctor whose row carries this department's id, and
        // no leakage from the other 99.
        expect(roster).toHaveLength(1);
        expect(roster[0]!.departmentId).toBe(department.id);
        expect(() =>
          departmentDoctorsPayload(loaded, department, {}),
        ).not.toThrow();
      }
    }
  });

  it("gives a department created a moment ago a working roster immediately", async () => {
    const FRESH = "d1111111-9999-4000-8000-000000000001";
    const FRESH_DOC = "a1111111-9999-4000-8000-000000000001";
    mocks.tables.departments!.push({
      id: FRESH,
      name: "قسم أُنشئ للتو",
      is_active: true,
      deleted_at: null,
    });
    mocks.tables.profiles!.push(staffRow(FRESH_DOC, "طبيب القسم الجديد", FRESH));
    const loaded = await directory();
    const fresh = loaded.departments.find((item) => item.id === FRESH)!;
    const payload = departmentDoctorsPayload(loaded, fresh, {});
    expect(payload.doctors.map((item) => item.id)).toEqual([FRESH_DOC]);
    expect(payload.doctor_count).toBe(1);
  });

  it("keeps rosters disjoint: no department's doctor appears in another", async () => {
    const loaded = await directory();
    const seen = new Map<string, string>();
    for (const department of loaded.departments) {
      for (const doctor of availableDoctorsInDepartment(loaded, department.id)) {
        expect(seen.has(doctor.id)).toBe(false);
        seen.set(doctor.id, department.id);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Fuzzy matching may choose a department; it may never choose a roster
// ---------------------------------------------------------------------------

describe("P11B · resolution picks the department, never the members", () => {
  it("returns every department as one read-only grouped roster", async () => {
    const result = (await listDoctorsTool({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      locale: "en",
      informationalOnly: true,
    }).execute!({ all_departments: true } as never, {} as never)) as Record<string, unknown>;
    expect(result.scope).toBe("all_departments");
    const groups = result.departments as Array<{
      id: string;
      doctors: Array<{ id: string }>;
    }>;
    expect(groups.map((group) => group.id)).toEqual([PT, OTHER]);
    expect(groups.find((group) => group.id === PT)?.doctors.map((doctor) => doctor.id))
      .toEqual(expect.arrayContaining([HANEEN, YOUSSEF]));
    expect(groups.find((group) => group.id === OTHER)?.doctors.map((doctor) => doctor.id))
      .toEqual([ELSEWHERE]);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("returns the same roster however the department was named", async () => {
    const loaded = await directory();
    const authoritative = availableDoctorsInDepartment(loaded, PT).map((item) => item.id);
    for (const spelling of ["العلاج الطبيعي", "علاج طبيعي", "العلاج الطبيعى"]) {
      const result = (await listDoctorsTool({
        clinicId: CLINIC,
        conversationId: CONVERSATION,
        locale: "ar",
      }).execute!({ department: spelling } as never, {} as never)) as Record<string, unknown>;
      if (result.needs_clarification || result.needs_selection) continue;
      const doctors = result.doctors as Array<{ id: string }>;
      expect(doctors.map((item) => item.id)).toEqual(authoritative);
    }
  });

  it("cannot be talked into a roster by naming a doctor instead", async () => {
    const result = (await listDoctorsTool({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      locale: "ar",
    }).execute!({ department: "Mehmet Yilmaz" } as never, {} as never)) as Record<
      string,
      unknown
    >;
    // Either it refuses to resolve, or it falls back to the department this
    // conversation had already settled. It can never invent one.
    if (!result.needs_clarification && !result.needs_selection) {
      const loaded = await directory();
      expect((result.doctors as Array<{ id: string }>).map((item) => item.id)).toEqual(
        availableDoctorsInDepartment(loaded, PT).map((item) => item.id),
      );
    }
    const names = JSON.stringify(result);
    for (const phantom of PHANTOMS) expect(names).not.toContain(phantom);
  });
});

// ---------------------------------------------------------------------------
// 4. The reproduction itself, at the boundary that sends the message
// ---------------------------------------------------------------------------

/** The message the patient was actually sent, byte for byte. */
const SENT_TO_PATIENT =
  "تمام! 👍\n\n**الدكاترة المتاحين في قسم العلاج الطبيعي:**\n\n" +
  "1. **Dr. Mehmet Yilmaz**\n2. **Dr. Ayşe Demir**\n\n" +
  "**عايز يحجز مع مين منهم؟** وبعدين نشوف المواعيد المتاحة.";

/** The patient's message on that turn. */
const PATIENT_ASKED =
  "فصيلة الدم ab+ | ومش عايز الموعد يوم ٢٣ عايز اعرف مين الدكاترة المتاحين الاول";

async function directoryShape() {
  return await directory();
}

function ledgerWith(doctors: Array<{ id: string; name: string }>) {
  const ledger = createGroundingLedger();
  if (doctors.length > 0) {
    ledger.record("list_doctors", {
      department: { id: PT, name: "العلاج الطبيعي" },
      doctors,
    });
  }
  return ledger;
}

describe("P11B · the reproduced turn cannot send those names again", () => {
  it("recognises the patient's actual message as a roster question", () => {
    expect(isRosterQuestion(PATIENT_ASKED)).toBe(true);
    expect(
      isRosterBearingTurn({ patientText: PATIENT_ASKED, replyText: SENT_TO_PATIENT }),
    ).toBe(true);
  });

  it("rejects the exact message that was sent, with no roster loaded", async () => {
    const loaded = await directoryShape();
    const check = checkDoctorGrounding({
      text: SENT_TO_PATIENT,
      allowedNames: [],
      clinicDoctors: loaded.doctors.map((item) => ({ id: item.id, name: item.name })),
      rosterBearing: true,
    });
    expect(check.grounded).toBe(false);
    expect(check.violations.length).toBeGreaterThanOrEqual(2);
  });

  it("replaces it with the department's real roster, naming no phantom", async () => {
    vi.spyOn(
      await import("@/lib/ai/doctor-directory"),
      "loadDoctorDirectory",
    ).mockResolvedValue(await directoryShape());

    const result = await enforcePatientReplyGrounding({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      locale: "ar",
      text: SENT_TO_PATIENT,
      ledger: ledgerWith([]),
      latestPatientText: PATIENT_ASKED,
      // Even a model that keeps inventing cannot get a phantom through: the
      // unbacked path never asks it a second time.
      regenerate: async () => "دول: Dr. Mehmet Yilmaz و Dr. Ayşe Demir",
    });

    expect(result.outcome).toBe("deterministic");
    expect(result.rosterBearing).toBe(true);
    for (const phantom of PHANTOMS) {
      expect(result.text).not.toContain(phantom);
      expect(result.text).not.toContain(phantom.split(" ")[0]);
    }
    // And what it says instead is the authoritative roster, read live.
    const loaded = await directoryShape();
    for (const doctor of availableDoctorsInDepartment(loaded, PT)) {
      expect(result.text).toContain(doctor.name);
    }
  });

  it("also rejects them when a correct roster *was* loaded", async () => {
    vi.spyOn(
      await import("@/lib/ai/doctor-directory"),
      "loadDoctorDirectory",
    ).mockResolvedValue(await directoryShape());
    const loaded = await directoryShape();
    const roster = availableDoctorsInDepartment(loaded, PT).map((item) => ({
      id: item.id,
      name: item.name,
    }));

    const result = await enforcePatientReplyGrounding({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      locale: "ar",
      text: SENT_TO_PATIENT,
      ledger: ledgerWith(roster),
      latestPatientText: PATIENT_ASKED,
      regenerate: async () => SENT_TO_PATIENT,
    });

    expect(result.outcome).toBe("deterministic");
    for (const phantom of PHANTOMS) expect(result.text).not.toContain(phantom);
    for (const doctor of roster) expect(result.text).toContain(doctor.name);
  });

  it("rejects a name that exists nowhere in the clinic or the repository", async () => {
    vi.spyOn(
      await import("@/lib/ai/doctor-directory"),
      "loadDoctorDirectory",
    ).mockResolvedValue(await directoryShape());
    const loaded = await directoryShape();
    const roster = availableDoctorsInDepartment(loaded, PT).map((item) => ({
      id: item.id,
      name: item.name,
    }));

    for (const shape of [
      `الدكاترة المتاحين:\n1. ${roster[0]!.name}\n2. ${INVENTED}`,
      `You can also see Dr. ${INVENTED} tomorrow.`,
      `الدكتور المتاح كمان هو ${INVENTED}`,
    ]) {
      const result = await enforcePatientReplyGrounding({
        clinicId: CLINIC,
        conversationId: CONVERSATION,
        locale: "ar",
        text: shape,
        ledger: ledgerWith(roster),
        latestPatientText: "مين الدكاترة المتاحين؟",
        regenerate: async () => shape,
      });
      expect(result.text, shape).not.toContain(INVENTED);
      expect(result.outcome, shape).toBe("deterministic");
    }
  });

  it("leaves a correct roster reply exactly as the model wrote it", async () => {
    vi.spyOn(
      await import("@/lib/ai/doctor-directory"),
      "loadDoctorDirectory",
    ).mockResolvedValue(await directoryShape());
    const loaded = await directoryShape();
    const roster = availableDoctorsInDepartment(loaded, PT).map((item) => ({
      id: item.id,
      name: item.name,
    }));
    const good =
      `تمام! الدكاترة المتاحين في العلاج الطبيعي:\n` +
      roster.map((item, index) => `${index + 1}. Dr. ${item.name}`).join("\n") +
      `\nتحب تحجز مع مين؟`;

    const result = await enforcePatientReplyGrounding({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      locale: "ar",
      text: good,
      ledger: ledgerWith(roster),
      latestPatientText: "مين الدكاترة المتاحين؟",
      regenerate: async () => "should not be called",
    });
    expect(result.outcome).toBe("grounded");
    expect(result.text).toBe(good);
  });

  it("never shows a receptionist as a doctor, even when the model does", async () => {
    vi.spyOn(
      await import("@/lib/ai/doctor-directory"),
      "loadDoctorDirectory",
    ).mockResolvedValue(await directoryShape());
    const loaded = await directoryShape();
    const roster = availableDoctorsInDepartment(loaded, PT).map((item) => ({
      id: item.id,
      name: item.name,
    }));
    const receptionist = mocks.tables.profiles!.find((row) => row.id === MARIAM)!;

    const result = await enforcePatientReplyGrounding({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      locale: "ar",
      text: `الدكاترة المتاحين:\n1. ${roster[0]!.name}\n2. Dr. ${receptionist.full_name}`,
      ledger: ledgerWith(roster),
      latestPatientText: "مين الدكاترة المتاحين؟",
      regenerate: async (correction) => correction,
    });
    expect(result.text).not.toContain(String(receptionist.full_name));
  });
});

// ---------------------------------------------------------------------------
// 5. The fix is general, not a patch on these names
// ---------------------------------------------------------------------------

describe("P11B · nothing here is special-cased", () => {
  /**
   * No person in this file — invented or fixtured — is named anywhere in
   * production code, comments included.
   *
   * This is the test that stops the fix from being a patch. If the phantoms
   * were rejected by an exclusion list, or the roster were made correct by a
   * branch that recognised these staff, that list or branch would have to
   * contain one of these strings, and this would fail rather than pass. It
   * covers comments too, deliberately: an audit row, a prompt or a doc comment
   * carrying a patient-adjacent name is the same leak in a quieter place.
   */
  it("no production code names any of the people in this reproduction", async () => {
    const { execSync } = await import("node:child_process");
    const needles = [
      "Mehmet",
      "Yilmaz",
      "Ayşe",
      "Ayse",
      "Demir",
      "Haneen",
      "Youssef Adel",
      "Mariam Tarek",
      INVENTED,
    ];
    for (const needle of needles) {
      const hits = execSync(
        `grep -rlF ${JSON.stringify(needle)} lib actions app components || true`,
        { encoding: "utf8" },
      )
        .split("\n")
        .filter(Boolean);
      expect(hits, `${needle} is named in production code`).toEqual([]);
    }
  });

  /**
   * The cross-language concept lexicon in `entity-resolution.ts` is the one
   * place production code holds specialty words at all, and it predates this
   * phase. It stays, and these two properties are why it is not
   * "department-specific code":
   *
   *   * it maps **concepts**, never people — so it can never contribute a name;
   *   * it can only choose *which* department a phrase refers to. Membership is
   *     `availableDoctorsInDepartment` over live rows either way, so no lexicon
   *     entry, and no future one, can add or remove a single doctor.
   *
   * A department the lexicon has never heard of is resolved by its literal name
   * and behaves identically — proved by the generated departments above, whose
   * names ("Unit 7", "وحدة 7") appear in no lexicon anywhere.
   */
  it("holds no person's name in the concept lexicon", async () => {
    const source = (
      await import("node:fs")
    ).readFileSync("lib/ai/entity-resolution.ts", "utf8");
    // Person tokens only. The fixture also contains role-describing placeholder
    // names ("Retired Doctor"), whose ordinary English words obviously occur in
    // any source file and prove nothing either way.
    const personTokens = [
      "Haneen",
      "Samir",
      "Youssef",
      "Adel",
      "Mariam",
      "Tarek",
      "Mehmet",
      "Yilmaz",
      "Ayse",
      "Demir",
      "Quillbottom",
    ];
    for (const token of personTokens) {
      expect(source.toLowerCase(), token).not.toContain(token.toLowerCase());
    }
  });

  it("gives the same roster for a lexicon-known and a lexicon-unknown department", async () => {
    const loaded = await directoryShape();
    // The lexicon can shift which department a phrase resolves to; it is handed
    // the roster question for both, and both answer from the same function.
    const viaLexicon = availableDoctorsInDepartment(loaded, PT).map((item) => item.id);
    mocks.tables.departments = [
      { id: PT, name: "Qorvex Wing", is_active: true, deleted_at: null },
    ];
    const renamed = await directoryShape();
    const viaLiteral = availableDoctorsInDepartment(renamed, PT).map((item) => item.id);
    // Renaming the department to a word no lexicon has ever seen changes the
    // roster not at all: membership is the `department_id` column.
    expect(viaLiteral).toEqual(viaLexicon);
  });

  it("treats an unknown invented name and a real other-department doctor alike", async () => {
    const loaded = await directoryShape();
    const clinicDoctors = loaded.doctors.map((item) => ({ id: item.id, name: item.name }));
    const roster = availableDoctorsInDepartment(loaded, PT).map((item) => item.name);
    const elsewhere = loaded.doctors.find((item) => item.id === ELSEWHERE)!;

    for (const name of [INVENTED, elsewhere.name, ...PHANTOMS]) {
      const check = checkDoctorGrounding({
        text: `الدكاترة المتاحين:\n1. ${roster[0]}\n2. Dr. ${name}`,
        allowedNames: roster,
        clinicDoctors,
        rosterBearing: true,
      });
      expect(check.grounded, name).toBe(false);
    }
  });

  it("does not fire on a reply that mentions doctors without naming one", async () => {
    const loaded = await directoryShape();
    const clinicDoctors = loaded.doctors.map((item) => ({ id: item.id, name: item.name }));
    for (const benign of [
      "تحب تحجز مع دكتور في القسم ده؟",
      "معلش، مفيش دكتور متاح دلوقتي. تحب أوصلك بالعيادة؟",
      "You can book with any doctor in that department.",
      "احنا فاتحين من ٩ لـ ٥.",
    ]) {
      const check = checkDoctorGrounding({
        text: benign,
        allowedNames: [],
        clinicDoctors,
        rosterBearing: true,
      });
      expect(check.grounded, benign).toBe(true);
    }
  });
});
