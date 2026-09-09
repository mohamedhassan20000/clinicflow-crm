/**
 * The authoritative tool layer, with preconditions the model cannot influence.
 *
 * ## What changed and what did not
 *
 * Every function here delegates to logic that already existed and is already
 * correct: `getPatientAvailableDays`, `createPatientPendingBooking`,
 * `findClinicPatientByIdentity`, `stagePatientIntakeFromConversation`,
 * `loadDoctorDirectory` and the rest. The domain has not been rewritten and
 * neither have the RPCs behind it. Their ownership checks, identity checks,
 * RLS and audit lines are untouched.
 *
 * What is new is **who may call them and when**. In the old engine these were
 * `tool()` objects mounted into a model's context; the model chose one and the
 * choice was the mutation. Here they are plain functions invoked by a flow step
 * that the deterministic engine has already decided to run, after the engine
 * has already checked the step's declared preconditions against committed slots
 * and proven identity (I-4, I-7).
 *
 * ## The precondition contract
 *
 * Preconditions live on the *step* ({@link StepPrecondition}), not in here, so
 * they are data the engine enforces uniformly rather than a check each function
 * remembers to perform. This file's job is to be a faithful, side-effect-honest
 * adapter: a `read*` function never writes, and the two functions that do write
 * say so in their names and are reachable from exactly one step each.
 *
 * `list_available_days` is the worked example from the brief. It is reachable
 * only from `book_appointment`'s day step, whose precondition is
 * `slots: ["department", "doctor"]` — committed slots on a live frame. A doctor
 * sitting in the patient's appointment history satisfies neither, and there is
 * no other caller.
 */

import "server-only";

import { fromZonedTime } from "date-fns-tz";
import { addCalendarDays } from "@/lib/appointments/calendar";
import {
  availableDoctorsInDepartment,
  loadClinicDepartments,
  loadDoctorDirectory,
  resolveDoctorName,
  type DirectoryDoctor,
} from "@/lib/ai/doctor-directory";
import {
  getPatientAvailableDays,
  getPatientAvailableSlots,
  createPatientPendingBooking,
} from "@/lib/booking/patient";
import {
  bookableWindowStart,
  isOnlineBookableDate,
} from "@/lib/booking/lead-time";
import {
  authorizePatientConversation,
  type ResolvedPatientAiContext,
} from "@/lib/ai/patient-authorization";
import {
  cancelPatientAiAppointment,
  createPatientPreliminaryBookingWithPackage,
  findClinicPatientByIdentity,
  listPatientAiDocuments,
  listPatientAiPackages,
  signClinicDocumentUrl,
  getPatientClinicPublicInfo,
  getClinicCurrency,
  createClinicScopedAdminClient,
  listPatientAiAppointments,
  preparePatientAiReschedule,
  reschedulePatientAiAppointment,
  searchPatientClinicFaq,
  stagePatientIntakeFromConversation,
} from "@/lib/supabase/admin";
import { discoveryFromRelationships } from "@/lib/ai/existing-patient-discovery";
import { resolveNamedEntity } from "@/lib/ai/entity-resolution";
// Pure: the catalog shapes and the two name matchers. Re-exported below so
// callers keep one import, and imported directly by `flows.ts` so a test that
// stubs this module does not stub the matching away with it.
import type {
  InsuranceProvider,
  PackageEntry,
  PackageItemEntry,
  PackageGroup,
} from "@/lib/ai/v2/catalog";
import type { Candidate } from "@/lib/ai/v2/flow-state";
import type { TurnContext } from "@/lib/ai/v2/context";
import {
  doctorDisplayName,
  formatOfferedDay,
  formatOfferedTime,
  localizedName,
} from "@/lib/ai/v2/present";
import {
  INSURANCE_DISPLAY_COLUMNS,
  PACKAGE_DISPLAY_COLUMNS,
  SERVICE_DISPLAY_COLUMNS,
  displayText,
  PATIENT_DISPLAY_COLUMNS,
  selectWithOptional,
} from "@/lib/settings/display-names";

/** How many days of calendar one availability read covers. Unchanged from P9B. */
const AVAILABILITY_WINDOW_DAYS = 7;

/**
 * The legacy identity resolver, reused verbatim.
 *
 * Every read below needs the same thing the old tools needed — the clinic, the
 * timezone, the linkage — and `authorizePatientConversation` is the one place
 * that resolves it from the conversation rather than from an argument. Reusing
 * it keeps a single answer to "who is this thread?" across both engines.
 */
async function identityFor(context: TurnContext): Promise<ResolvedPatientAiContext> {
  return authorizePatientConversation({
    clinicId: context.clinicId,
    conversationId: context.conversationId,
    locale: context.turn.locale,
  });
}

// ---------------------------------------------------------------------------
// Clinic-public reads. No identity, no patient, no flow requirement.
// ---------------------------------------------------------------------------

/**
 * Every clinic-authored name for one entity, for matching.
 *
 * Deliberately includes the canonical stored name as well as both display
 * names: which of the three became the visible `label` depends on the
 * conversation's language, and all three should still resolve.
 */
function displayAliases(entity: {
  name: string;
  nameAr?: string | null;
  nameEn?: string | null;
}): readonly string[] {
  return [entity.name, entity.nameAr, entity.nameEn].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

export async function readDepartments(
  context: TurnContext,
): Promise<readonly Candidate<string>[]> {
  const departments = await loadClinicDepartments(context.clinicId);
  // The label is what the patient reads, so it is localized here — at the one
  // place a department becomes an option — rather than at each of the four
  // steps that offer one. `localizedName` returns the canonical stored name
  // when the clinic has authored no display name for this language, which is
  // the honest rendering and never a generated one.
  //
  // The names *not* shown travel as aliases: the department stays reachable by
  // its English name in an Arabic conversation and vice versa.
  return departments.map((department) => ({
    value: department.id,
    label: localizedName(department, context.turn.locale),
    aliases: displayAliases(department),
    source: "clinic_directory" as const,
  }));
}

export async function readDoctors(input: {
  context: TurnContext;
  departmentId: string;
  /** Values the patient has ruled out. The negative constraint, applied. */
  excluding?: readonly string[];
}): Promise<readonly Candidate<string>[]> {
  const directory = await loadDoctorDirectory(input.context.clinicId);
  const excluded = new Set(input.excluding ?? []);
  return availableDoctorsInDepartment(directory, input.departmentId)
    .filter((doctor) => !excluded.has(doctor.id))
    .map((doctor) => ({
      value: doctor.id,
      label: doctorDisplayName(doctor, input.context.turn.locale),
      aliases: displayAliases(doctor),
      source: "clinic_directory" as const,
    }));
}

/**
 * Grounds a spoken doctor name against the roster.
 *
 * Delegates to `resolveDoctorName`, the existing resolver, so "دكتور احم"
 * produces the same two-candidate ambiguity it always did — but the *answer* to
 * that ambiguity is now a server-owned offer rather than the model's judgement.
 */
export async function resolveDoctorSpoken(input: {
  context: TurnContext;
  spoken: string;
  departmentId: string | null;
  excluding?: readonly string[];
}): Promise<
  | { kind: "resolved"; value: string; label: string }
  | { kind: "ambiguous"; options: readonly { value: string; label: string; source: "clinic_directory" }[] }
  | { kind: "unresolved" }
> {
  const directory = await loadDoctorDirectory(input.context.clinicId);
  const excluded = new Set(input.excluding ?? []);
  const resolution = resolveDoctorName(
    input.spoken,
    directory,
    input.departmentId,
  );
  if (resolution.status === "resolved" && !excluded.has(resolution.doctor.id)) {
    return {
      kind: "resolved",
      value: resolution.doctor.id,
      label: doctorDisplayName(resolution.doctor, input.context.turn.locale),
    };
  }
  if (resolution.status === "ambiguous") {
    const options = resolution.candidates
      .filter((doctor: DirectoryDoctor) => !excluded.has(doctor.id))
      .map((doctor: DirectoryDoctor) => ({
        value: doctor.id,
        label: doctorDisplayName(doctor, input.context.turn.locale),
        source: "clinic_directory" as const,
      }));
    if (options.length === 1) {
      return { kind: "resolved", value: options[0]!.value, label: options[0]!.label };
    }
    if (options.length === 0) return { kind: "unresolved" };
    return { kind: "ambiguous", options };
  }
  return { kind: "unresolved" };
}

export async function readClinicInfo(context: TurnContext) {
  const result = await getPatientClinicPublicInfo(context.clinicId);
  return result.data;
}

/**
 * The score below which a clinic-authored FAQ row is not an answer.
 *
 * The same 0.18 `answer_clinic_faq` uses (`lib/ai/tools/answer-clinic-faq.ts`).
 * Stated here rather than imported so the V2 read does not depend on a legacy
 * tool object, but deliberately the same number: a clinic that tuned its FAQ
 * text against one engine must not find it matching differently under the
 * other.
 */
const FAQ_MATCH_THRESHOLD = 0.18;

export async function readClinicFaq(input: {
  context: TurnContext;
  question: string;
}) {
  const result = await searchPatientClinicFaq({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    question: input.question,
    language: input.context.turn.locale,
  });
  if (result.error) return [];
  return (result.data ?? []).filter(
    (row) => Number(row.score ?? 0) >= FAQ_MATCH_THRESHOLD,
  );
}

/**
 * The insurers this clinic actually accepts, by name.
 *
 * The V2 counterpart of `list_clinic_insurance`, which had no counterpart at
 * all: `insurance` is a valid `QUESTION_TOPIC`, the interpreter is prompted to
 * emit it, and the flow's `default:` branch answered it from the *clinic
 * contact row* — so a clinic with eight insurers configured in Settings
 * answered an insurance question with its own address, and then, because
 * `info.insurance` had no copy, with nothing at all.
 *
 * Read live from `insurance_providers`, active and not soft-deleted, so adding
 * or deactivating an insurer changes the answer immediately. Names only: no
 * coverage percentages, no co-payments, no contract terms. A patient asking
 * "do you take X?" is asking whether to come, and the rest belongs to a staff
 * conversation.
 *
 * An empty list is an answer, not a failure, and the caller says so plainly
 * rather than hedging.
 */
const MAX_INSURANCE_PROVIDERS = 60;

export async function readClinicInsurance(
  context: TurnContext,
): Promise<readonly InsuranceProvider[]> {
  const db = createClinicScopedAdminClient(context.clinicId);
  // `selectWithOptional` for the same reason every other localized read uses
  // it: the bilingual columns are additive and applied on the clinic's own
  // schedule, and an insurance question must not stop being answerable because
  // a migration has not run yet.
  const result = await selectWithOptional<Record<string, unknown>[]>(
    ["id", "name"],
    INSURANCE_DISPLAY_COLUMNS,
    (columns) =>
      db
        .from("insurance_providers")
        .select(columns)
        .eq("is_active", true)
        .is("deleted_at", null)
        .order("name")
        .limit(MAX_INSURANCE_PROVIDERS) as unknown as PromiseLike<{
        data: Record<string, unknown>[] | null;
        error: unknown;
      }>,
  );
  if (result.error || !Array.isArray(result.data)) return [];
  const locale = context.turn.locale;
  return result.data
    .map((row) => {
      const entity = {
        name: String(row.name ?? "").trim(),
        nameAr: displayText(row.name_ar),
        nameEn: displayText(row.name_en),
      };
      return {
        id: String(row.id),
        label: localizedName(entity, locale),
        aliases: displayAliases(entity),
      };
    })
    .filter((provider) => provider.label.length > 0);
}

/**
 * The clinic's package catalog, grouped under department headings.
 *
 * ## Why this reads the table rather than the RPC
 *
 * `list_clinic_public_packages` returns exactly seven columns and none of them
 * is a display name, so a localized answer through it would have to invent one.
 * Rather than change an applied RPC's signature, this reads
 * `package_templates` directly under **the same visibility rule the RPC
 * applies** — an active template whose department is also active, scoped to
 * this clinic — through `createClinicScopedAdminClient`, which is the same
 * clinic-bounded client every other patient-facing catalog read uses. The RPC
 * is untouched and every existing caller of it keeps its exact result.
 *
 * ## Grouping is a property of the read, for the reason services' grouping is
 *
 * "What packages do you have?" is one question with a dozen answers, and a flat
 * list of them on WhatsApp gives a patient no way to tell which package belongs
 * to which department. `package_templates.department_id` is NOT NULL, so every
 * package has a heading to sit under and the grouping is total.
 *
 * Nothing here formats a price, infers a package's contents from its name, or
 * completes an absent number. A template with no configured price is returned
 * with `null` prices and the renderer omits them.
 */
export async function readPublicPackages(input: {
  context: TurnContext;
  departmentId?: string | null;
}): Promise<{
  readonly groups: readonly PackageGroup[];
  readonly all: readonly PackageEntry[];
  readonly currency: string | null;
  readonly total: number;
}> {
  const db = createClinicScopedAdminClient(input.context.clinicId);
  const [departments, result, itemRows, serviceCatalog, currency] = await Promise.all([
    loadClinicDepartments(input.context.clinicId),
    selectWithOptional<Record<string, unknown>[]>(
      ["id", "name", "department_id", "total_sessions", "price_per_session", "total_price", "notes"],
      PACKAGE_DISPLAY_COLUMNS,
      (columns) =>
        (input.departmentId
          ? db
              .from("package_templates")
              .select(columns)
              .eq("department_id", input.departmentId)
          : db.from("package_templates").select(columns)
        )
          .eq("is_active", true)
          .order("name") as unknown as PromiseLike<{
          data: Record<string, unknown>[] | null;
          error: unknown;
        }>,
    ),
    // Every package's service lines, read once for the whole catalog. The
    // table is additive and applied on the clinic's own schedule, so an error
    // here means the same thing an empty result means — no package has lines —
    // and the catalog answers exactly as it does today rather than failing.
    db
      .from("package_template_items")
      .select("package_template_id, service_id, sessions, price_per_session, sort_order")
      .order("sort_order")
      .then(
        (read) => (read.error ? [] : (read.data ?? [])),
        () => [],
      ),
    // The service catalog, for each line's localized name and the service's
    // own current price. A package never takes a *price* from here: the line
    // carries the clinic's agreed package price, and the catalogue price rides
    // along only to be shown beside it.
    readServices({ context: input.context }).catch(() => null),
    getClinicCurrency(input.context.clinicId).catch(() => null),
  ]);
  if (result.error || !Array.isArray(result.data)) {
    return { groups: [], all: [], currency: null, total: 0 };
  }
  const servicesById = new Map(
    (serviceCatalog?.groups ?? []).flatMap((group) =>
      group.services.map((service) => [service.id, service] as const),
    ),
  );
  const locale = input.context.turn.locale;
  // Lines grouped by their package, in `sort_order`. A line naming a service
  // this clinic no longer lists as active is dropped rather than quoted: the
  // package's own stored price for it is still real, but the service is not
  // something the clinic currently sells and a patient must not be offered it.
  const itemsByTemplate = new Map<string, PackageItemEntry[]>();
  for (const row of itemRows as Record<string, unknown>[]) {
    const service = servicesById.get(String(row.service_id ?? ""));
    if (!service) continue;
    const sessions = Number(row.sessions ?? 0);
    const pricePerSession = Number(row.price_per_session ?? 0);
    if (!Number.isFinite(sessions) || sessions <= 0) continue;
    if (!Number.isFinite(pricePerSession) || pricePerSession < 0) continue;
    const templateId = String(row.package_template_id ?? "");
    const existing = itemsByTemplate.get(templateId) ?? [];
    existing.push({
      serviceId: service.id,
      serviceName: service.name,
      sessions,
      pricePerSession,
      subtotal: Math.round(sessions * pricePerSession * 100) / 100,
      serviceRegularPrice: service.price ?? null,
    });
    itemsByTemplate.set(templateId, existing);
  }
  // The department directory is the visibility filter *and* the heading source:
  // `loadClinicDepartments` returns this clinic's active departments, so a
  // template whose department has been deactivated is dropped here — which is
  // the `and d.is_active` clause of the RPC, applied in the same read that
  // supplies the localized heading.
  const byId = new Map(departments.map((entry) => [entry.id, entry]));
  const grouped = new Map<string, PackageEntry[]>();
  const all: PackageEntry[] = [];
  for (const row of result.data) {
    const departmentId = String(row.department_id ?? "");
    const department = byId.get(departmentId);
    if (!department) continue;
    const departmentName = localizedName(department, locale);
    const entity = {
      name: String(row.name ?? "").trim(),
      nameAr: displayText(row.name_ar),
      nameEn: displayText(row.name_en),
    };
    if (!entity.name) continue;
    const entry: PackageEntry = {
      id: String(row.id),
      name: localizedName(entity, locale),
      aliases: displayAliases(entity),
      departmentId,
      departmentName,
      totalSessions: Number(row.total_sessions ?? 0),
      pricePerSession:
        row.price_per_session === null || row.price_per_session === undefined
          ? null
          : Number(row.price_per_session),
      totalPrice:
        row.total_price === null || row.total_price === undefined
          ? null
          : Number(row.total_price),
      // Zero lines is a department-only package and renders exactly as it does
      // today. One line is a single-service package. Several is a basket.
      items: itemsByTemplate.get(String(row.id)) ?? [],
      notes: displayText(row.notes),
    };
    grouped.set(departmentId, [...(grouped.get(departmentId) ?? []), entry]);
    all.push(entry);
  }
  // Department order comes from the clinic's own directory, so the grouping a
  // patient reads matches the list they were offered when they chose one.
  const groups: PackageGroup[] = [];
  for (const department of departments) {
    const packages = grouped.get(department.id);
    if (!packages || packages.length === 0) continue;
    groups.push({
      departmentId: department.id,
      departmentName: localizedName(department, locale),
      packages,
    });
  }
  return { groups, all, currency, total: all.length };
}

/**
 * The clinic's configured services and their prices — the authoritative catalog.
 *
 * The reason this exists: the `services` and `prices` topics answered from the
 * *department list* and nothing else, so the only thing in front of the model
 * when a patient asked what physiotherapy costs was a list of department names.
 * A service name and a price then had to come from somewhere, and the only
 * somewhere left was the model. Every row below is read live from
 * `services` — active, not deleted, scoped to this clinic — and the price is
 * the stored number beside the clinic's stored currency code. Nothing is
 * formatted, rounded, converted or completed here, and an empty result stays
 * empty: "we have none configured" is an answer, and inventing one is not.
 */
/**
 * The clinic's service catalog, grouped by the department that owns it.
 *
 * ## Why grouping is a property of the read
 *
 * "What services do you offer and what do they cost?" is one question with a
 * dozen answers, and manual QA showed what a flat list of them looks like on
 * WhatsApp: twelve service names and twelve prices in one run, with no way to
 * tell which price belongs to which department, and nothing to reply to. The
 * department is not decoration — it is the axis a patient actually navigates
 * ("ok, cardiology then") — so the catalog is returned already grouped rather
 * than flat with a department name repeated on every line.
 *
 * Doing it here rather than in the composer follows the rule the rest of this
 * layer follows: the composer fills placeholders and must never have to know
 * the shape of a domain row. It also means the *ordering* — departments in the
 * clinic's own order, services alphabetically within each — is decided once, by
 * the code that holds both lists.
 *
 * Only active, non-deleted services, only configured prices, and only names a
 * person at the clinic authored: `localizedName` picks the Arabic or English
 * display name when the clinic has typed one and returns the canonical stored
 * name otherwise. Nothing here translates anything.
 */
export type ServiceGroup = {
  readonly departmentId: string;
  readonly departmentName: string;
  readonly services: readonly {
    readonly id: string;
    readonly name: string;
    readonly price: number | null;
  }[];
};

export async function readServices(input: {
  context: TurnContext;
  departmentId?: string | null;
}): Promise<{
  readonly groups: readonly ServiceGroup[];
  readonly currency: string | null;
  /** Every service across every group. The count, not a presentation. */
  readonly total: number;
}> {
  const db = createClinicScopedAdminClient(input.context.clinicId);
  const [departments, result, currency] = await Promise.all([
    loadClinicDepartments(input.context.clinicId),
    selectWithOptional<Record<string, unknown>[]>(
      ["id", "name", "price", "department_id"],
      SERVICE_DISPLAY_COLUMNS,
      (columns) =>
        (input.departmentId
          ? db.from("services").select(columns).eq("department_id", input.departmentId)
          : db.from("services").select(columns)
        )
          .eq("is_active", true)
          .is("deleted_at", null)
          .order("name") as unknown as PromiseLike<{
          data: Record<string, unknown>[] | null;
          error: unknown;
        }>,
    ),
    getClinicCurrency(input.context.clinicId).catch(() => null),
  ]);
  if (result.error || !Array.isArray(result.data)) {
    return { groups: [], currency: null, total: 0 };
  }
  const locale = input.context.turn.locale;
  const byDepartment = new Map<string, ServiceGroup["services"][number][]>();
  let total = 0;
  for (const row of result.data) {
    const departmentId = String(row.department_id ?? "");
    const entry = {
      id: String(row.id),
      name: localizedName(
        {
          name: String(row.name),
          nameAr: displayText(row.name_ar),
          nameEn: displayText(row.name_en),
        },
        locale,
      ),
      price:
        row.price === null || row.price === undefined ? null : Number(row.price),
    };
    byDepartment.set(departmentId, [...(byDepartment.get(departmentId) ?? []), entry]);
    total += 1;
  }
  // Department order comes from the clinic's own directory, so the grouping a
  // patient reads matches the list they were offered when they were asked to
  // choose one. A service whose department is inactive keeps its own row and is
  // simply not shown under a heading it no longer has.
  const groups: ServiceGroup[] = [];
  for (const department of departments) {
    const services = byDepartment.get(department.id);
    if (!services || services.length === 0) continue;
    groups.push({
      departmentId: department.id,
      departmentName: localizedName(department, locale),
      services,
    });
  }
  return { groups, currency: currency ?? null, total };
}

/**
 * Grounds a spoken department name against the clinic's own list.
 *
 * Shared by the booking flow and by the services question, so "العلاج الطبيعي"
 * selects the same department whichever way the patient arrives at it.
 */
/**
 * The same grounding, with the clinic's own cross-language matcher behind it.
 *
 * `resolveDepartmentSpoken` is substring containment, which is right for
 * scoping a services question and wrong for selecting a department to book in:
 * a clinic whose departments are stored in English cannot be reached by a
 * patient typing Arabic, because "الجلدية" is not a substring of "Dermatology".
 * `resolveNamedEntity` is the resolver the legacy engine has always used for
 * exactly this — literal score, transliteration and the concept lexicon, with
 * the literal reading breaking every tie — so a department is reachable by its
 * own stored name first and by a cross-language concept only when the letters
 * alone could not connect them.
 *
 * Three answers, matching every other resolver in the system: the engine
 * commits a `resolved`, asks which for an `ambiguous`, and asks again for an
 * `unresolved`. Nothing here can invent a department: the candidate set is the
 * clinic's own active rows, loaded this turn.
 */
export async function resolveDepartmentNamed(input: {
  context: TurnContext;
  spoken: string;
}): Promise<
  | { kind: "resolved"; value: string; label: string }
  | {
      kind: "ambiguous";
      options: readonly { value: string; label: string; source: "clinic_directory" }[];
    }
  | { kind: "unresolved" }
> {
  const departments = await readDepartments(input.context);
  if (departments.length === 0) return { kind: "unresolved" };
  const byId = new Map(departments.map((entry) => [entry.value, entry]));
  // Scored against the label the patient was shown *and* every other name the
  // clinic authored for the same department, so «الجلدية» and "Dermatology"
  // reach the same row whichever language the conversation is in. The label
  // stays the only thing that can be said back.
  const resolution = resolveNamedEntity(
    input.spoken,
    departments.map((entry) => ({
      id: entry.value,
      name: entry.label,
      aliases: entry.aliases,
    })),
  );
  if (resolution.status === "resolved") {
    const entry = byId.get(resolution.entity.id);
    if (entry) return { kind: "resolved", value: entry.value, label: entry.label };
  }
  if (resolution.status === "ambiguous") {
    const options = resolution.candidates
      .map((candidate) => byId.get(candidate.id))
      .filter((entry): entry is (typeof departments)[number] => Boolean(entry))
      .map((entry) => ({
        value: entry.value,
        label: entry.label,
        source: "clinic_directory" as const,
      }));
    if (options.length === 1) {
      return { kind: "resolved", value: options[0]!.value, label: options[0]!.label };
    }
    if (options.length > 1) return { kind: "ambiguous", options };
  }
  return { kind: "unresolved" };
}

export async function resolveDepartmentSpoken(input: {
  context: TurnContext;
  spoken: string;
}): Promise<readonly Candidate<string>[]> {
  const departments = await readDepartments(input.context);
  const wanted = input.spoken.trim().toLowerCase();
  if (!wanted) return [];
  const exact = departments.filter(
    (department) => department.label.toLowerCase() === wanted,
  );
  if (exact.length > 0) return exact;
  return departments.filter(
    (department) =>
      department.label.toLowerCase().includes(wanted) ||
      wanted.includes(department.label.toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// Patient-scoped reads. Reachable only from a step declaring `verified`.
// ---------------------------------------------------------------------------

/**
 * This patient's usable packages.
 *
 * The RPC resolves the patient from the *conversation's* linkage and ignores
 * any id a caller might pass, so there is no argument by which one patient's
 * packages could be read for another. An unlinked thread gets an empty list
 * rather than an error, because an error is itself a disclosure.
 *
 * Returns {@link Candidate}s. A package the patient owns is something the flow
 * may **offer**; it never becomes a decision without an `affirm_offer` (I-5),
 * and a session is never decremented by this read.
 */
export async function readPatientPackages(input: {
  context: TurnContext;
  departmentId?: string | null;
  serviceId?: string | null;
}): Promise<readonly Candidate<string>[]> {
  const result = await listPatientAiPackages({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    departmentId: input.departmentId ?? null,
    serviceId: input.serviceId ?? null,
  });
  if (result.error || !Array.isArray(result.data)) return [];
  return (result.data as Record<string, unknown>[]).map((row) => ({
    value: String(row.package_id),
    label: `${String(row.name)} · ${Number(row.remaining_sessions ?? 0)}`,
    source: "patient_packages" as const,
  }));
}

/**
 * The patient's own name, in the language this conversation is being held in.
 *
 * ## Why this is a read and not a formatting rule
 *
 * A file carries up to three names: the canonical `full_name`, and the optional
 * Arabic and English display names a person authored (the clinic on the
 * Patients screen, or the patient themselves through the assistant's intake).
 * Greeting «أهلًا Ali Alzanaty» in an Arabic thread is not wrong data, it is
 * the wrong *name for this conversation* — and the right one is a column, not
 * a transformation.
 *
 * ## The three properties that keep it safe
 *
 *   * **Gated exactly as before.** The caller
 *     (`assembleTurnContext.durable.canonicalName`) only asks at `verified`,
 *     which is unchanged. This function discloses nothing the canonical name
 *     did not already disclose at that level, and it reads one row by the
 *     patient id the *server* resolved — never by anything the model supplied.
 *   * **Never a rendering.** A language with no authored name falls back to
 *     `full_name`, exactly as every other display-name reader does. Nothing
 *     transliterates, and there is no third option.
 *   * **Never identity.** Matching a patient is `find_clinic_patient_by_identity`
 *     folding `full_name` against an exact national id, and none of that is
 *     here. A display name cannot select a record.
 *
 * `selectWithOptional` because the columns are additive: on a database where
 * the migration has not run this returns the canonical name and nothing
 * changes.
 */
export async function readPatientDisplayName(input: {
  context: TurnContext;
  patientId: string;
  fallback: string | null;
}): Promise<string | null> {
  const db = createClinicScopedAdminClient(input.context.clinicId);
  const result = await selectWithOptional<Record<string, unknown>>(
    ["full_name"],
    PATIENT_DISPLAY_COLUMNS,
    (columns) =>
      db
        .from("patients")
        .select(columns)
        .eq("id", input.patientId)
        .eq("clinic_id", input.context.clinicId)
        .eq("is_deleted", false)
        .maybeSingle() as unknown as PromiseLike<{
        data: Record<string, unknown> | null;
        error: unknown;
      }>,
  );
  const row = result.error ? null : result.data;
  if (!row) return input.fallback;
  const localized =
    input.context.turn.locale === "ar"
      ? displayText(row.full_name_ar)
      : displayText(row.full_name_en);
  return localized ?? displayText(row.full_name) ?? input.fallback;
}

/**
 * The email address this clinic already holds for the *sender's own* file.
 *
 * ## What it is for
 *
 * Exactly one sentence: «نفس إيميلي» / "use my email", answered while a
 * third-party intake is standing on the beneficiary's email question. It is the
 * email counterpart of `TurnContext.participantAddress`, and it exists as a
 * read rather than as a field for the reason that address does not — the phone
 * is the address the message physically arrived on and the server has it for an
 * anonymous sender, whereas an email lives on a patient record and only exists
 * once this thread selects one.
 *
 * ## The properties that keep it safe
 *
 *   * **Server-resolved subject.** `patientId` is the id
 *     `authorizePatientConversation` derived from this conversation's own
 *     linkage. The model never supplies it and there is no argument by which a
 *     caller could ask for somebody else's row — the query is additionally
 *     pinned to the clinic and to `is_deleted = false`.
 *   * **Contact data, never identity.** An email cannot select a record here or
 *     anywhere else: discovery is `resolveIdentity`, which folds the canonical
 *     name against an exact national id and takes no contact argument. Writing
 *     this address onto a beneficiary's staged file links, verifies and
 *     confirms nobody.
 *   * **One column.** `email` and nothing beside it, so a read that is only
 *     ever needed for a contact field cannot become a general patient reader.
 *   * **Total.** A missing row, a failed read or an unusable column value all
 *     produce null, and null means the intake asks for the beneficiary's own
 *     address. Nothing here can invent one.
 */
export async function readRequesterContactEmail(input: {
  clinicId: string;
  patientId: string;
}): Promise<string | null> {
  const db = createClinicScopedAdminClient(input.clinicId);
  const { data, error } = await db
    .from("patients")
    .select("email")
    .eq("id", input.patientId)
    .eq("clinic_id", input.clinicId)
    .eq("is_deleted", false)
    .maybeSingle();
  if (error || !data) return null;
  const value = (data as { email?: unknown }).email;
  return typeof value === "string" ? value : null;
}

/**
 * Documents already issued to this patient.
 *
 * **Retrieval only.** The RPC selects `status = 'issued'` with a non-null
 * `issued_by`, so every row it can return was finalized by an authorized person
 * through the existing document workflow. There is no function in this file
 * that creates, finalizes or alters a document, and the assistant has no other
 * path to the `documents` table — a patient asking to be *issued* something new
 * is a handoff, not a tool call.
 */
export async function readPatientDocuments(input: {
  context: TurnContext;
  docType?: string | null;
}): Promise<readonly Candidate<string>[]> {
  const result = await listPatientAiDocuments({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    docType: input.docType ?? null,
    limit: 10,
  });
  if (result.error || !Array.isArray(result.data)) return [];
  return (result.data as Record<string, unknown>[]).map((row) => ({
    value: String(row.document_id),
    label: `${String(row.doc_type)} ${String(row.document_number)}`,
    source: "patient_documents" as const,
  }));
}

/**
 * A short-lived link to one issued document the patient owns.
 *
 * Re-reads the patient's own document list and matches by id rather than
 * trusting the id it was handed, so a stale or tampered reference selects
 * nothing. The signed URL is minted from the storage path the RPC returned and
 * expires quickly; the bytes never pass through the model.
 */
export async function readDocumentLink(input: {
  context: TurnContext;
  documentId: string;
}): Promise<{ url: string; label: string } | null> {
  const result = await listPatientAiDocuments({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    docType: null,
    limit: 25,
  });
  if (result.error || !Array.isArray(result.data)) return null;
  const row = (result.data as Record<string, unknown>[]).find(
    (entry) => String(entry.document_id) === input.documentId,
  );
  if (!row || typeof row.pdf_storage_path !== "string") return null;
  const signed = await signClinicDocumentUrl({
    storagePath: row.pdf_storage_path,
  });
  if (signed.error || !signed.data?.signedUrl) return null;
  return {
    url: signed.data.signedUrl,
    label: `${String(row.doc_type)} ${String(row.document_number)}`,
  };
}

export async function readMyAppointments(context: TurnContext) {
  const result = await listPatientAiAppointments({
    clinicId: context.clinicId,
    conversationId: context.conversationId,
  });
  return result.error ? [] : ((result.data ?? []) as Record<string, unknown>[]);
}

/**
 * The doctors this patient has actually been treated by here.
 *
 * The one durable read that names a doctor, and the reason it returns
 * {@link Candidate}s rather than values. This is what `prepare_booking` used to
 * do before writing the answer straight into conversation state; here the
 * return type makes that write unrepresentable.
 */
export async function readTreatingDoctors(
  context: TurnContext,
): Promise<readonly Candidate<string>[]> {
  if (context.identity === "anonymous" || !context.patientId) return [];
  const [patient, directory] = await Promise.all([
    readPatientCareRow(context),
    loadDoctorDirectory(context.clinicId),
  ]);
  const doctorId = patient?.assigned_doctor_id;
  if (!doctorId) return [];
  const doctor = directory.doctors.find(
    (entry) => entry.id === doctorId && entry.state === "available",
  );
  // A doctor who has left or is on leave is not offerable. "Shall we book you
  // with your usual doctor?" is not a question worth asking about somebody who
  // cannot be booked — the same rule `existing-patient-discovery` applies.
  if (!doctor) return [];
  return [
    {
      value: doctor.id,
      label: doctorDisplayName(doctor, context.turn.locale),
      source: "patient_history",
    },
  ];
}

/**
 * The patient's own care row — the assigned doctor and the department they sit
 * in. One read, shared by the two durable facts derived from it.
 */
async function readPatientCareRow(
  context: TurnContext,
): Promise<{ assigned_doctor_id: string | null; department_id: string | null } | null> {
  if (context.identity === "anonymous" || !context.patientId) return null;
  const result = await createClinicScopedAdminClient(context.clinicId)
    .from("patients")
    .select("assigned_doctor_id, department_id")
    .eq("id", context.patientId)
    .maybeSingle();
  return (
    (result.data as { assigned_doctor_id: string | null; department_id: string | null } | null) ??
    null
  );
}

/**
 * The departments this patient is actually known in.
 *
 * Matched on the patient's own `department_id` against the clinic directory.
 * The predicate this replaces — `doctors.some(d => d.label.length > 0 && …)` —
 * never referenced the department at all, so it was true for every row the
 * moment the patient had any treating doctor: the booking step's "known first"
 * ordering was a no-op and `previously_seen` was asserted about departments
 * nobody had ever attended.
 *
 * Returns {@link Candidate}s like every other durable fact: known-in is a
 * suggestion to order a list by, never a selection (I-5).
 */
export async function readKnownDepartments(
  context: TurnContext,
): Promise<readonly Candidate<string>[]> {
  const patient = await readPatientCareRow(context);
  const departmentId = patient?.department_id;
  if (!departmentId) return [];
  const departments = await readDepartments(context);
  return departments
    .filter((department) => department.value === departmentId)
    .map((department) => ({ ...department, source: "patient_history" as const }));
}

// ---------------------------------------------------------------------------
// Availability. The worked precondition example.
// ---------------------------------------------------------------------------

/**
 * Days with at least one bookable slot for a committed doctor.
 *
 * Reachable from exactly one step — `book_appointment`'s day step — whose
 * declared precondition is `slots: ["department", "doctor"]`. The engine checks
 * that against the frame's own committed slots before this runs, so:
 *
 *   * with no active booking frame it cannot run at all;
 *   * with a parked frame it cannot run, because a parked frame is not active;
 *   * with a doctor known only from the patient's history it cannot run,
 *     because durable memory does not produce a committed slot (I-5, I-7).
 *
 * That is the precondition from the brief, enforced by the engine rather than
 * restated here — which is the point: a check inside the tool would be one more
 * thing a future caller could route around.
 */
export async function readAvailableDays(input: {
  context: TurnContext;
  doctorId: string;
  serviceId?: string | null;
  /** A lower bound the patient set — "بعد يوم ٩". A bound, not a choice. */
  after?: string | null;
  durationMinutes?: number;
}): Promise<
  | { ok: true; days: readonly Candidate<string>[]; windowStart: string; windowEnd: string }
  | { ok: false; reason: string }
> {
  const identity = await identityFor(input.context);
  // Both bounds in one expression: the clinic's lead-time floor and whatever
  // the patient ruled out. `bookableWindowStart` takes the later of the two, so
  // «بعد يوم 11» genuinely moves the search forward and no refinement can ever
  // walk it back into today or tomorrow. See `lib/booking/lead-time.ts`.
  const windowStart = bookableWindowStart({
    now: input.context.now,
    timeZone: identity.clinicTimezone,
    after: input.after ?? null,
  });
  const windowEnd = addCalendarDays(windowStart, AVAILABILITY_WINDOW_DAYS - 1);
  const result = await getPatientAvailableDays({
    identity,
    doctorId: input.doctorId,
    durationMinutes: input.durationMinutes ?? 30,
    searchDays: AVAILABILITY_WINDOW_DAYS,
    startDate: windowStart,
    serviceId: input.serviceId ?? null,
    // The turn's own clock, not the process's. Every other read in this file
    // passes it; this one did not, so a test clock moved the day list and left
    // the slot list behind it.
    now: input.context.now,
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  return {
    ok: true,
    windowStart,
    windowEnd,
    // `value` stays the canonical `YYYY-MM-DD` every downstream read and write
    // uses; `label` is the only thing a patient sees, and it carries the
    // weekday, which is what somebody actually plans around. A bare list of ISO
    // dates was the manual-QA defect this fixes.
    days: result.availableDays.map((day) => ({
      value: day.date,
      label: formatOfferedDay(day.date, input.context.turn.locale),
      source: "clinic_directory" as const,
    })),
  };
}

export async function readAvailableSlots(input: {
  context: TurnContext;
  doctorId: string;
  date: string;
  serviceId?: string | null;
  durationMinutes?: number;
}): Promise<
  { ok: true; times: readonly Candidate<string>[] } | { ok: false; reason: string }
> {
  const identity = await identityFor(input.context);
  // A day the rule excludes has no offerable times, whichever way the flow
  // arrived at it. The day step cannot reach one — it matches the patient's
  // words against the days this window returned — but a reschedule, a
  // correction or a directly named date can, and one guard here is cheaper
  // than trusting five callers.
  if (!isOnlineBookableDate(input.date, input.context.now, identity.clinicTimezone)) {
    return { ok: true, times: [] };
  }
  const result = await getPatientAvailableSlots({
    identity,
    date: input.date,
    doctorId: input.doctorId,
    serviceId: input.serviceId ?? null,
    durationMinutes: input.durationMinutes ?? 30,
    now: input.context.now,
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  return {
    ok: true,
    // Same split as the days above: the 24-hour `value` is what the calendar
    // and the write speak, the label is the clinic's configured clock in the
    // patient's language.
    times: result.availableSlots.map((slot: string) => ({
      value: slot,
      label: formatOfferedTime(
        slot,
        input.context.turn.locale,
        input.context.clinic.timeFormat,
      ),
      source: "clinic_directory" as const,
    })),
  };
}

// ---------------------------------------------------------------------------
// Identity — one implementation, used by every flow that needs it
// ---------------------------------------------------------------------------

export type IdentityResolution =
  /** No file here proves this identity. Registration is the next move. */
  | { kind: "none" }
  /** Exactly one file, and the submitted name is a plausible rendering of it. */
  | {
      kind: "matched";
      patientId: string;
      canonicalName: string;
      departments: readonly { id: string; name: string }[];
      treatingDoctorByDepartment: Record<string, { id: string; name: string }>;
    }
  /** Several clinical homes. Which one is a question, never a guess. */
  | {
      kind: "ambiguous_department";
      patientId: string;
      canonicalName: string;
      departments: readonly { id: string; name: string }[];
    };

/**
 * The single identity implementation (the brief's "centralized, not
 * reimplemented per flow").
 *
 * Delegates the *rule* to `find_clinic_patient_by_identity`, which already
 * implements it correctly and in the right place: exact folded national/civil
 * id within one clinic, confirmed by an exactly folded name, ambiguity failing
 * closed. Nothing about that rule is reimplemented here, and nothing here can
 * match anybody — it is handed rows the database has already decided are one
 * specific person.
 *
 * The anti-existence-oracle property is preserved by construction: this
 * function is only ever called with an id **the patient themselves supplied**,
 * and every non-match returns the same `none` regardless of whether some other
 * person's record exists. A caller cannot distinguish "no such id" from "that
 * id belongs to somebody whose name you got wrong", because both are `none`.
 */
export async function resolveIdentity(input: {
  context: TurnContext;
  nationalId: string;
  fullName: string;
}): Promise<IdentityResolution> {
  const result = await findClinicPatientByIdentity({
    clinicId: input.context.clinicId,
    nationalId: input.nationalId,
    fullName: input.fullName,
  });
  if (result.error) return { kind: "none" };
  const discovery = discoveryFromRelationships(
    (result.data ?? []) as Parameters<typeof discoveryFromRelationships>[0],
  );
  if (discovery.kind === "none") return { kind: "none" };
  if (discovery.kind === "single_department") {
    return {
      kind: "matched",
      patientId: discovery.patientId,
      canonicalName: discovery.patientName,
      departments: [discovery.department],
      treatingDoctorByDepartment: discovery.treatingDoctor
        ? { [discovery.department.id]: discovery.treatingDoctor }
        : {},
    };
  }
  return {
    kind: "ambiguous_department",
    patientId: discovery.patientId,
    canonicalName: discovery.patientName,
    departments: discovery.departments,
  };
}

// ---------------------------------------------------------------------------
// Writes. Two of them, each reachable from exactly one step.
// ---------------------------------------------------------------------------

/**
 * Stages a new patient file for staff review. Never creates one outright.
 *
 * The existing RPC, unchanged, including its own identity checks and its
 * refusal to stage a record it cannot validate. The V2 step that calls it has
 * `identity: "none"` — a stranger must be able to register — but has every
 * intake slot in its precondition list, so it cannot run on a partial file.
 */
export async function stageIntake(input: {
  context: TurnContext;
  fullName: string;
  nationalId: string;
  dateOfBirth: string;
  email: string;
  /**
   * The booking this file is being opened for.
   *
   * Required by the RPC, and correctly so: a staged intake exists to be
   * reviewed alongside a request, and a file with no clinical destination is
   * not something staff can act on. The step that calls this therefore
   * declares both in its precondition, which is why it can never run before a
   * department and doctor are committed.
   */
  departmentId: string;
  doctorId: string;
  forThirdParty?: boolean;
  phone?: string | null;
  bloodType?: string | null;
  /**
   * The name exactly as the patient typed it, when `fullName` is a Latin
   * rendering of it. Kept beside the transliteration, never instead of it —
   * the existing P10 behaviour, unchanged.
   */
  fullNameOriginal?: string | null;
  /**
   * The patient's name in each language, when the intake collected both.
   *
   * Display names, and nothing more. `fullName` is still the canonical record
   * and every identity check still folds it, so a bilingual name can neither
   * match a file nor fail to — see the identity firewall note in
   * `latinNameOutcome`.
   */
  fullNameAr?: string | null;
  fullNameEn?: string | null;
}): Promise<{ ok: boolean; reason?: string }> {
  // The third-party phone invariant, enforced before the write rather than
  // discovered after it.
  //
  // `stage_patient_intake_from_conversation` fills a missing third-party phone
  // from `conversations.participant_address` — the WhatsApp number of the
  // person *sending* the message. That fallback is a reasonable last resort for
  // a clinic that has to reach somebody, and it is the wrong answer for a
  // patient record: manual QA produced a file for a third party carrying the
  // sender's mobile number, with nobody having been asked for the patient's
  // own. The sender is the requester; the patient is a different person, and
  // their contact number is theirs.
  //
  // So the assistant never lets that fallback be reached: a third-party intake
  // without a phone the patient actually gave is refused here. The flow's
  // intake step asks for it (see `INTAKE_REQUIRED_FIELDS`), so reaching this
  // line with no phone means a step ran out of order, which is a bug to
  // surface rather than a number to invent.
  const phone = (input.phone ?? "").trim();
  if (input.forThirdParty === true && phone.length === 0) {
    return { ok: false, reason: "third_party_phone_required" };
  }
  const result = await stagePatientIntakeFromConversation({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    fullName: input.fullName,
    nationalId: input.nationalId,
    dateOfBirth: input.dateOfBirth,
    email: input.email,
    departmentId: input.departmentId,
    doctorId: input.doctorId,
    forThirdParty: input.forThirdParty === true,
    phone: phone.length > 0 ? phone : null,
    bloodType: input.bloodType ?? null,
    fullNameOriginal: input.fullNameOriginal ?? null,
    fullNameAr: input.fullNameAr ?? null,
    fullNameEn: input.fullNameEn ?? null,
  });
  if (result.error) {
    return { ok: false, reason: String((result.error as { code?: string }).code ?? "failed") };
  }
  // The absence of an error proves nothing.
  //
  // `stage_patient_intake_from_conversation` is a `RETURNS TABLE(status, ...)`
  // function, and most of its outcomes are a *status row* rather than an
  // exception: `already_reviewed`, `duplicate_review`, `identity_mismatch`,
  // `identity_locked`, `already_linked`. This boundary read only `result.error`
  // and returned `{ ok: true }` for every one of them.
  //
  // Manual QA, and the reason this is now checked: `ai_patient_intakes` carries
  // `ai_patient_intakes_conversation_unique (clinic_id, conversation_id)`, so
  // there is one intake row per conversation and the RPC's upsert only updates
  // it `where review_status = 'pending_review'`. A requester whose earlier
  // intake on the same thread had already been approved therefore staged
  // *nothing* — the RPC returned `already_reviewed` with no error, this
  // function said `ok`, the flow set `intake_staged` and told the patient their
  // file was recorded, and the booking that followed was written against the
  // requester's own record because no pending third-party intake existed to say
  // otherwise. A file that was not staged must not read as one.
  //
  // The legacy `register_patient` tool has always branched on this status; only
  // the V2 boundary dropped it. Two outcomes mean a real patient exists and
  // nothing else does:
  //
  //   * `staged` — the row this call wrote, pending review;
  //   * `linked_existing` — the RPC proved the sender's identity and linked the
  //     conversation to their own file. Reachable only on a self-intake, and it
  //     is a real patient, so the booking may proceed.
  //
  // Everything else is `ok: false`, which the intake step already answers with
  // `intake.failed` — a handoff. `intake_staged` is never set, `hasPatient` is
  // false at the confirm step, and no booking is written.
  const status = String(firstRow(result.data)?.status ?? "");
  if (status === "staged" || status === "linked_existing") return { ok: true };
  return { ok: false, reason: status || "unknown_status" };
}

/**
 * Creates the pending booking, optionally consuming a package session.
 *
 * Reachable from one step, and only once that step has read
 * `frame.memo.confirmed === true` — which is written by `affirm_offer` on a
 * `summary` offer and by nothing else. A model cannot set it, because a model
 * emits commands and this memo is written by the engine's own handler.
 *
 * **Package safety.** A session is consumed only when
 * `frame.memo.package_accepted === true`, which likewise comes from an
 * `affirm_offer` on a `package_use` offer. The decrement itself happens inside
 * `create_patient_preliminary_booking_v2`, in the same transaction as the
 * insert and under a row lock on the package, so:
 *
 *   * a failed booking rolls the decrement back with it;
 *   * two racing turns cannot both claim the same session;
 *   * a retried webhook cannot double-consume, because the pending-booking
 *     uniqueness refuses the second insert and the decrement rolls back.
 *
 * Nothing about "the model inferred a package applies" can reach it.
 */
/**
 * Why a booking write did not happen.
 *
 * The distinction is the whole of the availability fix. Every failure used to
 * reach the flow as one opaque `reason` string, and the confirm step answered
 * all of them with «الميعاد ده اتحجز» — "that slot has just been taken" —
 * before invalidating the time and re-offering the day's free slots.
 *
 * For a genuinely contended slot that is right. For the two failures manual QA
 * actually hit it is both false and unescapable:
 *
 *   * `already_pending` — the patient (or this very conversation, on a second
 *     confirmation) already holds a pending AI request. The clinic's own
 *     one-pending-per-patient policy raised `AI_PENDING_PATIENT_CAP`, nothing
 *     was taken, and the slot the patient chose was free the whole time. The
 *     re-offer then listed that same free slot again — `computeAvailability`
 *     blocks on `confirmed/arrived/in_session` only, so a pending row is
 *     invisible to it — the patient picked it again, and the turn repeated
 *     forever.
 *   * `lead_time` — the appointment is real and free but too soon to book
 *     online. Offering other *times* on the same too-soon day cannot fix it.
 *
 * So the reason is classified here, once, at the boundary where the RPC's
 * vocabulary is still visible, and the step branches on a small closed set
 * rather than on a message.
 */
export type BookingFailureReason =
  /** The slot is genuinely no longer bookable. Re-query and offer again. */
  | "slot_taken"
  /** Free, but sooner than online booking is allowed to offer. */
  | "lead_time"
  /** A pending request already exists — including the one this turn made. */
  | "already_pending"
  /** The staged file or intake the booking depends on is not there. */
  | "not_ready"
  /** Anything else. The clinic team takes it from here. */
  | "failed";

/**
 * The RPC's vocabulary, mapped onto the closed set above.
 *
 * Both booking paths are covered: the typed `reason` union that
 * `createPatientPendingBooking` returns, and the raw error message the package
 * RPC surfaces, which carries the same `AI_*` tokens.
 */
export function classifyBookingFailure(reason: string): BookingFailureReason {
  if (reason === "minimum_notice" || reason.includes("AI_BOOKING_MINIMUM_NOTICE")) {
    return "lead_time";
  }
  if (reason === "patient_pending_cap" || reason.includes("AI_PENDING_PATIENT_CAP")) {
    return "already_pending";
  }
  if (
    reason === "slot_unavailable" ||
    reason === "slot_pending_cap" ||
    reason.includes("AI_BOOKING_SLOT_UNAVAILABLE") ||
    reason.includes("AI_BOOKING_INVALID_SLOT") ||
    reason.includes("AI_PENDING_SLOT_CAP")
  ) {
    return "slot_taken";
  }
  if (
    reason === "intake_required" ||
    reason.includes("PROVISIONAL_INTAKE_REQUIRED") ||
    reason.includes("PATIENT_IDENTITY_UNLINKED")
  ) {
    return "not_ready";
  }
  return "failed";
}

export async function commitBooking(input: {
  context: TurnContext;
  doctorId: string;
  /** The committed `day` slot, `YYYY-MM-DD` in the clinic's own calendar. */
  date: string;
  /** The committed `time` slot, `HH:mm`, as the clinic's calendar offered it. */
  time: string;
  durationMinutes: number;
  serviceId?: string | null;
  packageId?: string | null;
  /**
   * Who this appointment is for, as the *frame* knows it.
   *
   * The frame is the authority on the beneficiary and it always has been: the
   * beneficiary step asks the question outright, `normalizeBeneficiary` reads
   * the answer, and `frame.slots.beneficiary` holds it for the rest of the
   * booking. This argument is that fact, carried to the write.
   *
   * It shipped absent, and `createPatientPendingBooking` re-derived it instead
   * — from `getPendingConversationIntake`, a database lookup for a *pending*
   * intake row on this conversation. When that lookup came back empty the
   * booking was taken to be the sender's own and the linked branch wrote a real
   * appointment on the sender's file. Manual QA: a linked requester booked for
   * his son, the staging silently did nothing (see `stageIntake`), the lookup
   * found nothing, and the son's appointment was created for the father.
   *
   * So the beneficiary is passed rather than inferred. The lookup is kept as a
   * second, independent guard — neither one alone can put a third-party booking
   * on the sender's record.
   */
  forThirdParty: boolean;
}): Promise<
  | { ok: true; appointmentId: string; packageSessionNumber: number | null }
  | { ok: false; reason: BookingFailureReason }
> {
  const identity = await identityFor(input.context);
  // The lead-time invariant, checked once more at the write.
  //
  // The day list was filtered by it and the write path re-checks it too; this
  // is the third and it is the cheap one, because it turns a round trip into a
  // decision the flow can act on without having to read an RPC error. See
  // `lib/booking/lead-time.ts` for why the rule is a calendar day.
  if (!isOnlineBookableDate(input.date, input.context.now, identity.clinicTimezone)) {
    return { ok: false, reason: "lead_time" };
  }
  // The clinic's wall clock, converted to an instant here rather than joined
  // into a naive string by the caller.
  //
  // This is the defect behind "the request was sent" with nothing in the
  // database. `day` and `time` are the clinic's local calendar — 12:15 in
  // Cairo — and `new Date("2026-09-13T12:15:00")` reads them in the *server's*
  // zone. On any host not sitting in the clinic's timezone the instant lands
  // hours away, the availability re-check downstream cannot find it among the
  // free slots, and every booking fails as `slot_unavailable`. The legacy path
  // has always used `fromZonedTime` for exactly this; V2 did not.
  const scheduledAt = fromZonedTime(
    `${input.date}T${input.time}:00`,
    identity.clinicTimezone,
  ).toISOString();
  // `create_patient_preliminary_booking_v2` books for the *conversation's*
  // patient — the sender — and decrements the sender's package. There is no
  // argument on it for anybody else, so it cannot express a third-party
  // booking and must never be reached by one. The package step offers only the
  // sender's own packages and does not consult the beneficiary, so this is the
  // one place the two can meet; it fails closed rather than filing the son's
  // appointment on his father's record to spend his father's sessions.
  //
  // `failed` is the honest classification: the clinic team takes it from here.
  // Making the package step itself beneficiary-aware is a separate change.
  if (input.forThirdParty && input.packageId) {
    return { ok: false, reason: "failed" };
  }
  if (!input.packageId) {
    // No package: the existing path, byte for byte. Every slot, notice and
    // ownership check it has always performed still applies.
    const result = await createPatientPendingBooking({
      identity,
      doctorId: input.doctorId,
      scheduledAt,
      durationMinutes: input.durationMinutes,
      serviceId: input.serviceId ?? null,
      now: input.context.now,
      forThirdParty: input.forThirdParty,
    });
    if (!result.ok) {
      return { ok: false, reason: classifyBookingFailure(result.reason) };
    }
    return {
      ok: true,
      appointmentId: String(
        (result as unknown as { appointmentId?: string }).appointmentId ?? "",
      ),
      packageSessionNumber: null,
    };
  }
  const result = await createPatientPreliminaryBookingWithPackage({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    doctorId: input.doctorId,
    scheduledAt,
    durationMinutes: input.durationMinutes,
    serviceId: input.serviceId ?? null,
    packageId: input.packageId,
  });
  if (result.error) {
    return {
      ok: false,
      reason: classifyBookingFailure(String(result.error.message ?? "")),
    };
  }
  const row = Array.isArray(result.data)
    ? (result.data[0] as Record<string, unknown> | undefined)
    : undefined;
  if (!row?.appointment_id) return { ok: false, reason: "failed" };
  return {
    ok: true,
    appointmentId: String(row.appointment_id),
    packageSessionNumber:
      row.package_session_number === null || row.package_session_number === undefined
        ? null
        : Number(row.package_session_number),
  };
}

/**
 * Cancels one of the patient's own appointments.
 *
 * `cancel_patient_ai_appointment` returns `(cancelled boolean, reason text)`,
 * so the absence of a transport error proves nothing: an RPC that ran fine and
 * declined the cancellation returns `cancelled = false` with no error at all.
 * Reading the flag is the difference between telling a patient their
 * appointment is cancelled and it actually being cancelled.
 */
export async function commitCancellation(input: {
  context: TurnContext;
  appointmentId: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const result = await cancelPatientAiAppointment({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    appointmentId: input.appointmentId,
  });
  if (result.error) return { ok: false, reason: "rpc_error" };
  const row = firstRow(result.data);
  if (row?.cancelled !== true) {
    return { ok: false, reason: String(row?.reason ?? "refused") };
  }
  return { ok: true };
}

/**
 * The appointment a reschedule is about, as the server describes it.
 *
 * `prepare_patient_ai_reschedule` takes only the appointment and returns its
 * doctor, service and duration — it has never taken a date. The call this
 * replaces passed one anyway and silenced the resulting type error with a cast,
 * so the argument was dropped on the floor and the single appointment row came
 * back where a list of times was expected. The reschedule flow then offered
 * that row *as* a time.
 *
 * What it returns instead is what a reschedule actually needs: the identifiers
 * to ask the calendar with, so days and times are read from the same
 * authoritative availability the booking flow uses rather than parsed out of
 * the patient's message.
 */
export async function readRescheduleTarget(input: {
  context: TurnContext;
  appointmentId: string;
}): Promise<
  | {
      ok: true;
      doctorId: string;
      doctorName: string;
      serviceId: string | null;
      durationMinutes: number;
    }
  | { ok: false }
> {
  const result = await preparePatientAiReschedule({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    appointmentId: input.appointmentId,
  });
  if (result.error) return { ok: false };
  const row = firstRow(result.data);
  if (!row || typeof row.doctor_id !== "string") return { ok: false };
  return {
    ok: true,
    doctorId: row.doctor_id,
    doctorName: String(row.doctor_name ?? ""),
    serviceId: typeof row.service_id === "string" ? row.service_id : null,
    durationMinutes: Number(row.duration_minutes ?? 30),
  };
}

/**
 * Moves the appointment. Reads the RPC's own verdict, for the reason
 * {@link commitCancellation} does.
 */
export async function commitReschedule(input: {
  context: TurnContext;
  appointmentId: string;
  /** The committed `day` slot, in the clinic's own calendar. */
  date: string;
  /** The committed `time` slot, as the clinic's calendar offered it. */
  time: string;
}): Promise<{ ok: boolean; reason?: string }> {
  // Same conversion, same reason as `commitBooking`: these two slots are the
  // clinic's wall clock, and only `fromZonedTime` turns them into the instant
  // the RPC stores.
  const identity = await identityFor(input.context);
  const scheduledAt = fromZonedTime(
    `${input.date}T${input.time}:00`,
    identity.clinicTimezone,
  ).toISOString();
  const result = await reschedulePatientAiAppointment({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    appointmentId: input.appointmentId,
    scheduledAt,
  });
  if (result.error) return { ok: false, reason: "rpc_error" };
  const row = firstRow(result.data);
  if (row?.rescheduled !== true) {
    return { ok: false, reason: String(row?.reason ?? "refused") };
  }
  return { ok: true };
}

/** The first row of an RPC result set, whatever shape PostgREST returned it in. */
function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    return (data[0] as Record<string, unknown> | undefined) ?? null;
  }
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

export type { InsuranceProvider, PackageEntry, PackageItemEntry, PackageGroup };
export { resolveInsuranceProvider, resolvePackageNamed } from "@/lib/ai/v2/catalog";
