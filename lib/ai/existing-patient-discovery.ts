/**
 * Item #3 — what a booking does once it finds out the beneficiary already has
 * a file here.
 *
 * ## Why this is its own pure module
 *
 * The identity *rule* — exact folded national/civil id within one clinic,
 * confirmed by an exactly folded name, ambiguity failing closed — belongs in
 * the database, next to the data it decides about, and lives in
 * `find_clinic_patient_by_identity`. What is left is a shaping decision with no
 * I/O in it at all: given the relationships that came back, is this a patient
 * with one clinical home or several, and who treats them there. That decision
 * is the one the reply depends on, it has several branches, and it is far
 * easier to be sure about as a pure function than as a paragraph inside a tool.
 *
 * ## What it may and may not carry
 *
 * The output names a patient, their departments and their doctors, and nothing
 * else. No phone, no email, no id, no file number, no appointment content, and
 * nothing about any other patient — the caller is about to put this in front of
 * whoever is holding the phone, who may not be the beneficiary.
 *
 * Nothing here can match anybody. It is handed rows that the database already
 * decided are one specific person, and a `none` for an empty list is the only
 * "identification" it performs.
 */

/** One row of `find_clinic_patient_by_identity`. */
export type PatientRelationshipRow = {
  patient_id: string;
  full_name: string;
  department_id: string;
  department_name: string;
  doctor_id: string | null;
  doctor_name: string | null;
  /** The relationship recorded on the patient's own file, as staff set it. */
  is_primary: boolean;
};

export type DiscoveredDoctor = { id: string; name: string };
export type DiscoveredDepartment = { id: string; name: string };

export type ExistingPatientDiscovery =
  /** This clinic has no file that this identity proves. Continue as new. */
  | { kind: "none" }
  /**
   * One clinical home. The booking may offer to continue in it, with the
   * doctor who treats them there when there still is one.
   */
  | {
      kind: "single_department";
      patientId: string;
      patientName: string;
      department: DiscoveredDepartment;
      treatingDoctor: DiscoveredDoctor | null;
      departments: readonly DiscoveredDepartment[];
    }
  /**
   * Several legitimate homes. Which one is a question for the patient, never a
   * guess: booking a cardiology follow-up into dermatology because it happened
   * to be first is worse than asking.
   */
  | {
      kind: "multiple_departments";
      patientId: string;
      patientName: string;
      departments: readonly DiscoveredDepartment[];
      /** The treating doctor per department, where one is still bookable. */
      treatingDoctorByDepartment: Record<string, DiscoveredDoctor>;
    };

/**
 * Shapes the lookup's rows into the decision the booking flow needs.
 *
 * Row order is the database's: the primary relationship first, then most
 * recently seen. That order is preserved into `departments`, so "your usual
 * one" is the one offered first, and it is preserved deterministically rather
 * than re-sorted here — two orderings of the same fact is one too many.
 */
export function discoveryFromRelationships(
  rows: readonly PatientRelationshipRow[],
): ExistingPatientDiscovery {
  if (rows.length === 0) return { kind: "none" };
  const first = rows[0]!;

  const departments: DiscoveredDepartment[] = [];
  const seen = new Set<string>();
  const treatingDoctorByDepartment: Record<string, DiscoveredDoctor> = {};
  const primaryDepartments = new Set<string>();
  for (const row of rows) {
    if (!seen.has(row.department_id)) {
      seen.add(row.department_id);
      departments.push({ id: row.department_id, name: row.department_name });
    }
    // A department whose doctor has left keeps no entry at all, rather than an
    // unbookable name: "shall we book you with your usual doctor?" is not a
    // question worth asking about somebody who cannot be booked.
    if (!row.doctor_id || !row.doctor_name) continue;
    const held = treatingDoctorByDepartment[row.department_id];
    // The doctor recorded on the patient's own file outranks whoever they
    // happened to be seen by once, whichever order the rows arrive in. The
    // database already sorts them primary-first; not depending on that is what
    // keeps this a decision about the data rather than about the query plan.
    const outranksHeld = !held || (row.is_primary && !primaryDepartments.has(row.department_id));
    if (!outranksHeld) continue;
    treatingDoctorByDepartment[row.department_id] = {
      id: row.doctor_id,
      name: row.doctor_name,
    };
    if (row.is_primary) primaryDepartments.add(row.department_id);
  }

  if (departments.length === 1) {
    const department = departments[0]!;
    return {
      kind: "single_department",
      patientId: first.patient_id,
      patientName: first.full_name,
      department,
      treatingDoctor: treatingDoctorByDepartment[department.id] ?? null,
      departments,
    };
  }
  return {
    kind: "multiple_departments",
    patientId: first.patient_id,
    patientName: first.full_name,
    departments,
    treatingDoctorByDepartment,
  };
}

/**
 * The lookup, plus the shaping, as one call.
 *
 * Kept beside the pure function rather than in the tool so that "how the
 * beneficiary is found" has exactly one implementation. A failed read is `none`
 * — the caller then proceeds down the ordinary new-file path, which is the safe
 * direction: the worst case is the duplicate this whole item exists to avoid,
 * and staff review catches that, whereas guessing a match on an error would
 * attach an appointment to somebody on no evidence at all.
 */
export async function findExistingBeneficiary(input: {
  clinicId: string;
  nationalId: string;
  fullName: string;
}): Promise<ExistingPatientDiscovery> {
  try {
    const { findClinicPatientByIdentity } = await import("@/lib/supabase/admin");
    const result = await findClinicPatientByIdentity(input);
    if (result.error) return { kind: "none" };
    return discoveryFromRelationships(
      (result.data ?? []) as PatientRelationshipRow[],
    );
  } catch {
    return { kind: "none" };
  }
}

/**
 * The part of a discovery a reply may repeat back, and nothing else.
 *
 * Whoever is holding the phone is not necessarily the beneficiary, so what
 * leaves this boundary is the smallest thing that lets the booking continue:
 * where they are known here, and who treats them there. No contact detail, no
 * history, no file number, no id.
 */
export function describeExistingBeneficiary(
  discovery: ExistingPatientDiscovery,
): Record<string, unknown> {
  if (discovery.kind === "none") return {};
  if (discovery.kind === "single_department") {
    return {
      departments: [discovery.department],
      department: discovery.department,
      ...(discovery.treatingDoctor
        ? { treating_doctor: discovery.treatingDoctor }
        : {}),
      needs_selection: false as const,
    };
  }
  return {
    departments: discovery.departments,
    treating_doctor_by_department: discovery.treatingDoctorByDepartment,
    needs_selection: true as const,
    field: "department" as const,
  };
}
