import type { GroundingLedger } from "@/lib/ai/patient-grounding";
import {
  formatPersonName,
  localizeEntityLabel,
} from "@/lib/ai/entity-labels";

type Row = Record<string, unknown>;

export type PatientFactReply = {
  text: string;
  outcome:
    | "passthrough"
    | "services"
    | "insurance"
    | "appointment_lookup"
    | "doctor_roster"
    | "available_days"
    | "available_times"
    | "availability_comparison";
};

/**
 * Deterministic presentation for live clinic facts whose completeness and
 * line layout are part of the patient contract. The model decides which read
 * tool answers the question; once the tool returns, its receipt owns the list.
 */
export function enforcePatientFactReply(input: {
  locale: "ar" | "en";
  text: string;
  ledger: GroundingLedger;
  latestPatientText?: string | null;
  rosterOnly?: boolean;
}): PatientFactReply {
  // A write receipt always owns the final sentence. Reads commonly precede the
  // write in the same model turn, but must not replace its success/failure copy.
  if (
    input.ledger.resultFor("create_preliminary_booking") !== null ||
    // The complete clinic-directory guard runs immediately before this one.
    input.ledger.resultFor("list_clinic_departments") !== null
  ) {
    return { text: input.text, outcome: "passthrough" };
  }

  const availability = asRow(input.ledger.resultFor("check_availability"));
  if (availability) {
    return {
      text: buildAvailableTimesReply(input.locale, availability, input.latestPatientText),
      outcome: "available_times",
    };
  }
  const comparison = asRow(input.ledger.resultFor("compare_doctor_availability"));
  if (comparison) {
    return {
      text: buildAvailabilityComparisonReply(input.locale, comparison),
      outcome: "availability_comparison",
    };
  }
  const availableDays = asRow(input.ledger.resultFor("list_available_days"));
  if (availableDays) {
    return {
      text: buildAvailableDaysReply(input.locale, availableDays, input.latestPatientText),
      outcome: "available_days",
    };
  }
  const roster =
    asRow(input.ledger.resultFor("list_doctors")) ??
    asRow(input.ledger.resultFor("prepare_booking"));
  if (roster && rosterNeedsPresentation(roster)) {
    return {
      text: buildDoctorRosterReply(input.locale, roster, input.rosterOnly === true),
      outcome: "doctor_roster",
    };
  }
  const services = asRow(input.ledger.resultFor("list_department_services"));
  if (services) {
    return {
      text: buildServicesReply(input.locale, services),
      outcome: "services",
    };
  }
  const insurance = asRow(input.ledger.resultFor("list_clinic_insurance"));
  if (insurance) {
    return {
      text: buildInsuranceReply(input.locale, insurance),
      outcome: "insurance",
    };
  }
  const lookup = asRow(input.ledger.resultFor("lookup_appointment"));
  if (lookup) {
    return {
      text: buildAppointmentLookupReply(input.locale, lookup),
      outcome: "appointment_lookup",
    };
  }
  return { text: input.text, outcome: "passthrough" };
}

function rosterNeedsPresentation(result: Row): boolean {
  return (
    result.scope === "all_departments" ||
    result.needs_selection === true ||
    result.needs_clarification === true ||
    asRow(result.treating_doctor) !== null ||
    (Array.isArray(result.doctors) && result.resolved !== true)
  );
}

const PATIENT_LIST_LIMIT = 6;

function buildDoctorRosterReply(locale: "ar" | "en", result: Row, rosterOnly: boolean): string {
  const ar = locale === "ar";
  if (result.scope === "all_departments") {
    const blocks = rows(result.departments).map((department) => {
      const name = localizeEntityLabel(readString(department.name), locale);
      const doctors = rows(department.doctors)
        .map((doctor) => formatPersonName(readString(doctor.name), locale))
        .filter(Boolean);
      const lines = doctors.length > 0
        ? doctors.map((doctor, index) => `${index + 1}. ${doctor}`).join("\n")
        : ar ? "لا يوجد أطباء متاحون للحجز حاليًا." : "No doctors are currently available to book.";
      return `${name || (ar ? "القسم" : "Department")}:\n${lines}`;
    });
    return blocks.length > 0
      ? `${ar ? "الأطباء حسب القسم" : "Doctors by department"}:\n\n${blocks.join("\n\n")}`
      : ar ? "لا توجد أقسام أو أطباء متاحون للحجز حاليًا." : "No departments or doctors are currently available to book.";
  }
  const treating = asRow(result.treating_doctor);
  if (treating) {
    const treatingName = formatPersonName(readString(treating.name), locale);
    const allOthers = rows(result.other_doctors)
      .map((doctor) => formatPersonName(readString(doctor.name), locale))
      .filter(Boolean);
    const others = allOthers.slice(0, PATIENT_LIST_LIMIT);
    const first = ar
      ? `طبيبك المعالج هو ${treatingName || "—"}. تحب أشوف المواعيد المتاحة معاه؟`
      : `Your treating doctor is ${treatingName || "—"}. Would you like their available appointments?`;
    if (others.length === 0) return first;
    const list = others.map((name, index) => `${index + 1}. ${name}`).join("\n");
    const more = listMoreCopy(locale, allOthers.length - others.length);
    return ar
      ? `${first}\nولو تحب دكتور تاني، المتاحون:\n${list}${more}`
      : `${first}\nIf you prefer another doctor, the available alternatives are:\n${list}${more}`;
  }

  if (result.field === "department") {
    const allDepartments = rows(result.departments)
      .map((department) => localizeEntityLabel(readString(department.name), locale))
      .filter(Boolean);
    const departments = allDepartments.slice(0, PATIENT_LIST_LIMIT);
    const list = departments.map((name, index) => `${index + 1}. ${name}`).join("\n");
    const more = listMoreCopy(locale, allDepartments.length - departments.length);
    return ar
      ? `الأقسام المتاحة عندنا:${list ? `\n${list}${more}` : "\nلا توجد أقسام متاحة للحجز حاليًا."}${rosterOnly ? "" : "\nتحب أنهي قسم؟"}`
      : `Available departments:${list ? `\n${list}${more}` : "\nNo departments are currently available for booking."}${rosterOnly ? "" : "\nWhich department would you like?"}`;
  }

  const allDoctors = rows(
    result.needs_clarification === true ? result.candidates : result.doctors,
  )
    .map((doctor) => formatPersonName(readString(doctor.name), locale))
    .filter(Boolean);
  const doctors = allDoctors.slice(0, PATIENT_LIST_LIMIT);
  const department = localizeEntityLabel(
    readString(asRow(result.department)?.name),
    locale,
  );
  if (doctors.length === 0) {
    return ar
      ? `لا يوجد أطباء متاحون للحجز${department ? ` في ${department}` : ""} حاليًا. تحب تختار قسمًا آخر؟`
      : `There are no doctors available to book${department ? ` in ${department}` : ""} right now. Would you like another department?`;
  }
  const list = doctors.map((name, index) => `${index + 1}. ${name}`).join("\n");
  const more = listMoreCopy(locale, allDoctors.length - doctors.length);
  if (result.needs_clarification === true) {
    return ar ? `تقصد مين بالضبط؟\n${list}${more}` : `Which doctor do you mean?\n${list}${more}`;
  }
  return ar
    ? `الأطباء المتاحون${department ? ` في ${department}` : ""}:\n${list}${more}${rosterOnly ? "" : "\nتحب تحجز مع مين؟"}`
    : `Available doctors${department ? ` in ${department}` : ""}:\n${list}${more}${rosterOnly ? "" : "\nWho would you like to book with?"}`;
}

function buildAvailableDaysReply(locale: "ar" | "en", result: Row, latestText?: string | null): string {
  const ar = locale === "ar";
  if (result.ok !== true) {
    return ar
      ? "معلش، مقدرتش أقرأ الأيام المتاحة دلوقتي. قولّي اليوم المناسب وأراجع مواعيده."
      : "Sorry, I could not read the available days just now. Tell me which day suits you and I will check it.";
  }
  const doctor = formatPersonName(readString(result.doctor_name), locale);
  const allDays = rows(result.availableDays)
    .map((day) => readString(day.date))
    .filter((day): day is string => Boolean(day));
  const requestedWeekday = weekdayFromQuestion(latestText);
  if (requestedWeekday !== null) {
    const matches = allDays.filter((day) => new Date(`${day}T12:00:00Z`).getUTCDay() === requestedWeekday);
    if (matches.length === 0) {
      return ar
        ? `لا، مفيش ${weekdayName(requestedWeekday, locale)} متاح${doctor ? ` مع ${doctor}` : ""} في الفترة الحالية.`
        : `No, there is no available ${weekdayName(requestedWeekday, locale)}${doctor ? ` with ${doctor}` : ""} in the current search window.`;
    }
    const visible = matches.slice(0, PATIENT_LIST_LIMIT);
    const list = visible.map((day) => `- ${formatPatientDate(day, locale)}`).join("\n");
    return ar
      ? `أيوه، أيام ${weekdayName(requestedWeekday, locale)} المتاحة${doctor ? ` مع ${doctor}` : ""}:\n${list}${listMoreCopy(locale, matches.length - visible.length)}`
      : `Yes. The available ${weekdayName(requestedWeekday, locale)} dates${doctor ? ` with ${doctor}` : ""} are:\n${list}${listMoreCopy(locale, matches.length - visible.length)}`;
  }
  const days = allDays;
  if (days.length === 0) {
    return ar
      ? `لا توجد أيام متاحة${doctor ? ` مع ${doctor}` : ""} في الفترة الحالية. تحب نبحث مع دكتور آخر؟`
      : `There are no available days${doctor ? ` with ${doctor}` : ""} in the current search window. Would you like another doctor?`;
  }
  const list = days.map((day) => `- ${formatPatientDate(day, locale)}`).join("\n");
  const nextWindow = result.window_kind === "next";
  // "بعد يوم ٨" asked for a boundary, so the heading names it and the question
  // stays: these are the real days after it, and the patient still chooses.
  const afterDate =
    result.window_kind === "after_boundary" ? readString(result.after_date) : null;
  const heading = afterDate
    ? ar
      ? `الأيام المتاحة بعد ${formatPatientDate(afterDate, locale)}`
      : `Available days after ${formatPatientDate(afterDate, locale)}`
    : nextWindow
      ? ar
        ? "المواعيد المتاحة في الفترة التالية"
        : "Available dates in the next window"
      : ar
        ? "الأيام المتاحة"
        : "Available days";
  return ar
    ? `${heading}${doctor ? ` مع ${doctor}` : ""}:\n${list}\nتحب أنهي يوم؟`
    : `${heading}${doctor ? ` with ${doctor}` : ""}:\n${list}\nWhich day suits you?`;
}

function buildAvailableTimesReply(
  locale: "ar" | "en",
  result: Row,
  latestPatientText?: string | null,
): string {
  const ar = locale === "ar";
  const date = readString(result.date);
  const doctor = formatPersonName(readString(result.doctor_name), locale);
  const timeFormat = result.time_format === "24h" ? "24h" : "12h";
  if (result.ok !== true) {
    return ar
      ? "معلش، مقدرتش أقرأ المواعيد المتاحة لليوم ده. تحب نجرب يومًا آخر؟"
      : "Sorry, I could not read the available times for that day. Would you like to try another day?";
  }
  const allTimes = Array.isArray(result.availableSlots)
    ? result.availableSlots
        .map(readString)
        .filter((time): time is string => Boolean(time))
    : [];
  const times = [...allTimes].sort((left, right) => left.localeCompare(right));
  if (times.length === 0) {
    const alternatives = rows(result.alternativeDays).slice(0, 3).map((alternative) => {
      const alternativeDate = readString(alternative.date);
      const slots = Array.isArray(alternative.slots)
        ? alternative.slots.map(readString).filter((slot): slot is string => Boolean(slot))
        : [];
      if (!alternativeDate) return null;
      return `- ${formatPatientDate(alternativeDate, locale)}${slots.length > 0 ? `: ${slots.map((slot) => formatPatientTime(slot, locale, timeFormat)).join(ar ? "، " : ", ")}` : ""}`;
    }).filter((line): line is string => Boolean(line));
    const alternativeText = alternatives.length > 0
      ? ar
        ? `\nأقرب بدائل مناسبة:\n${alternatives.join("\n")}`
        : `\nNearest useful alternatives:\n${alternatives.join("\n")}`
      : "";
    const constrained = typeof result.after_minutes === "number";
    return ar
      ? `${constrained ? "لا يوجد وقت متاح بعد التوقيت المطلوب" : "لا توجد مواعيد متاحة"}${doctor ? ` مع ${doctor}` : ""}${date ? ` يوم ${formatPatientDate(date, locale)}` : ""}.${alternativeText}`
      : `${constrained ? "No time is available after the requested time" : "No appointments are available"}${doctor ? ` with ${doctor}` : ""}${date ? ` on ${formatPatientDate(date, locale)}` : ""}.${alternativeText}`;
  }
  if (
    result.selected_from_offer !== true &&
    result.date_from_memory !== true &&
    asksAvailabilityYesNo(latestPatientText)
  ) {
    return ar
      ? `أيوه، فيه مواعيد متاحة${doctor ? ` مع ${doctor}` : ""}${date ? ` يوم ${formatPatientDate(date, locale)}` : ""}. تحب تحجز اليوم ده؟`
      : `Yes, appointments are available${doctor ? ` with ${doctor}` : ""}${date ? ` on ${formatPatientDate(date, locale)}` : ""}. Would you like to book that day?`;
  }
  const list = times.map((time) => `- ${formatPatientTime(time, locale, timeFormat)}`).join("\n");
  return ar
    ? `المواعيد المتاحة${doctor ? ` مع ${doctor}` : ""}${date ? ` يوم ${formatPatientDate(date, locale)}` : ""}:\n${list}\nتحب أنهي معاد؟`
    : `Available times${doctor ? ` with ${doctor}` : ""}${date ? ` on ${formatPatientDate(date, locale)}` : ""}:\n${list}\nWhich time suits you?`;
}

function asksAvailabilityYesNo(value: string | null | undefined): boolean {
  const text = (value ?? "").toLocaleLowerCase();
  if (!/(?:available|availability|متاح|فاضي)/i.test(text)) return false;
  return !/(?:what\s+(?:times?|slots?|appointments?)|show\s+(?:times?|slots?)|إيه\s+المواعيد|ايه\s+المواعيد|المواعيد\s+المتاحة|الأوقات\s+المتاحة|الاوقات\s+المتاحة)/i.test(text);
}

function buildAvailabilityComparisonReply(locale: "ar" | "en", result: Row): string {
  const ar = locale === "ar";
  const date = readString(result.date);
  const lines = rows(result.comparisons).map((item) => {
    const doctor = formatPersonName(readString(asRow(item.doctor)?.name), locale) ||
      readString(item.reference) || (ar ? "الطبيب" : "Doctor");
    if (item.resolved !== true) {
      return ar ? `${doctor}: مقدرتش أحدده ضمن أطباء العيادة.` : `${doctor}: not found in the clinic roster.`;
    }
    const slots = Array.isArray(item.slots)
      ? item.slots.map(readString).filter((slot): slot is string => Boolean(slot))
      : [];
    return slots.length > 0
      ? `${doctor}: ${slots.map((slot) => formatPatientTime(slot, locale)).join(ar ? "، " : ", ")}`
      : ar
        ? `${doctor}: مفيش وقت متاح بعد القيد المطلوب.`
        : `${doctor}: no time is available after the requested constraint.`;
  });
  const heading = date
    ? ar
      ? `التوفر يوم ${formatPatientDate(date, locale)}:`
      : `Availability on ${formatPatientDate(date, locale)}:`
    : ar ? "التوفر:" : "Availability:";
  return `${heading}\n${lines.join("\n")}`;
}

export function formatPatientDate(value: string, locale: "ar" | "en"): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  const localized = new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  return localized;
}

export function formatPatientTime(
  value: string,
  locale: "ar" | "en",
  timeFormat: "12h" | "24h" = "12h",
): string {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return value;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return value;
  if (timeFormat === "24h") return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (locale === "en") {
    const suffix = hour < 12 ? "AM" : "PM";
    const clockHour = hour % 12 || 12;
    return `${clockHour}:${String(minute).padStart(2, "0")} ${suffix}`;
  }
  const period = hour < 12 ? "صباحًا" : "مساءً";
  const clockHour = hour % 12 || 12;
  return `${clockHour}:${String(minute).padStart(2, "0")} ${period}`;
}

function listMoreCopy(locale: "ar" | "en", remaining: number): string {
  if (remaining <= 0) return "";
  return locale === "ar"
    ? `\nوفي ${remaining} خيارات تانية — قولّي لو تحب أشوفهالك.`
    : `\nThere are ${remaining} more options — ask me to show them.`;
}

function weekdayFromQuestion(value: string | null | undefined): number | null {
  const text = (value ?? "").toLocaleLowerCase();
  const names: Array<[RegExp, number]> = [
    [/(?:الأحد|الاحد|يوم\s+(?:أ|ا)?حد|sunday)/i, 0],
    [/(?:الاثنين|الإثنين|monday)/i, 1],
    [/(?:الثلاثاء|tuesday)/i, 2],
    [/(?:الأربعاء|الاربعاء|wednesday)/i, 3],
    [/(?:الخميس|thursday)/i, 4],
    [/(?:الجمعة|friday)/i, 5],
    [/(?:السبت|saturday)/i, 6],
  ];
  return names.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function weekdayName(value: number, locale: "ar" | "en"): string {
  const anchor = new Date(Date.UTC(2026, 7, 30 + value, 12));
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    weekday: "long",
    timeZone: "UTC",
  }).format(anchor);
}

function buildServicesReply(locale: "ar" | "en", result: Row): string {
  const ar = locale === "ar";
  if (result.needs_selection === true || result.needs_clarification === true) {
    const departments = rows(
      result.needs_clarification === true ? result.candidates : result.departments,
    )
      .map((row) => readString(row.name))
      .filter((name): name is string => Boolean(name))
      .map((name) => localizeEntityLabel(name, locale));
    const list = departments.map((name) => `- ${name}`).join("\n");
    if (result.needs_clarification === true) {
      return ar
        ? `تقصد خدمات أنهي قسم بالضبط؟${list ? `\n${list}` : ""}`
        : `Which department exactly do you mean?${list ? `\n${list}` : ""}`;
    }
    return ar
      ? `تحب تعرف خدمات أنهي قسم؟${list ? `\n${list}` : ""}`
      : `Which department's services would you like to know about?${list ? `\n${list}` : ""}`;
  }
  if (result.found !== true) {
    const requested = localizeEntityLabel(readString(result.requested_department), locale);
    const departments = rows(result.departments)
      .map((row) => localizeEntityLabel(readString(row.name), locale))
      .filter(Boolean)
      .slice(0, PATIENT_LIST_LIMIT);
    const alternatives = departments.length > 0
      ? departments.map((name) => `- ${name}`).join("\n")
      : "";
    return ar
      ? `${requested ? `لا، مفيش قسم ${requested} ضمن أقسام العيادة المتاحة حاليًا.` : "القسم المطلوب مش متاح ضمن أقسام العيادة حاليًا."}${alternatives ? `\nالأقسام المتاحة:\n${alternatives}` : ""}`
      : `${requested ? `${requested} is not available among this clinic's active departments.` : "That department is not available among this clinic's active departments."}${alternatives ? `\nAvailable departments:\n${alternatives}` : ""}`;
  }

  const groups = result.scope === "all_departments"
    ? rows(result.departments).map((department) => ({
        name: readString(department.name),
        services: rows(department.services),
      }))
    : [{
        name: readString(asRow(result.department)?.name),
        services: rows(result.services),
      }];
  const blocks = groups.map((group) => {
    const heading = localizeEntityLabel(group.name, locale);
    const lines = group.services.flatMap((service) => {
      // A service name is clinic-authored content, not a department label.
      // Localizing it used to turn "Skin Consultation" into "Dermatology".
      const name = readString(service.name);
      if (!name) return [];
      const price = service.price;
      const currency = readString(service.currency) ?? readString(result.currency) ?? "";
      const priceText =
        typeof price === "number" || (typeof price === "string" && price.trim())
          ? `${String(price)}${currency ? ` ${currency}` : ""}`
          : ar
            ? "السعر غير متاح — تواصل مع العيادة"
            : "Price unavailable — contact the clinic";
      return [`${name} — ${priceText}`];
    });
    if (lines.length === 0) {
      lines.push(ar ? "لا توجد خدمات وأسعار مضبوطة لهذا القسم حاليًا." : "No services and prices are configured for this department right now.");
    }
    return `${heading}:\n${lines.join("\n")}`;
  });
  return blocks.join("\n\n");
}

function buildInsuranceReply(locale: "ar" | "en", result: Row): string {
  const ar = locale === "ar";
  const providers = rows(result.providers)
    .map((row) => readString(row.name))
    .filter((name): name is string => Boolean(name));
  if (providers.length === 0) {
    return ar
      ? "لا توجد شركات تأمين مضبوطة في إعدادات العيادة حاليًا. تقدر تتواصل مع العيادة للتأكد."
      : "No insurance providers are currently configured in the clinic settings. You can contact the clinic to confirm.";
  }
  if (result.matched === true) {
    const name = readString(asRow(result.provider)?.name) ?? "";
    return ar
      ? `أيوه، العيادة تتعامل مع ${name}. تفاصيل التغطية يؤكدها فريق العيادة.`
      : `Yes, the clinic accepts ${name}. Clinic staff can confirm the coverage details.`;
  }
  const list = providers.map((name) => `- ${name}`).join("\n");
  if (result.matched === false) {
    return ar
      ? `شركة التأمين دي مش ضمن الشركات المضبوطة حاليًا. الشركات الموجودة:\n${list}`
      : `That insurer is not in the clinic's configured list. The configured providers are:\n${list}`;
  }
  return ar
    ? `شركات التأمين الموجودة في إعدادات العيادة:\n${list}`
    : `Insurance providers configured by the clinic:\n${list}`;
}

function buildAppointmentLookupReply(locale: "ar" | "en", result: Row): string {
  const ar = locale === "ar";
  if (result.reason === "needs_identity") {
    const missing = Array.isArray(result.missing) ? result.missing : [];
    const name = missing.includes("full_name");
    const id = missing.includes("national_id");
    if (name && id) return ar ? "محتاج الاسم الكامل والرقم القومي فقط." : "I only need the full name and national ID.";
    if (name) return ar ? "محتاج الاسم الكامل فقط." : "I only need the full name.";
    return ar ? "محتاج الرقم القومي فقط." : "I only need the national ID.";
  }
  if (result.reason === "no_match") {
    return ar
      ? "مقدرتش ألاقي حجز بالبيانات دي. تقدر تتواصل مع فريق العيادة علشان يراجعوه."
      : "I could not find a booking with those details. Clinic staff can check it for you.";
  }
  const appointments = rows(result.appointments);
  if (result.found === true && appointments.length === 0) {
    return ar
      ? "لقيت الملف، لكن مفيش موعد قادم مسجل عليه. تحب نبدأ طلب حجز جديد؟"
      : "I found the file, but it has no upcoming appointment. Would you like to start a new booking request?";
  }
  if (appointments.length === 0) {
    return ar
      ? "معلش، تعذّر إكمال البحث عن الموعد. تقدر تتواصل مع فريق العيادة."
      : "Sorry, the appointment lookup could not be completed. You can contact clinic staff.";
  }
  return appointments.map((appointment, index) => {
    const doctor = formatPersonName(readString(appointment.doctor_name), locale);
    const department = localizeEntityLabel(
      readString(appointment.service_name) ?? readString(appointment.department_name),
      locale,
    );
    const status = readString(appointment.status) ?? "pending";
    const labels = ar
      ? [
          `الموعد ${index + 1}:`,
          `التاريخ: ${readString(appointment.date) ?? "—"}`,
          `الوقت: ${readString(appointment.time) ?? "—"}`,
          `الطبيب: ${doctor || "—"}`,
          `القسم/الخدمة: ${department || "—"}`,
          `الحالة: ${status}`,
        ]
      : [
          `Appointment ${index + 1}:`,
          `Date: ${readString(appointment.date) ?? "—"}`,
          `Time: ${readString(appointment.time) ?? "—"}`,
          `Doctor: ${doctor || "—"}`,
          `Department/service: ${department || "—"}`,
          `Status: ${status}`,
        ];
    return labels.join("\n");
  }).join("\n\n");
}

function asRow(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : null;
}

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((item): item is Row => Boolean(asRow(item)))
    : [];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
