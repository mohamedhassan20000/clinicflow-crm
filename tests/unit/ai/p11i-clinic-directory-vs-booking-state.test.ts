import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildClinicDirectoryReply,
  enforceClinicDirectoryReply,
  isClinicDirectoryQuestion,
} from "@/lib/ai/clinic-directory";
import {
  bookingAuthorityInstruction,
  resolveBookingAuthority,
  shouldForceAuthority,
} from "@/lib/ai/booking-authority";
import {
  allowedToolsForStage,
  BOOKING_STAGES,
  nextBookingStep,
} from "@/lib/ai/booking-stage";
import { createGroundingLedger } from "@/lib/ai/patient-grounding";
import { PATIENT_TOOL_NAMES } from "@/lib/ai/patient-tools";

const SELECTED = "selected-department";
const DOCTOR = "selected-doctor";

function authority(input: {
  clinicDirectoryQuery: boolean;
  offeredDoctorIds?: string[];
  offeredSlots?: string[];
}) {
  const collected = {
    department_id: SELECTED,
    doctor_id: DOCTOR,
    appointment_date: "2030-08-31",
  };
  return resolveBookingAuthority({
    step: nextBookingStep({
      collected,
      linked: false,
      bookingForOther: true,
      intakeStaged: false,
      submitted: false,
    }),
    collected,
    offeredDoctorIds: input.offeredDoctorIds ?? [DOCTOR],
    offeredDays: ["2030-08-31"],
    offeredSlots: input.offeredSlots ?? [],
    closing: false,
    terminal: false,
    clinicDirectoryQuery: input.clinicDirectoryQuery,
  });
}

function departments(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `department-${index}`,
    name: `Unit ${index + 1}`,
  }));
}

function directoryLedger(count: number) {
  const ledger = createGroundingLedger();
  const rows = departments(count);
  ledger.record("list_clinic_departments", {
    scope: "clinic_directory",
    complete: true,
    departments: rows,
    department_count: rows.length,
  });
  return { ledger, rows };
}

describe("P11I · clinic directory scope is separate from booking state", () => {
  it.each([
    "ايه الاقسام الموجودة؟",
    "مفيش اقسام تانية؟",
    "هل فيه أقسام أخرى؟",
    "ما هي التخصصات المتاحة؟",
    "What departments do you have?",
    "Are there other departments?",
    "Which specialties are available?",
  ])("recognises a clinic-wide directory question: %s", (message) => {
    expect(isClinicDirectoryQuestion(message)).toBe(true);
  });

  it.each([
    "عايز احجز في القسم الأول",
    "I want to book in the first department",
    "مين الدكاترة المتاحين؟",
    "Who are the available doctors?",
  ])("does not widen a booking/doctor request into a directory query: %s", (message) => {
    expect(isClinicDirectoryQuestion(message)).toBe(false);
  });

  it("overrides a time-step booking operation with the clinic-wide read", () => {
    const ordinary = authority({ clinicDirectoryQuery: false });
    expect(ordinary).toMatchObject({
      step: "time",
      operation: "check_availability",
      reason: "needs_slots",
    });

    const directory = authority({ clinicDirectoryQuery: true });
    expect(directory).toMatchObject({
      step: "time",
      requirement: "read_authority",
      operation: "list_clinic_departments",
      reason: "needs_clinic_directory",
      satisfied: false,
    });
    expect(
      shouldForceAuthority({
        authority: directory,
        mountedTools: [...PATIENT_TOOL_NAMES],
        stepNumber: 0,
      }),
    ).toBe(true);
  });

  it("overrides a committed selected-department roster on an explicit challenge", () => {
    const directory = authority({
      clinicDirectoryQuery: isClinicDirectoryQuestion("Are there other departments?"),
      offeredDoctorIds: [DOCTOR],
    });
    expect(directory.operation).toBe("list_clinic_departments");
    expect(directory.reason).not.toBe("committed_roster");
  });

  it("mounts the clinic-wide read in every booking stage without widening workflow tools", () => {
    for (const stage of BOOKING_STAGES) {
      expect(allowedToolsForStage(stage, [...PATIENT_TOOL_NAMES])).toContain(
        "list_clinic_departments",
      );
    }
  });

  it("makes the scope separation explicit in Arabic and English authority copy", () => {
    const resolved = authority({ clinicDirectoryQuery: true });
    expect(bookingAuthorityInstruction("ar", resolved)).toMatch(
      /دليل أقسام العيادة بالكامل/,
    );
    expect(bookingAuthorityInstruction("en", resolved)).toMatch(
      /clinic-wide department-directory/i,
    );
  });

  it.each([3, 20, 100])(
    "answers from every one of %i authoritative departments",
    (count) => {
      const { ledger, rows } = directoryLedger(count);
      const result = enforceClinicDirectoryReply({
        locale: "en",
        latestPatientText: "What departments do you have?",
        text: "The selected department is the only one. Dr. Invented Example is available.",
        ledger,
      });
      expect(result.outcome).toBe("authoritative");
      expect(result.departmentCount).toBe(count);
      for (const row of rows) expect(result.text).toContain(row.name);
      expect(result.text).not.toMatch(/doctor|Dr\./i);
      expect(result.text).not.toMatch(/only one|only department/i);
    },
  );

  it("answers an Arabic challenge from the complete receipt and does not list doctors", () => {
    const { ledger, rows } = directoryLedger(20);
    const result = enforceClinicDirectoryReply({
      locale: "ar",
      latestPatientText: "مفيش اقسام تانية؟",
      text: "القسم الوحيد هو القسم المختار، والدكاترة هم فلان وفلان.",
      ledger,
    });
    expect(result.outcome).toBe("authoritative");
    for (const row of rows) expect(result.text).toContain(row.name);
    expect(result.text).not.toMatch(/دكاترة|دكتور/);
    expect(result.text).not.toContain("الوحيد");
  });

  it("never treats selectedDepartmentId as the authoritative directory result", () => {
    const { ledger, rows } = directoryLedger(3);
    const reply = buildClinicDirectoryReply({ locale: "en", departments: rows });
    expect(reply).toContain(rows[0]!.name);
    expect(reply).toContain(rows[1]!.name);
    expect(reply).toContain(rows[2]!.name);
    expect(reply).not.toContain(SELECTED);

    const result = enforceClinicDirectoryReply({
      locale: "en",
      latestPatientText: "Are there more departments?",
      text: `Only ${SELECTED} is active.`,
      ledger,
    });
    expect(result.text).toBe(reply);
  });

  it("fails closed instead of validating a partial or malformed directory receipt", () => {
    const ledger = createGroundingLedger();
    ledger.record("list_clinic_departments", {
      scope: "clinic_directory",
      complete: true,
      departments: departments(3),
      department_count: 2,
    });
    const result = enforceClinicDirectoryReply({
      locale: "en",
      latestPatientText: "What departments are available?",
      text: "Only the selected department exists.",
      ledger,
    });
    expect(result.outcome).toBe("unavailable");
    expect(result.text).not.toContain("Only the selected department");
  });

  it("leaves ordinary mid-booking conversation untouched", () => {
    // An ordinary booking turn has no directory receipt: the model never read
    // the clinic-wide directory, so nothing here is a directory answer.
    const ledger = createGroundingLedger();
    ledger.record("check_availability", {
      doctorId: DOCTOR,
      availableSlots: ["09:00", "09:15"],
    });
    const text = "Which day works for you?";
    expect(
      enforceClinicDirectoryReply({
        locale: "en",
        latestPatientText: "The 31st",
        text,
        ledger,
      }),
    ).toEqual({ text, outcome: "passthrough", departmentCount: null });
  });
});

// ---------------------------------------------------------------------------
// P11I-R — the adversarial corpus
// ---------------------------------------------------------------------------

/**
 * Wording deliberately absent from production code.
 *
 * **These are examples, not a lexicon.** The point of this corpus is the
 * opposite of the usual one: it is *not* here so that someone can paste it into
 * `DIRECTORY_QUESTION_PATTERNS` until the file goes green. It is here to prove
 * that the safety properties hold *without* the classifier recognising any of
 * it — which is why every assertion below is stated over the corpus regardless
 * of what `isClinicDirectoryQuestion` returns, and why `does not become the
 * production lexicon` asserts none of it appears in the shipped module.
 *
 * The model is the intent classifier. `list_clinic_departments` is mounted at
 * every booking stage, so any of these can be answered; the server's job is to
 * make the answer honest either way.
 */
const NOVEL_PARAPHRASES: readonly string[] = [
  // formal Arabic
  "أرجو إفادتي بالأقسام الطبية المتوفرة لديكم.",
  "نرجو تزويدنا بقائمة الأقسام العاملة حاليًا.",
  "كم عدد الأقسام في العيادة؟",
  // Egyptian / colloquial
  "طب انتو بتشتغلوا في ايه تاني غير العلاج الطبيعي؟",
  "العيادة فيها ايه بالظبط؟",
  "هو ده كل اللي عندكو؟",
  "انتو بتعالجوا ايه؟",
  // English
  "Can you tell me everything your clinic covers?",
  "What else do you do besides physiotherapy?",
  "Give me the full list of your medical units.",
  // mixed
  "عندكو dermatology ولا بس physical therapy؟",
  // typos / noise / transliteration
  "ايه الاقسم الموجوده عندكو",
  "wht departmnts do u have",
  "eh el a2sam el mawgoda?",
  // indirect
  "انا مش عارف اروح لمين، عندكو ايه؟",
  "I have a heart issue, can you help with that here?",
  // existence of one specialty
  "عندكم قسم جلدية؟",
  "Do you have a cardiology department?",
  // count / enumeration
  "كام قسم عندكو؟",
  "عددوا لي الأقسام واحد واحد",
  // correction / challenge to a previous answer
  "لا انا متأكد ان عندكو جلدية، راجع تاني",
  "That's not right, I saw cardiology on your page.",
  "متأكد؟ ده كل اللي عندكو؟",
  "أكيد فيه غير ده",
];

/** Closed-list claims a model might make with no directory receipt at all. */
const UNFOUNDED_CLAIMS: readonly string[] = [
  "لا، القسم الوحيد النشط حاليًا هو العلاج الطبيعي. الأقسام التانية غير متاحة دلوقتي.",
  "القسم الموجود حاليًا هو العلاج الطبيعي فقط.",
  "مفيش غير قسم واحد عندنا.",
  "دي كل الأقسام اللي عندنا.",
  "لا يوجد لدينا أقسام أخرى.",
  "التخصص الوحيد المتاح هو العلاج الطبيعي.",
  "Physical Therapy is the only department we have.",
  "We don't have a cardiology department.",
  "Those are all our departments.",
  "There are no other specialties at the clinic.",
];

/** Ordinary booking sentences that assert nothing about the directory. */
const INNOCENT_REPLIES: readonly string[] = [
  "تمام، الدكتور الوحيد المتاح بكرة هو د. أحمد. تحب احجزلك؟",
  "المواعيد المتاحة بكرة: 9:00، 9:15، 9:30.",
  "بس انا محتاج اسمك الأول عشان اكمل الحجز.",
  "The only time left tomorrow is 4:30 PM.",
  "قسم العلاج الطبيعي فيه دكتورين: د. حنين و د. يوسف.",
  "Your appointment in the Physical Therapy department is confirmed.",
];

describe("P11I-R · the guarantees do not depend on recognising the wording", () => {
  it("does not become the production lexicon", async () => {
    const source = await readFile(
      resolve(process.cwd(), "lib/ai/clinic-directory.ts"),
      "utf8",
    );
    for (const phrase of [...NOVEL_PARAPHRASES, ...UNFOUNDED_CLAIMS]) {
      expect(source, `production code must not encode "${phrase}"`).not.toContain(phrase);
    }
  });

  it("answers every paraphrase from the receipt once the model reads the directory", () => {
    for (const text of NOVEL_PARAPHRASES) {
      const { ledger, rows } = directoryLedger(3);
      const result = enforceClinicDirectoryReply({
        locale: "ar",
        latestPatientText: text,
        // The exact defect P11I was opened for: a true selected department
        // promoted into a false claim about the clinic.
        text: "القسم الوحيد النشط حاليًا هو العلاج الطبيعي.",
        ledger,
      });
      expect(result.outcome, text).toBe("authoritative");
      expect(result.departmentCount, text).toBe(3);
      for (const row of rows) expect(result.text, text).toContain(row.name);
    }
  });

  it("refuses a closed-list claim on any wording when no receipt backs it", () => {
    for (const patientText of NOVEL_PARAPHRASES) {
      for (const claim of UNFOUNDED_CLAIMS) {
        const ledger = createGroundingLedger();
        // A committed booking roster is real state, and it is never evidence
        // about the clinic's department list.
        ledger.record("prepare_booking", {
          department: { id: SELECTED, name: "Unit 1" },
          doctors: [{ id: DOCTOR, name: "د. حنين" }],
        });
        const result = enforceClinicDirectoryReply({
          locale: "ar",
          latestPatientText: patientText,
          text: claim,
          ledger,
        });
        expect(result.outcome, `${patientText} / ${claim}`).not.toBe("passthrough");
        expect(result.text, claim).not.toContain("الوحيد");
        expect(result.text, claim).not.toContain("only");
      }
    }
  });

  it("leaves ordinary booking sentences alone on the same wording", () => {
    for (const patientText of NOVEL_PARAPHRASES) {
      for (const reply of INNOCENT_REPLIES) {
        const ledger = createGroundingLedger();
        ledger.record("check_availability", { availableSlots: ["09:00"] });
        const result = enforceClinicDirectoryReply({
          locale: "ar",
          latestPatientText: patientText,
          text: reply,
          ledger,
        });
        // Only the shapes the classifier can prove may pre-empt an ordinary
        // sentence; nothing else here may.
        if (!isClinicDirectoryQuestion(patientText)) {
          expect(result.outcome, `${patientText} / ${reply}`).toBe("passthrough");
          expect(result.text).toBe(reply);
        }
      }
    }
  });

  it("holds for the same wording during an active booking with everything selected", () => {
    // department, doctor, day and time all committed: the booking is as far
    // along as it gets, and none of it is directory evidence.
    const committed = () => {
      const ledger = createGroundingLedger();
      ledger.record("prepare_booking", {
        department: { id: SELECTED, name: "Unit 1" },
        doctors: [{ id: DOCTOR, name: "د. حنين" }],
      });
      ledger.record("check_availability", {
        doctorId: DOCTOR,
        date: "2030-08-31",
        availableSlots: ["09:00", "09:15"],
      });
      return ledger;
    };
    for (const text of NOVEL_PARAPHRASES) {
      const result = enforceClinicDirectoryReply({
        locale: "ar",
        latestPatientText: text,
        text: "تمام، القسم الوحيد المتاح هو العلاج الطبيعي، والميعاد 9:00.",
        ledger: committed(),
      });
      // "unavailable" for the shapes the server could prove, "unfounded_claim"
      // for the rest. Which of the two fires is an implementation detail; that
      // neither is `passthrough` is the guarantee.
      expect(result.outcome, text).not.toBe("passthrough");
      expect(result.text, text).not.toContain("الوحيد");
    }
  });

  it("keeps the directory read stage-independent for every booking stage", () => {
    for (const stage of BOOKING_STAGES) {
      expect(
        allowedToolsForStage(stage, [...PATIENT_TOOL_NAMES]),
        `${stage} must keep the directory readable`,
      ).toContain("list_clinic_departments");
    }
  });

  it("never mutates booking state: the enforcement is a pure function of its arguments", () => {
    const ledger = createGroundingLedger();
    ledger.record("prepare_booking", {
      department: { id: SELECTED, name: "Unit 1" },
      doctors: [{ id: DOCTOR, name: "د. حنين" }],
    });
    const before = {
      tools: [...ledger.toolsSeen()],
      doctorIds: [...ledger.doctorIds()],
      result: JSON.stringify(ledger.resultFor("prepare_booking")),
    };
    for (const text of NOVEL_PARAPHRASES) {
      enforceClinicDirectoryReply({
        locale: "ar",
        latestPatientText: text,
        text: "دي كل الأقسام اللي عندنا.",
        ledger,
      });
    }
    expect([...ledger.toolsSeen()]).toEqual(before.tools);
    expect([...ledger.doctorIds()]).toEqual(before.doctorIds);
    expect(JSON.stringify(ledger.resultFor("prepare_booking"))).toBe(before.result);
  });
});
