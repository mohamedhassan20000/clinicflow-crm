/**
 * The fixture clinic the Patient Assistant Production Acceptance suite runs
 * against.
 *
 * It is a *clinic*, not a minimal test double: it carries the configuration
 * shapes that actually break the assistant in production — two doctors whose
 * first names collide, a doctor on leave, a doctor in the "wrong" department, a
 * department whose stored name is Arabic while patients type English, services
 * with real prices, insurers, FAQ entries, and an existing patient with an
 * existing pending appointment to cancel.
 *
 * Every acceptance grader treats this file as the closed world. A doctor, a
 * department, a service, a price, a day or a slot that a reply names and this
 * file does not contain is, by definition, a hallucination.
 *
 * Pure data. No `server-only`, no imports with side effects, no database.
 */

export type FixtureDepartment = { id: string; name: string };

export type FixtureDoctor = {
  id: string;
  name: string;
  departmentId: string;
  state: "available" | "on_leave" | "inactive";
  unavailableUntil?: string;
};

export type FixtureService = {
  id: string;
  name: string;
  departmentId: string;
  price: number | null;
};

export type FixtureInsurer = { id: string; name: string };

export type FixtureFaq = { id: string; question: string; answer: string };

export type FixtureAppointment = {
  id: string;
  patientId: string;
  doctorId: string;
  date: string;
  time: string;
  status: "pending" | "confirmed";
};

const D = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const M = (n: number) => `bbbbbbbb-0000-4000-8000-00000000000${n}`;
const S = (n: number) => `cccccccc-0000-4000-8000-00000000000${n}`;
const I = (n: number) => `dddddddd-0000-4000-8000-00000000000${n}`;
const A = (n: number) => `eeeeeeee-0000-4000-8000-00000000000${n}`;

export const DEPT_DERM = D(1);
export const DEPT_DENT = D(2);
export const DEPT_PHYSIO = D(3);
export const DEPT_CARDIO = D(4);

export const FIXTURE_DEPARTMENTS: readonly FixtureDepartment[] = [
  { id: DEPT_DERM, name: "Dermatology" },
  { id: DEPT_DENT, name: "الأسنان" },
  { id: DEPT_PHYSIO, name: "Physical Therapy" },
  { id: DEPT_CARDIO, name: "Cardiology" },
];

/**
 * The roster, with the two traps that matter:
 *
 *   * `Ahmed Nabil` and `Ahmed Mostafa` share a first name *and* a department,
 *     so "دكتور احم" has more than one plausible reading and the only correct
 *     behaviour is to ask which one.
 *   * `Hoda Sami` is on leave — a real status the clinic's own records prove,
 *     which must never be reported as a technical error and must never be
 *     offered as bookable.
 */
export const FIXTURE_DOCTORS: readonly FixtureDoctor[] = [
  { id: M(1), name: "Ahmed Nabil", departmentId: DEPT_DERM, state: "available" },
  { id: M(2), name: "Ahmed Mostafa", departmentId: DEPT_DERM, state: "available" },
  { id: M(3), name: "Sara Ali", departmentId: DEPT_DERM, state: "available" },
  { id: M(4), name: "Laila Fouad", departmentId: DEPT_DENT, state: "available" },
  { id: M(5), name: "Mohamed Khaled", departmentId: DEPT_PHYSIO, state: "available" },
  {
    id: M(6),
    name: "Hoda Sami",
    departmentId: DEPT_CARDIO,
    state: "on_leave",
    unavailableUntil: "2026-10-01",
  },
  { id: M(7), name: "Tamer Wagdy", departmentId: DEPT_CARDIO, state: "available" },
];

export const FIXTURE_SERVICES: readonly FixtureService[] = [
  { id: S(1), name: "Dermatology Consultation", departmentId: DEPT_DERM, price: 400 },
  { id: S(2), name: "Laser Session", departmentId: DEPT_DERM, price: 1200 },
  { id: S(3), name: "Dental Cleaning", departmentId: DEPT_DENT, price: 600 },
  { id: S(4), name: "Filling", departmentId: DEPT_DENT, price: 900 },
  { id: S(5), name: "Physiotherapy Session", departmentId: DEPT_PHYSIO, price: 350 },
  { id: S(6), name: "Cardiology Consultation", departmentId: DEPT_CARDIO, price: 500 },
];

export const FIXTURE_CURRENCY = "EGP";

export const FIXTURE_INSURERS: readonly FixtureInsurer[] = [
  { id: I(1), name: "AXA" },
  { id: I(2), name: "MetLife" },
  { id: I(3), name: "Allianz" },
];

export const FIXTURE_FAQ: readonly FixtureFaq[] = [
  {
    id: "faq-parking",
    question: "Is there parking?",
    answer: "Yes, there is free underground parking for patients.",
  },
  {
    id: "faq-walkin",
    question: "Do you accept walk-ins?",
    answer: "Walk-ins are seen only when a slot is free on the day.",
  },
];

export const FIXTURE_CLINIC = {
  id: "acceptance-clinic",
  name: "Nile Care Clinic",
  phone: "+20 2 1234 5678",
  address: "12 Corniche El Nil, Cairo",
  timezone: "Africa/Cairo",
  country: "EG",
  workingHours: "Sunday to Thursday, 09:00 to 17:00",
} as const;

/** Real bookable days, far enough out to clear the 24-hour minimum notice. */
export const FIXTURE_DAYS: readonly string[] = [
  "2026-09-07",
  "2026-09-08",
  "2026-09-10",
];

export const FIXTURE_SLOTS: readonly string[] = ["10:00", "10:30", "11:00"];

/** A doctor with a genuinely empty calendar, for the "no availability" flow. */
export const FIXTURE_NO_AVAILABILITY_DOCTOR = M(7);

export const FIXTURE_PATIENT = {
  id: "ffffffff-0000-4000-8000-000000000001",
  name: "Omar Hassan",
  dateOfBirth: "1990-04-12",
  nationalId: "29004121200345",
  phone: "+201000000001",
} as const;

export const FIXTURE_APPOINTMENTS: readonly FixtureAppointment[] = [
  {
    id: A(1),
    patientId: FIXTURE_PATIENT.id,
    doctorId: M(1),
    date: "2026-09-07",
    time: "10:00",
    status: "pending",
  },
];

// ---------------------------------------------------------------------------
// The closed world, as flat vocabularies the graders check replies against
// ---------------------------------------------------------------------------

export const REAL_DOCTOR_NAMES: readonly string[] = FIXTURE_DOCTORS.map((d) => d.name);
export const REAL_DEPARTMENT_NAMES: readonly string[] = FIXTURE_DEPARTMENTS.map((d) => d.name);
export const REAL_SERVICE_NAMES: readonly string[] = FIXTURE_SERVICES.map((s) => s.name);
export const REAL_PRICES: readonly number[] = FIXTURE_SERVICES.flatMap((s) =>
  s.price === null ? [] : [s.price],
);
export const REAL_INSURER_NAMES: readonly string[] = FIXTURE_INSURERS.map((i) => i.name);

export function doctorById(id: string): FixtureDoctor | null {
  return FIXTURE_DOCTORS.find((item) => item.id === id) ?? null;
}

export function departmentById(id: string): FixtureDepartment | null {
  return FIXTURE_DEPARTMENTS.find((item) => item.id === id) ?? null;
}

/** Bookable doctors of a department: `available` only, never on leave. */
export function bookableDoctors(departmentId: string): readonly FixtureDoctor[] {
  return FIXTURE_DOCTORS.filter(
    (item) => item.departmentId === departmentId && item.state === "available",
  );
}

export function servicesOf(departmentId: string): readonly FixtureService[] {
  return FIXTURE_SERVICES.filter((item) => item.departmentId === departmentId);
}

/** Days this doctor actually has slots on. Empty for the no-availability case. */
export function daysFor(doctorId: string): readonly string[] {
  return doctorId === FIXTURE_NO_AVAILABILITY_DOCTOR ? [] : FIXTURE_DAYS;
}

export function slotsFor(doctorId: string, date: string): readonly string[] {
  if (doctorId === FIXTURE_NO_AVAILABILITY_DOCTOR) return [];
  return FIXTURE_DAYS.includes(date) ? FIXTURE_SLOTS : [];
}
