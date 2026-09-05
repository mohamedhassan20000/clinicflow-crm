import type { UserRole } from "@/lib/rbac";
import type { AiCommercialFeature } from "@/lib/ai/commercial-policy";
import type { ResourceId } from "@/lib/ai/resources/types";

/**
 * Phase 7 — the migration manifest for the strangler cutover (§14).
 *
 * §14.2–3 required each narrow tool subsumed by the resource layer to be marked
 * deprecated, proven covered, and only then unmounted. This module is what
 * survives that sequence: rather than leaving dead registry entries behind, the
 * *claim* is kept as data and `tests/unit/ai/phase7-superset-coverage.test.ts`
 * re-derives it against the live registries on every run.
 *
 * That matters more than a changelog would. Each record states exactly which
 * resource, field, filter and relation now carries the removed tool's output, so
 * a later edit that drops `medical_notes.note` or narrows the appointments
 * resource's roles fails a test naming the capability it silently took away —
 * instead of being noticed when a user asks for something the assistant used to
 * answer.
 *
 * Pure data: no `server-only`, no runtime imports, so the manifest can be read
 * by tests and tooling without a database or a request context.
 */

/**
 * The date/time semantics a removed tool resolved **server-side**, and the
 * registered filter that now carries them (P7-02).
 *
 * Recorded as its own claim because filter-key parity is not semantic parity.
 * `list_appointments` accepted a named preset or a `YYYY-MM-DD` clinic calendar
 * date and resolved it to UTC bounds in the clinic's own timezone; a filter key
 * called `scheduled_at` that accepts only offset-bearing instants reproduces the
 * key and loses the capability. Asserting the accepted *forms* means a future
 * edit that narrows the filter back to instants fails naming the tool.
 */
export type SupersededDateSemantics = {
  /** The registered filter key that must carry the clinic-local forms. */
  filter: string;
  /**
   * Input forms the replacement filter must still accept, beyond an absolute
   * instant. Every one of these was expressible against the removed tool.
   */
  clinicLocalForms: readonly string[];
  /** The server-owned resolution path, named so a re-implementation is visible. */
  resolvedBy: string;
  /** Behaviour of the removed tool deliberately **not** carried across. */
  deviations?: readonly string[];
};

export type SupersededReplacement = {
  resource: ResourceId;
  /** Fields on the resource that carry the removed tool's output columns. */
  fields: readonly string[];
  /** Registered filter keys that reproduce the removed tool's inputs. */
  filters: readonly string[];
  /**
   * Relations that carry the removed tool's embedded selects, **with the fields
   * the tool actually projected through them** (P7-03).
   *
   * Naming only the relation was too weak to catch the regression the manifest
   * exists for: `list_appointments` returned `patient_file_number`,
   * `doctor_name` and `department_name`, so deleting `file_number` from the
   * appointments `patient` relation — or dropping it from that relation's
   * `defaultFields`, since the tool returned it without being asked — took away
   * a column while a name-only assertion stayed green.
   */
  relations?: Readonly<Record<string, readonly string[]>>;
  /** Clinic-local date semantics the replacement filter must preserve. */
  dateSemantics?: SupersededDateSemantics;
  /**
   * The roles for which this replacement must cover the removed tool.
   *
   * Usually every role the tool mounted for. It is narrower only where the tool
   * mounted for a role whose RLS returned nothing anyway — a manager calling
   * `get_patient_summary` got an empty `notes` array, because
   * `medical_notes_select_role_scoped` admits only admin, receptionist and
   * doctor. The test asserts that narrowing against the application role
   * constant, so "RLS returned nothing anyway" stays a checked claim rather than
   * a comment.
   */
  rolesCovered: readonly UserRole[];
  /** Why `rolesCovered` is narrower than the tool's mount, when it is. */
  narrowing?: string;
};

export type SupersededToolRecord = {
  name: string;
  /** The module deleted with the tool; the test asserts it no longer exists. */
  modulePath: string;
  roles: readonly UserRole[];
  requiredFeatures: readonly AiCommercialFeature[];
  replacements: readonly SupersededReplacement[];
  /** Generic tools that must be mounted for every role the removed tool served. */
  servedBy: readonly string[];
  rationale: string;
  /**
   * Recorded where the replacement resolves under a different plan feature key
   * than the removed tool did. Commercial, never a security difference: both
   * keys are seeded on the same plan row today, and §5 makes moving either one a
   * data change.
   */
  featureShift?: string;
};

/**
 * The clinic-local forms every superseded date input could express, and which
 * `lib/ai/resources/clinic-dates.ts` must still accept.
 *
 * `list_appointments` reached them through `resolveToolDateRange`'s preset enum;
 * `list_doctor_appointments` and `search_patient_visits` through an explicit
 * `YYYY-MM-DD` pair converted by `clinicDateRangeToUtc`. Either way the model
 * named a clinic day, never an instant and never an offset.
 */
const CLINIC_LOCAL_DATE_FORMS = [
  "YYYY-MM-DD",
  "today",
  "this_week",
  "this_month",
] as const;

/**
 * The one range behaviour deliberately not carried across, recorded here rather
 * than left implicit (P7-02).
 */
const RANGE_CLAMP_DEVIATION =
  "The MAX_RANGE_DAYS (400) clamp and its `clamped` notice are not reproduced. " +
  "They existed because the removed tools took a single range object that could " +
  "name all of history; the generic path takes independent bound filters, and row " +
  "exposure is bounded instead by the resource rowCap of 200 plus the ai.bulk_export " +
  "entitlement gate on page > 1. This is a recorded deviation, not an oversight.";

const APPOINTMENT_DATE_SEMANTICS: SupersededDateSemantics = {
  filter: "scheduled_at",
  clinicLocalForms: CLINIC_LOCAL_DATE_FORMS,
  resolvedBy:
    "lib/ai/resources/clinic-dates.ts → clinicDateRangeToUtc with the timezone read " +
    "from the authenticated clinic by resolveClinicTimeZone; the model supplies no " +
    "offset and no anchor date.",
  deviations: [RANGE_CLAMP_DEVIATION],
};

export const SUPERSEDED_AI_TOOLS: readonly SupersededToolRecord[] = [
  {
    name: "get_patient_summary",
    modulePath: "lib/ai/tools/get-patient-summary.ts",
    roles: ["admin", "manager", "receptionist", "doctor", "assistant"],
    requiredFeatures: ["ai_assistant", "ai.read_clinical"],
    servedBy: ["get_record", "query_resource"],
    replacements: [
      {
        resource: "patients",
        // The tool redacted the patient row to age/gender; the resource returns
        // date_of_birth and blood_type outright, so coverage is strict superset.
        fields: ["id", "full_name", "date_of_birth", "blood_type"],
        filters: ["id"],
        rolesCovered: ["admin", "manager", "receptionist", "doctor", "assistant"],
      },
      {
        resource: "appointments",
        fields: ["id", "scheduled_at", "status", "duration_minutes"],
        filters: ["patient_id"],
        rolesCovered: ["admin", "manager", "receptionist", "doctor", "assistant"],
      },
      {
        resource: "medical_notes",
        fields: ["id", "note", "doctor_id", "created_at"],
        filters: ["patient_id"],
        rolesCovered: ["admin", "receptionist", "doctor"],
        narrowing:
          "medical_notes_select_role_scoped admits only these roles, so manager and assistant received an empty notes array from the removed tool too.",
      },
      {
        resource: "follow_ups",
        fields: ["id", "outcome", "recorded_at"],
        filters: ["patient_id"],
        rolesCovered: ["admin", "manager", "receptionist", "doctor", "assistant"],
      },
      {
        resource: "patient_packages",
        fields: ["id", "name", "total_sessions", "used_sessions", "is_active"],
        filters: ["patient_id", "is_active"],
        rolesCovered: ["admin", "manager", "receptionist", "doctor", "assistant"],
      },
    ],
    rationale:
      "A fixed five-table join over one patient. Every table is a declared resource and every returned column is a declared field, so the composition is now the model's to make across steps the Phase 4 budget affords.",
    featureShift:
      "The patient row, appointments and follow-ups resolve under ai.read_operational; notes and packages keep ai.read_clinical.",
  },
  {
    name: "search_patient_visits",
    modulePath: "lib/ai/tools/search-patient-visits.ts",
    roles: ["admin", "manager", "receptionist", "doctor", "assistant"],
    requiredFeatures: ["ai_assistant", "ai.read_clinical"],
    servedBy: ["query_resource"],
    replacements: [
      {
        resource: "medical_notes",
        fields: ["id", "note", "doctor_id", "created_at"],
        // The `note` ilike filter was added in Phase 7 for exactly this parity:
        // the removed tool matched note text with a server-escaped ilike.
        filters: ["patient_id", "note", "created_at"],
        rolesCovered: ["admin", "receptionist", "doctor"],
        narrowing:
          "Same RLS role set as above; the removed tool returned no notes to manager or assistant either.",
        dateSemantics: {
          filter: "created_at",
          clinicLocalForms: CLINIC_LOCAL_DATE_FORMS,
          resolvedBy:
            "lib/ai/resources/clinic-dates.ts → clinicDateRangeToUtc, the exact " +
            "function search_patient_visits called on its from/to pair.",
          deviations: [RANGE_CLAMP_DEVIATION],
        },
      },
      {
        resource: "appointments",
        fields: ["id", "scheduled_at", "status"],
        filters: ["patient_id", "scheduled_at"],
        rolesCovered: ["admin", "manager", "receptionist", "doctor", "assistant"],
        dateSemantics: APPOINTMENT_DATE_SEMANTICS,
      },
    ],
    rationale:
      "Text search over one patient's notes plus their appointments in a window. Both are registered filters; the compiler owns the wildcard shape and escapes LIKE metacharacters, which the removed tool did by hand.",
  },
  {
    name: "list_doctor_appointments",
    modulePath: "lib/ai/tools/list-doctor-appointments.ts",
    roles: ["doctor", "assistant"],
    requiredFeatures: ["ai_assistant", "ai.read_clinical"],
    servedBy: ["query_resource"],
    replacements: [
      {
        resource: "appointments",
        fields: ["id", "scheduled_at", "status", "duration_minutes"],
        filters: ["scheduled_at", "doctor_id"],
        // The tool selected `patients(full_name)` alongside the appointment row.
        relations: { patient: ["full_name"] },
        rolesCovered: ["doctor", "assistant"],
        dateSemantics: APPOINTMENT_DATE_SEMANTICS,
      },
    ],
    rationale:
      "The tool re-implemented row scope in TypeScript — .eq(doctor_id, self) for doctors, an auth_supervised_doctor_ids() IN-list for assistants. appointments_select_role_scoped already applies both, so the replacement narrows identically without a second copy of the rule.",
    featureShift:
      "Resolves under ai.read_operational rather than ai.read_clinical; an appointment schedule is not clinical narrative.",
  },
  {
    name: "list_appointments",
    modulePath: "lib/ai/tools/list-appointments.ts",
    roles: ["admin", "manager", "receptionist"],
    requiredFeatures: ["ai_assistant", "ai.staff_analytics"],
    servedBy: ["query_resource"],
    replacements: [
      {
        resource: "appointments",
        fields: ["id", "scheduled_at", "status", "duration_minutes"],
        filters: ["scheduled_at", "status", "doctor", "department"],
        // The tool selected
        //   patients(full_name, file_number), profiles!doctor_id(full_name),
        //   departments(name)
        // and returned every one of those columns unasked, so each must also be
        // in its relation's defaultFields.
        relations: {
          patient: ["full_name", "file_number"],
          doctor: ["full_name"],
          department: ["name"],
        },
        rolesCovered: ["admin", "manager", "receptionist"],
        dateSemantics: APPOINTMENT_DATE_SEMANTICS,
      },
    ],
    rationale:
      "A date-range list with status/doctor/department filters and a 50-row cap. The resource declares the same filters (with the same ranked entity resolution and the same ambiguity clarification), a 200-row cap, an exact total, and truthful truncation.",
    featureShift:
      "Resolves under ai.read_operational rather than ai.staff_analytics; the analytics key now gates only the aggregate RPC tools it was written for.",
  },
];

/**
 * Tools kept deliberately, with the reason each is not a resource read.
 *
 * §6.3 named six; the analytics and financial families are the rest, and their
 * reason is the same in every case — they are database-side computations, not
 * projections of a table. `get_patient_stats` carries the k-anonymity suppression
 * §7.4 explicitly preserves for grouped patient-attribute distributions;
 * `list_pending_followups` derives a worklist of appointments that have *no*
 * follow-up row, which no filter over `follow_ups` can express.
 *
 * The coverage test asserts this list plus the generic tools plus the superseded
 * list account for the registry exactly, so a future tool cannot be added
 * without a decision about which of the three it is.
 */
export const RETAINED_PURPOSE_BUILT_TOOLS: readonly {
  name: string;
  reason: string;
}[] = [
  {
    name: "search_authorized_patients",
    reason: "Ranked trigram entity resolution with confidence classification.",
  },
  {
    name: "check_availability",
    reason: "Scheduling computation over working hours, schedules and bookings.",
  },
  {
    name: "run_clinic_report",
    reason: "Eight curated report RPCs with their own permission catalog.",
  },
  { name: "search_help", reason: "Product help corpus; reads no clinic data." },
  { name: "get_navigation_target", reason: "Product navigation map; reads no clinic data." },
  { name: "list_my_capabilities", reason: "Capability transparency over this registry itself." },
  {
    name: "get_clinic_summary",
    reason: "Multi-table operational overview RPC with a guarded analytics caller.",
  },
  {
    name: "get_patient_stats",
    reason:
      "Grouped patient-attribute distribution with database-side k-anonymity suppression, retained by §7.4.",
  },
  {
    name: "get_appointment_stats",
    reason: "No-show and cancellation rates computed in the database, not row projections.",
  },
  {
    name: "count_new_patients",
    reason: "Period-over-period comparison, not a filtered list.",
  },
  {
    name: "list_pending_followups",
    reason:
      "get_followups_dashboard derives appointments still awaiting a follow-up — an anti-join no filter over the follow_ups resource can express.",
  },
  {
    name: "get_revenue_summary",
    reason: "Financial aggregation RPC behind the per-user financial grant.",
  },
  {
    name: "compare_revenue_periods",
    reason: "Two-period financial comparison computed in the database.",
  },
  {
    name: "list_outstanding_invoices",
    reason: "Aging computation over invoices; no invoices resource is declared.",
  },
];

/** The generic tools the new architecture is built on (§6.1). */
export const GENERIC_CAPABILITY_TOOLS: readonly string[] = [
  "query_resource",
  "get_record",
  "aggregate_resource",
  "describe_capabilities",
  "execute_action",
  "describe_action",
  "describe_documents",
  "preview_document",
];
