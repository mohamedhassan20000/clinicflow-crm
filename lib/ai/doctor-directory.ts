import "server-only";

import { resolveNamedEntity, type NamedEntity } from "@/lib/ai/entity-resolution";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import {
  DEPARTMENT_DISPLAY_COLUMNS,
  STAFF_DISPLAY_COLUMNS,
  displayText,
  selectWithOptional,
} from "@/lib/settings/display-names";

/**
 * The clinic's doctors, as the patient assistant is allowed to see them.
 *
 * This module exists because "which doctors can I book with?" and "is Dr X
 * bookable?" were previously answered by one overloaded query inside
 * `prepare_booking` that filtered to
 * `role=doctor AND department=<selected> AND is_active AND NOT is_deleted`.
 * That filter conflates three very different answers into one:
 *
 *   * a name the clinic has never heard of,
 *   * a real doctor who works in a *different* department,
 *   * a real doctor of *this* department who is deactivated or on leave.
 *
 * All three came back as `not_found` with three arbitrary fuzzy candidates and
 * no roster, so the assistant had nothing true to say and either invented a
 * doctor or dead-ended. The directory keeps every doctor the clinic has and
 * carries the *reason* a doctor is not bookable alongside the doctor, so the
 * caller can say the true thing and still offer the real alternatives.
 *
 * Everything here is read-only and clinic-scoped. Fuzzy matching is used for
 * doctors and departments only — never for patient identity, which stays on the
 * exact, rate-limited RPC path.
 */

export type DoctorAvailabilityState = "available" | "on_leave" | "inactive";

export type DirectoryDoctor = {
  id: string;
  /** The canonical stored name. Never replaced, only accompanied. */
  name: string;
  /** The clinic's own Arabic display name, when a person has authored one. */
  nameAr?: string | null;
  /** The clinic's own English display name, when a person has authored one. */
  nameEn?: string | null;
  departmentId: string | null;
  departmentName: string | null;
  state: DoctorAvailabilityState;
  /** ISO instant the current leave/unavailability ends. Only set for on_leave. */
  unavailableUntil: string | null;
};

export type DirectoryDepartment = {
  id: string;
  /** The canonical stored name. Never replaced, only accompanied. */
  name: string;
  nameAr?: string | null;
  nameEn?: string | null;
};

export type DoctorDirectory = {
  departments: DirectoryDepartment[];
  doctors: DirectoryDoctor[];
};

/**
 * The shape of a name the patient typed, once the directory has been consulted.
 * Every branch except `unknown` carries the doctor it is talking about, so the
 * assistant never has to guess *why* it cannot book someone.
 */
export type DoctorNameResolution =
  | { status: "resolved"; doctor: DirectoryDoctor }
  | { status: "ambiguous"; candidates: DirectoryDoctor[] }
  | { status: "other_department"; doctor: DirectoryDoctor }
  | { status: "on_leave"; doctor: DirectoryDoctor }
  | { status: "inactive"; doctor: DirectoryDoctor }
  | { status: "unknown" };

const MAX_DOCTORS = 200;
const DEPARTMENT_PAGE_SIZE = 100;

/** One page of a department read, in either of the two shapes above. */
type PageResult = { data: Record<string, unknown>[] | null; error: unknown };

/**
 * The complete active clinic department directory.
 *
 * PostgREST installations commonly cap one response page, so a single
 * `.limit(...)` cannot support the clinic-wide completeness claim. Stable,
 * ordered pagination keeps 3, 20, 100, and larger directories on the same
 * path without allowing booking state to narrow the query.
 */
export async function loadClinicDepartments(
  clinicId: string,
): Promise<DirectoryDepartment[]> {
  const db = createClinicScopedAdminClient(clinicId);
  const departments: DirectoryDepartment[] = [];
  for (let offset = 0; ; offset += DEPARTMENT_PAGE_SIZE) {
    // The bilingual display names travel with the row when the clinic's schema
    // carries them, and the read falls back to the canonical name alone when it
    // does not. See `lib/settings/display-names.ts`.
    const select = (columns: string) =>
      db
        .from("departments")
        .select(columns)
        .eq("is_active", true)
        .is("deleted_at", null)
        .order("name")
        .order("id");
    // Older filter-faithful unit doubles predate pagination and expose
    // `.limit()` but not `.range()`. Production PostgREST always takes the
    // paginated branch; the fallback keeps those doubles faithful to the old
    // single-query contract and still covers the required 100-row fixture.
    let paginated = true;
    const readPage = (columns: string) => {
      const built = select(columns) as unknown as {
        range?: (from: number, to: number) => PromiseLike<PageResult>;
        limit: (count: number) => PromiseLike<PageResult>;
      };
      paginated = typeof built.range === "function";
      return paginated
        ? built.range!(offset, offset + DEPARTMENT_PAGE_SIZE - 1)
        : built.limit(1_000);
    };
    const result = await selectWithOptional<Record<string, unknown>[]>(
      ["id", "name"],
      DEPARTMENT_DISPLAY_COLUMNS,
      readPage,
    );
    if (result.error) throw new Error("Could not read clinic departments.");
    const page = (result.data ?? []).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      nameAr: displayText(row.name_ar),
      nameEn: displayText(row.name_en),
    }));
    departments.push(...page);
    if (!paginated || page.length < DEPARTMENT_PAGE_SIZE) break;
  }
  return departments;
}

/**
 * Phrases that mean "somebody else", not a name.
 *
 * A patient answering "في دكاترة غيره؟" or "who else is available?" is asking
 * for the rest of the roster. Passing that string to the fuzzy resolver scored
 * it against real names and returned whichever three doctors happened to rank
 * highest, which is how an arbitrary doctor ended up being offered as a "did you
 * mean". Recognising the phrase for what it is keeps the resolver honest.
 */
/**
 * Word boundaries that work in Arabic.
 *
 * `\b` is defined against `[A-Za-z0-9_]`, so between two Arabic letters there is
 * never a boundary and at the edges of a purely Arabic string there is never one
 * either. Every Arabic pattern below used to be written with `\b` and therefore
 * **never matched anything at all**: "في دكاترة غيره؟" was not recognised as a
 * request for the roster, so it was passed to the fuzzy name resolver and scored
 * against real doctors — which is one of the ways a doctor nobody asked about
 * ends up in a tool result. These two lookarounds are the same idea as `\b`,
 * expressed against Unicode letters and digits instead of ASCII.
 */
const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";
function word(pattern: string): RegExp {
  return new RegExp(`${L}(?:${pattern})${R}`, "iu");
}

const OTHER_DOCTOR_PATTERNS: readonly RegExp[] = [
  /\b(?:any\s+)?other\s+doctors?\b/i,
  /\bwho\s+else\b/i,
  /\banyone\s+else\b/i,
  /\bsomeone\s+else\b/i,
  /\banother\s+(?:doctor|one)\b/i,
  /\bdifferent\s+doctor\b/i,
  /\ball\s+(?:the\s+)?doctors?\b/i,
  word("غير(?:ه|ها|هم)?"),
  word("تاني|تانى|ثاني|ثانى|آخر|اخر|أخرى|اخرى"),
  // F-15 — the plural, which is what a patient asking about a *roster* actually
  // writes: "في دكاترة تانيين؟", "هل هناك أطباء آخرون؟". The singular forms
  // above never matched either of them.
  word("تانيين|تانين|ثانيين|ثانين|آخرون|اخرون|آخرين|اخرين|بديل|بدائل"),
  word("مين\\s*(?:تاني|تانى|كمان|غيره)"),
  word("دكاترة|الدكاترة|اطباء|أطباء|الاطباء|الأطباء"),
  // Arabizi.
  /\b(?:doctors?\s*)?(?:tanyeen|tanyin|tany|ghero|gheru|gher)\b/i,
];

/** True when the text is a request for the rest of the roster, not a name. */
export function isOtherDoctorsRequest(value: string | null | undefined): boolean {
  const text = (value ?? "").trim();
  if (!text) return false;
  return OTHER_DOCTOR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Loads every doctor the clinic has, with the department they belong to and
 * whether they are bookable right now.
 *
 * Deactivated and soft-deleted doctors are deliberately included: they are the
 * evidence that lets the assistant say "Dr X is no longer seeing patients here"
 * instead of "I could not find that doctor". They are never returned as an
 * available choice — `availableDoctorsInDepartment` is the only list callers
 * offer.
 */
export async function loadDoctorDirectory(
  clinicId: string,
  options: { now?: Date } = {},
): Promise<DoctorDirectory> {
  const db = createClinicScopedAdminClient(clinicId);
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();

  const [departments, doctorsResult, leaveResult] = await Promise.all([
    loadClinicDepartments(clinicId),
    selectWithOptional<Record<string, unknown>[]>(
      ["id", "full_name", "department_id", "is_active", "is_deleted", "deleted_at"],
      STAFF_DISPLAY_COLUMNS,
      (columns) =>
        db
          .from("profiles")
          .select(columns)
          .eq("role", "doctor")
          .order("full_name")
          .limit(MAX_DOCTORS) as unknown as PromiseLike<{
          data: Record<string, unknown>[] | null;
          error: unknown;
        }>,
    ),
    // Only leave that is in force *now* proves a doctor is currently away. A
    // block that starts next month says nothing about today and must never be
    // reported to a patient as "on leave".
    db
      .from("doctor_unavailability")
      .select("doctor_id, ends_at")
      .eq("is_active", true)
      .lte("starts_at", nowIso)
      .gt("ends_at", nowIso)
      .limit(MAX_DOCTORS),
  ]);

  // Department names come from the same read, so a doctor in an inactive or
  // deleted department is still describable without a second query and without
  // that department becoming a bookable option.
  const departmentNames = new Map(departments.map((item) => [item.id, item.name]));

  const leaveEndsAt = new Map<string, string>();
  for (const row of leaveResult.data ?? []) {
    const current = leaveEndsAt.get(row.doctor_id);
    // The latest end wins, so a doctor covered by two overlapping blocks is
    // reported as away until the later of the two.
    if (!current || row.ends_at > current) leaveEndsAt.set(row.doctor_id, row.ends_at);
  }

  const doctors: DirectoryDoctor[] = (doctorsResult.data ?? []).map((row) => {
    const active =
      Boolean(row.is_active) && !row.is_deleted && (row.deleted_at ?? null) === null;
    const id = String(row.id);
    const departmentId = row.department_id === null || row.department_id === undefined
      ? null
      : String(row.department_id);
    const until = leaveEndsAt.get(id) ?? null;
    return {
      id,
      name: String(row.full_name),
      nameAr: displayText(row.display_name_ar),
      nameEn: displayText(row.display_name_en),
      departmentId,
      departmentName: departmentId
        ? (departmentNames.get(departmentId) ?? null)
        : null,
      state: !active ? "inactive" : until ? "on_leave" : "available",
      unavailableUntil: active && until ? until : null,
    };
  });

  return { departments, doctors };
}

/**
 * The clinic's live department names, and nothing else.
 *
 * P11C — the pre-model escalation classifier needs to know which words this
 * clinic uses to name the things it sells appointments in, and it needs that
 * before the agent, on every inbound message. `loadDoctorDirectory` would
 * answer the question but also reads every doctor and every leave block to do
 * it. This is the same `departments` predicate — active, not soft-deleted — and
 * one round trip.
 *
 * Returns `[]` on any failure. A missing vocabulary can only make the
 * classifier *more* eager, never less, so a failed read degrades to the
 * pre-P11C behaviour of the topic/ask split rather than to a wrong decision.
 */
export async function loadClinicDepartmentNames(clinicId: string): Promise<string[]> {
  try {
    return (await loadClinicDepartments(clinicId))
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string" && name.trim() !== "");
  } catch {
    return [];
  }
}

/**
 * Every bookable doctor of one department, in name order, de-duplicated by id.
 *
 * This is the *only* list a caller may present as available choices. A doctor
 * who is inactive, soft-deleted, currently on leave, or attached to another
 * department can never appear in it.
 */
export function availableDoctorsInDepartment(
  directory: DoctorDirectory,
  departmentId: string,
): DirectoryDoctor[] {
  const seen = new Set<string>();
  return directory.doctors.filter((doctor) => {
    if (doctor.departmentId !== departmentId) return false;
    if (doctor.state !== "available") return false;
    if (seen.has(doctor.id)) return false;
    seen.add(doctor.id);
    return true;
  });
}

/**
 * The public projection of a doctor. Internal state never leaves as an id.
 *
 * The clinic's own display names travel as `aliases`, so a doctor whose file
 * carries a Latin-script name and whose Arabic display name the clinic has
 * authored is reachable by either. They are alternative spellings of one
 * person, never a second candidate — see `NamedEntity.aliases`.
 */
export function toDoctorOption(doctor: DirectoryDoctor): NamedEntity {
  const aliases = [doctor.nameAr, doctor.nameEn].filter(
    (name): name is string => typeof name === "string" && name.trim().length > 0,
  );
  return {
    id: doctor.id,
    name: doctor.name,
    ...(aliases.length > 0 ? { aliases } : {}),
  };
}

/**
 * Resolves a doctor name the patient typed against the whole clinic, in the
 * context of the department they have already chosen.
 *
 * Order matters and is deliberate: a bookable doctor of the selected department
 * wins outright, because that is the answer the patient is most likely to mean.
 * Only when no such doctor matches does the search widen to the rest of the
 * clinic, and then the *reason* they are not bookable is what comes back.
 */
export function resolveDoctorName(
  query: string,
  directory: DoctorDirectory,
  departmentId: string | null,
): DoctorNameResolution {
  const trimmed = query.trim();
  if (!trimmed) return { status: "unknown" };

  const byId = new Map(directory.doctors.map((doctor) => [doctor.id, doctor]));
  const inDepartment = departmentId
    ? availableDoctorsInDepartment(directory, departmentId)
    : directory.doctors.filter((doctor) => doctor.state === "available");

  // Ordinals ("the second one", "الثاني") are only meaningful against the list
  // the patient was actually shown, which is the department's roster.
  const primary = resolveNamedEntity(trimmed, inDepartment.map(toDoctorOption));
  if (primary.status === "resolved") {
    const doctor = byId.get(primary.entity.id);
    if (doctor) return { status: "resolved", doctor };
  }
  if (primary.status === "ambiguous") {
    const candidates = primary.candidates
      .map((candidate) => byId.get(candidate.id))
      .filter((doctor): doctor is DirectoryDoctor => Boolean(doctor));
    if (candidates.length > 1) return { status: "ambiguous", candidates };
    if (candidates.length === 1) return { status: "resolved", doctor: candidates[0]! };
  }

  // Nobody bookable in this department matches. Widen to every doctor the
  // clinic has ever had, so a real person is explained rather than denied.
  const others = directory.doctors.filter(
    (doctor) => !inDepartment.some((item) => item.id === doctor.id),
  );
  const wide = resolveNamedEntity(trimmed, others.map(toDoctorOption));
  if (wide.status === "resolved") {
    const doctor = byId.get(wide.entity.id);
    if (!doctor) return { status: "unknown" };
    if (doctor.state === "inactive") return { status: "inactive", doctor };
    if (doctor.state === "on_leave") return { status: "on_leave", doctor };
    return { status: "other_department", doctor };
  }
  if (wide.status === "ambiguous") {
    const candidates = wide.candidates
      .map((candidate) => byId.get(candidate.id))
      .filter((doctor): doctor is DirectoryDoctor => Boolean(doctor));
    if (candidates.length > 1) return { status: "ambiguous", candidates };
    // P11 — a *single* weak match outside the chosen department is not
    // promoted to "you mean Dr X". Inside the department that collapse is
    // harmless: the roster is authoritative and the patient was shown it. Out
    // here it is the opposite — it takes a string the patient may not even have
    // meant as a name and puts a doctor from somewhere else in the clinic into
    // a tool result, which is one of the two ways a name nobody asked about
    // reached a patient. `unknown` costs one clarifying question instead.
  }
  return { status: "unknown" };
}

/**
 * The doctor payload every patient tool returns for one department.
 *
 * `doctors` is the complete list and `doctor_count` states its size, because
 * "here are the doctors" and "here is *a* doctor" were previously the same
 * message and the assistant kept picking one. `only_one_available` exists so the
 * single-doctor case is said out loud rather than looking like a truncated list.
 */
/**
 * The invariant, asserted rather than assumed.
 *
 * Everything a patient may be told about a department's doctors flows through
 * `departmentDoctorsPayload`, so this is the one place that has to hold: the
 * offered set is a subset of the doctors this clinic's own Staff records place
 * in that department, active, not deleted, and not on recorded leave right now.
 *
 * It is deliberately a throw and not a filter. A filter would quietly repair a
 * dropped `.eq("department_id", …)` or a lost `is_active` predicate and the
 * regression would ship looking healthy; a throw reaches
 * `protectPatientTool`, degrades to the clinic-phone fallback, and shows up in
 * Sentry. The mocked roster tests assert against this function precisely so
 * that removing a filter fails a test rather than passing a bigger list.
 */
export function assertRosterAuthority(
  directory: DoctorDirectory,
  departmentId: string,
  offered: readonly DirectoryDoctor[],
): void {
  const authoritative = new Set(
    availableDoctorsInDepartment(directory, departmentId).map((item) => item.id),
  );
  for (const doctor of offered) {
    if (!authoritative.has(doctor.id)) {
      throw new Error(
        "Patient-facing doctor roster contained a doctor outside the authoritative " +
          "department roster.",
      );
    }
  }
}

export function departmentDoctorsPayload(
  directory: DoctorDirectory,
  department: DirectoryDepartment,
  options: { excludeDoctorId?: string | null } = {},
) {
  const all = availableDoctorsInDepartment(directory, department.id);
  const doctors = options.excludeDoctorId
    ? all.filter((doctor) => doctor.id !== options.excludeDoctorId)
    : all;
  assertRosterAuthority(directory, department.id, doctors);
  return {
    department,
    doctors: doctors.map(toDoctorOption),
    doctor_count: doctors.length,
    only_one_available: doctors.length === 1,
  };
}
