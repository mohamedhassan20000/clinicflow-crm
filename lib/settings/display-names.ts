/**
 * Clinic-authored bilingual display names.
 *
 * ## What these columns are, and what they are not
 *
 * `departments.name`, `services.name` and `profiles.full_name` are canonical:
 * they are what the clinic search, the audit trail, the invoices and every
 * staff-facing screen speak, and nothing here touches them. Beside each sits an
 * optional pair — an Arabic display name and an English one — that a person at
 * the clinic types. They exist for one reason: an Arabic conversation should be
 * able to say «العلاج الطبيعي» for a department the clinic stored as "Physical
 * Therapy" without anything having invented that phrase.
 *
 * **Never machine-generated.** No transliteration, no model, no backfill. A
 * patient-facing name is either one a person authored or the canonical stored
 * text, and there is no third option — which is why the fallback below returns
 * `name` rather than attempting a rendering. Getting a doctor's name wrong is
 * not a formatting defect.
 *
 * ## Why the reads tolerate the columns not existing
 *
 * The migration that adds them is additive and is applied by the clinic, on
 * their schedule. Until it runs, a `select` naming these columns is a
 * PostgREST error and the *whole* read fails — the department list, the doctor
 * roster, the service catalog. A patient assistant that stops answering because
 * a display-name column is not there yet would be a worse defect than the one
 * this feature fixes, so every read goes through {@link selectWithOptional},
 * which drops the optional columns and retries once.
 */

/** The optional columns, per table. One list, so the reads and the migration agree. */
export const DEPARTMENT_DISPLAY_COLUMNS = ["name_ar", "name_en"] as const;
export const SERVICE_DISPLAY_COLUMNS = ["name_ar", "name_en"] as const;
export const STAFF_DISPLAY_COLUMNS = [
  "display_name_ar",
  "display_name_en",
] as const;
export const PACKAGE_DISPLAY_COLUMNS = ["name_ar", "name_en"] as const;
export const INSURANCE_DISPLAY_COLUMNS = ["name_ar", "name_en"] as const;
/**
 * A patient's optional display names.
 *
 * Named after the canonical column they sit beside (`patients.full_name`)
 * rather than `name_ar`/`name_en`, so a payload can never be routed to the
 * wrong table by key alone. Display only: nothing searches, matches or
 * authenticates on them — see the identity note in the migration that adds
 * them.
 */
export const PATIENT_DISPLAY_COLUMNS = ["full_name_ar", "full_name_en"] as const;

/**
 * Every optional display-name key any settings payload may carry.
 *
 * One list so the writes and {@link stripBlankDisplayNames} agree, and so a
 * table that grows a pair later is added in exactly one place.
 */
export const DISPLAY_NAME_KEYS = [
  "name_ar",
  "name_en",
  "display_name_ar",
  "display_name_en",
  "full_name_ar",
  "full_name_en",
] as const;

/**
 * Normalises the optional bilingual display-name fields on a settings payload.
 *
 * Two jobs, both small and both load-bearing:
 *
 *   * blank becomes absent. `""` in a display-name column is a name every
 *     reader would have to special-case, and {@link displayText} already
 *     treats blank and NULL as the same thing — so the write must not create
 *     the distinction.
 *   * a key with nothing in it is **dropped from the payload entirely**. That
 *     is what lets these screens keep working on a database where the additive
 *     migration has not been applied yet: a clinic that has not typed an Arabic
 *     name sends byte-for-byte the payload it sent before, and only a clinic
 *     that actually authored one names the new columns.
 */
export function stripBlankDisplayNames<T extends Record<string, unknown>>(
  record: T,
): T {
  const next: Record<string, unknown> = { ...record };
  for (const key of DISPLAY_NAME_KEYS) {
    if (!(key in next)) continue;
    const value = typeof next[key] === "string" ? (next[key] as string).trim() : null;
    if (value) next[key] = value;
    else delete next[key];
  }
  return next as T;
}

/** A row read back with either shape. Absent and empty are the same thing. */
export type BilingualRow = Record<string, unknown>;

/** Trimmed text, or null. `""` is "the clinic left it blank", which is null. */
export function displayText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Runs a select that names optional columns, retrying without them.
 *
 * `build` is called with the column list to select, so the caller writes the
 * query once and this decides which shape it gets. The retry is unconditional
 * on error rather than keyed to a PostgREST code: a second read with fewer
 * columns costs one round trip on a path that was about to fail anyway, and
 * matching on error codes across PostgREST versions is exactly the kind of
 * fragility that would make the fallback silently stop working.
 */
export async function selectWithOptional<T>(
  base: readonly string[],
  optional: readonly string[],
  build: (columns: string) => PromiseLike<{ data: T | null; error: unknown }>,
): Promise<{ data: T | null; error: unknown; localized: boolean }> {
  const withOptional = await build([...base, ...optional].join(", "));
  if (!withOptional.error) {
    return { ...withOptional, localized: true };
  }
  const fallback = await build(base.join(", "));
  return { ...fallback, localized: false };
}
