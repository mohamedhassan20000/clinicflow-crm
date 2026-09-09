/**
 * The presentation policy: how a server-owned choice is written down.
 *
 * ## Why this is a module and not a string
 *
 * Manual QA produced four separate defects that were all the same defect:
 * departments came out as one comma-separated run, doctors as another, days as
 * «2026-09-07، 2026-09-08، 2026-09-09» and a four-topic clinic answer as one
 * unbroken WhatsApp paragraph. Each of those
 * was rendered by a different `{placeholder}` in a different copy line, so
 * fixing them one at a time would have produced four inconsistent list styles
 * and a fifth defect the next time a step started offering something.
 *
 * A *choice offer* is one concept. It has a heading, a numbered body and a
 * prompt, and every bounded patient-facing choice in the system — departments,
 * doctors, days, times, packages, documents, appointments — renders through the
 * same function here. Adding a step that offers something adds no formatting
 * code at all.
 *
 * ## What this module may not do
 *
 * Invent a label. Every string it renders arrives from a clinic read; this file
 * numbers, orders, splits and localizes *around* those strings and never
 * translates or transliterates one. That matters most for names: there is no
 * bilingual staff or department name in the schema today (see
 * {@link localizedName}), so an Arabic conversation showing an English-stored
 * doctor name is the honest rendering, and a fabricated Arabic name would not
 * be. The one thing that *is* added in Arabic is the honorific — «د.» is a
 * title, not a name.
 *
 * ## The numbers are not identifiers
 *
 * `1-`, `2-`, `3-` index the **currently open offer** and nothing else. They
 * are minted at render time from the offer's own option order, they are never
 * stored, and the engine resolves a numeric answer against the frame's open
 * offer only — so a number cannot select against a list the patient can no
 * longer see. The canonical ids stay inside the server, exactly as before.
 *
 * Pure: no clock, no I/O, no model.
 */

import { foldArabicDigits } from "@/lib/ai/v2/normalize";

export type Locale = "ar" | "en";

/**
 * The blank line between two things a patient asked about separately.
 *
 * A compound question — «عايز اعرف العنوان ورقم الهاتف والاقسام والخدمات» —
 * produces one effect per topic, and the composer joins them with this. On
 * WhatsApp the alternative is a wall of prose in which the address, the phone
 * number and the price list run together.
 */
export const SECTION_SEPARATOR = "\n\n";

// ---------------------------------------------------------------------------
// Choice offers
// ---------------------------------------------------------------------------

/**
 * A bounded choice, one option per line, numbered from one.
 *
 * Deliberately `1- ` rather than `1. `: a full stop after a digit is how a
 * number reads as an ordinal in prose, and the patient is being shown a menu.
 * The separator is the same in both languages because the digits are.
 */
export function renderChoiceList(labels: readonly string[]): string {
  return labels
    .map((label, index) => `${index + 1}- ${String(label).trim()}`)
    .join("\n");
}

/**
 * True when a list is what the patient should be shown.
 *
 * Two is a menu. A department with two doctors is the ordinary case and the
 * patient still has to pick one, so a two-line numbered list is the right shape
 * — and it is the shape that makes "2" a usable answer.
 *
 * A yes/no question is kept out of this not by counting its options but by not
 * rendering them: «الحجز ده ليك إنت ولا لحد تاني؟» has no `{options}` in its
 * copy at all, because the two readings are already in the sentence. That is
 * the rule the brief asks for — no list where a list would sound robotic — and
 * it lives in the copy, where the question was written, rather than in a
 * threshold that would have to guess.
 *
 * One option is not a choice, so it stays inline.
 */
export const MIN_OPTIONS_FOR_LIST = 2;

export function shouldRenderAsList(labels: readonly string[]): boolean {
  return labels.length >= MIN_OPTIONS_FOR_LIST;
}

/**
 * How an option list reaches a copy template.
 *
 * Long lists become a numbered block on its own lines; short ones stay inline
 * in the sentence they belong to. Both are deterministic, and the composer does
 * not choose between them — it renders what this returns.
 */
export function renderOptions(labels: readonly string[]): {
  text: string;
  structured: boolean;
} {
  if (!shouldRenderAsList(labels)) {
    return { text: labels.length > 0 ? ` ${labels.join("، ")}` : "", structured: false };
  }
  return { text: `\n\n${renderChoiceList(labels)}\n`, structured: true };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * A clinic entity's name in the conversation's language, from trusted data only.
 *
 * `nameAr` / `nameEn` are the seam for bilingual display names. **Neither
 * column exists in the schema today** — `departments.name` and
 * `profiles.full_name` are single `text` columns — so every caller currently
 * passes `name` alone and gets it back unchanged, in either language. When the
 * clinic can author both, the loaders populate these fields and every offer,
 * every list and every confirmation localizes at once, because they all read
 * this function.
 *
 * There is deliberately no transliteration branch. A doctor's name is
 * identity-critical, and a rendered name must be one a person at the clinic
 * typed.
 */
export function localizedName(
  entity: { name: string; nameAr?: string | null; nameEn?: string | null },
  locale: Locale,
): string {
  // The conversation's language first, then the stored name, then the other
  // language. The stored name outranks the *wrong* language deliberately: a
  // clinic that has authored only an Arabic display name has not thereby asked
  // for its English conversations to be answered in Arabic.
  const preferred = locale === "ar" ? entity.nameAr : entity.nameEn;
  const fallback = locale === "ar" ? entity.nameEn : entity.nameAr;
  const chosen = [preferred, entity.name, fallback]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value.length > 0);
  return chosen ?? entity.name;
}

/** Honorifics already on a name, in either script. A title is never doubled. */
const DOCTOR_TITLE = /^(?:د\s*\.?|دكتورة?|الدكتورة?|dr\s*\.?|doctor)\s+/iu;

/**
 * A doctor's name with the honorific the conversation's language uses.
 *
 * The title is language, not identity: «د.» in Arabic and "Dr." in English are
 * the same courtesy, and adding it is the one localization that can be applied
 * to a name without changing whose name it is. A stored name that already
 * carries a title in either script keeps the one it has.
 */
export function doctorDisplayName(
  doctor: { name: string; nameAr?: string | null; nameEn?: string | null },
  locale: Locale,
): string {
  const base = localizedName(doctor, locale).trim();
  if (!base) return base;
  if (DOCTOR_TITLE.test(base)) return base;
  return locale === "ar" ? `د. ${base}` : `Dr. ${base}`;
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/**
 * Weekday names, indexed the way `Date#getUTCDay` returns them.
 *
 * The Arabic spellings here are the display forms. The *matching* forms — every
 * way a patient might write the same weekday — are a separate, wider table in
 * {@link WEEKDAY_PATTERNS}, because reading and writing are not the same job.
 */
export const WEEKDAY_NAMES: Readonly<Record<Locale, readonly string[]>> = {
  ar: ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"],
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
};

/**
 * The weekday of a clinic-local calendar date.
 *
 * The `YYYY-MM-DD` values every availability read returns were already produced
 * with `formatInTimeZone(..., clinicTimezone)`, so they *are* clinic-local
 * calendar dates and their weekday is a property of the digits. Reading it at
 * noon UTC keeps it independent of the process timezone; converting again here
 * would move the date by a day for half the world.
 */
export function weekdayIndex(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const at = Date.parse(`${iso}T12:00:00Z`);
  if (!Number.isFinite(at)) return null;
  return new Date(at).getUTCDay();
}

/**
 * An offered day, as a patient reads it: «الاثنين — 07-09-2026».
 *
 * The weekday is what somebody actually plans around; the date is what makes it
 * unambiguous. Digits stay Latin, per the brief — an Arabic conversation that
 * renders ٠٧-٠٩-٢٠٢٦ is harder to type back, not easier.
 */
export function formatOfferedDay(iso: string, locale: Locale): string {
  const index = weekdayIndex(iso);
  if (index === null) return iso;
  const [year, month, day] = iso.split("-");
  return `${WEEKDAY_NAMES[locale][index]} — ${day}-${month}-${year}`;
}

// The *matching* side of a weekday — every way a patient might write one — is
// `weekdayFromSpoken` in `normalize.ts`. Reading and writing are different
// jobs and they live in different modules: this one may only ever render.

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

/**
 * An offered `HH:mm` in the clinic's configured clock and the patient's
 * language.
 *
 * The same rendering `formatPatientTime` has always produced — kept in step
 * with it deliberately, so a time reads identically whichever engine wrote the
 * message — but without the `server-only` import chain, because this module is
 * pure and every test that exercises presentation would otherwise need a
 * server environment.
 */
export function formatOfferedTime(
  value: string,
  locale: Locale,
  timeFormat: "12h" | "24h",
): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value).trim());
  if (!match) return String(value);
  const hour = Number(match[1]);
  const minute = match[2]!;
  if (hour > 23 || Number(minute) > 59) return String(value);
  if (timeFormat === "24h") return `${String(hour).padStart(2, "0")}:${minute}`;
  const clockHour = hour % 12 || 12;
  if (locale === "en") return `${clockHour}:${minute} ${hour < 12 ? "AM" : "PM"}`;
  return `${clockHour}:${minute} ${hour < 12 ? "صباحًا" : "مساءً"}`;
}

// ---------------------------------------------------------------------------
// Numeric selection
// ---------------------------------------------------------------------------

/** How many options one offer may be answered by number. Mirrors the offer cap. */
const MAX_OFFER_INDEX = 20;

/**
 * The one-based position a message selects, or null.
 *
 * Deliberately **digits only**, and deliberately only when the digits are the
 * whole message (bar a counting word and punctuation). Word ordinals — «التاني»,
 * "the second" — are left to `resolveNamedEntity`, which already reads them
 * against the roster the patient was shown: «تاني» is also the ordinary Arabic
 * word for *another*, and «دكتور تاني» is a rejection rather than a selection.
 * Reading that as "option 2" is precisely the failure the negative-constraint
 * work exists to prevent, so this stays narrow.
 */
export function offerIndexFromSpoken(spoken: string): number | null {
  const text = foldArabicDigits(String(spoken))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
  const bare = text.replace(/^(?:رقم|نمره|نمرة|option|number|num|no)\s+/u, "").trim();
  if (!/^\d{1,2}$/.test(bare)) return null;
  const index = Number(bare);
  if (!Number.isInteger(index) || index < 1 || index > MAX_OFFER_INDEX) return null;
  return index;
}

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

/**
 * The service catalog, grouped under department headings.
 *
 * ## The shape, and why it is this one
 *
 * ```
 * الجلدية:
 * - علاج حب الشباب — 2500 TRY
 * - التقشير الكيميائي — 2000 TRY
 *
 * القلب:
 * - استشارة قلب — 1500 TRY
 * ```
 *
 * A heading per department, one service per line, the price on the same line
 * as the service it is the price of, and a blank line between departments.
 * Every one of those is a correction of something manual QA produced: the
 * catalog arrived as a single comma-separated paragraph in which no price was
 * attached to anything, and an earlier fix put the price on its own line, which
 * detached it just as thoroughly the moment two services sat next to each
 * other.
 *
 * No rule lines, no asterisks, no separators. On WhatsApp whitespace is the
 * only formatting that renders identically everywhere, and a row of dashes is
 * indistinguishable from a message that broke.
 *
 * Renders what it is given. A service with no configured price is listed
 * *without* one — silence is the honest rendering of an absent number, and a
 * price is the last thing that may be inferred.
 */
export function renderServiceGroups(
  groups: readonly {
    departmentName: string;
    services: readonly { name: string; price: number | null }[];
  }[],
  currency: string | null,
): string {
  return groups
    .map((group) => {
      const lines = group.services.map((service) => {
        const name = String(service.name).trim();
        if (service.price === null || !Number.isFinite(service.price)) {
          return `- ${name}`;
        }
        const price = currency
          ? `${service.price} ${currency}`
          : String(service.price);
        // An em dash, not a colon or a bracket: it reads as "this costs that"
        // in both scripts and survives right-to-left reordering intact.
        return `- ${name} — ${price}`;
      });
      return [`${String(group.departmentName).trim()}:`, ...lines].join("\n");
    })
    .join(SECTION_SEPARATOR);
}

/**
 * The package catalog, grouped under department headings.
 *
 * ```
 * الجلدية:
 * - باكيدج علاج حب الشباب — 4500 TRY
 * - باكيدج العناية بالبشرة — 6000 TRY
 *
 * العلاج الطبيعي:
 * - باكيدج التأهيل — 5000 TRY
 * ```
 *
 * Exactly the shape {@link renderServiceGroups} uses, and deliberately so: a
 * patient reading a price list and a package list in the same conversation —
 * often in the same message, for a compound question — should not have to learn
 * two layouts. Heading per department, one package per line, the price on the
 * line of the package it is the price of, blank line between departments, no
 * separator rules.
 *
 * ## Which price
 *
 * The package's **total** when the clinic configured one, because that is the
 * number a patient is deciding about. A clinic that configured only a
 * per-session price gets that, marked as such, and a clinic that configured
 * neither gets a line with no number on it. Nothing is multiplied out: a total
 * derived from `price_per_session × total_sessions` is a number this system
 * invented, and a patient would read it as the clinic's own quote.
 */
export function renderPackageGroups(
  groups: readonly {
    departmentName: string;
    packages: readonly {
      name: string;
      pricePerSession: number | null;
      totalPrice: number | null;
    }[];
  }[],
  currency: string | null,
  locale: Locale,
): string {
  return groups
    .map((group) => {
      const lines = group.packages.map(
        (entry) => `- ${packageLine(entry, currency, locale)}`,
      );
      return [`${String(group.departmentName).trim()}:`, ...lines].join("\n");
    })
    .join(SECTION_SEPARATOR);
}

/** One package, as a single line: the name, and the price when there is one. */
function packageLine(
  entry: {
    name: string;
    pricePerSession: number | null;
    totalPrice: number | null;
  },
  currency: string | null,
  locale: Locale,
): string {
  const name = String(entry.name).trim();
  const money = (value: number) =>
    currency ? `${value} ${currency}` : String(value);
  if (entry.totalPrice !== null && Number.isFinite(entry.totalPrice)) {
    return `${name} — ${money(entry.totalPrice)}`;
  }
  if (entry.pricePerSession !== null && Number.isFinite(entry.pricePerSession)) {
    const perSession = locale === "ar" ? "للجلسة" : "per session";
    return `${name} — ${money(entry.pricePerSession)} ${perSession}`;
  }
  return name;
}

/**
 * One package's own detail block, for «ايه اللي موجود في باكيدج X؟».
 *
 * ## Three shapes, one function
 *
 *   * **A department-only package** — no lines at all. Every package that
 *     exists before the item table does is this shape, and it renders exactly
 *     as it did: a department, a session count, a price, the clinic's note.
 *     There is deliberately still no branch that describes such a package's
 *     *contents*, because nothing stores them; inferring them from the
 *     package's name is the one thing that must never happen here.
 *   * **A single-service package** — one line, rendered as one line.
 *   * **A basket** — several lines, each with its own session count and its own
 *     package price per session, then the total beneath them:
 *
 *     ```
 *     باكيدج التأهيل:
 *     - جلسة إعادة تأهيل — 5 جلسات — 1300 TRY للجلسة
 *     - علاج الإصابات الرياضية — 3 جلسات — 1800 TRY للجلسة
 *
 *     إجمالي الباكيدج: 11900 TRY
 *     ```
 *
 * ## Every number here is stored
 *
 * A line's `pricePerSession` is the price the clinic agreed for that service
 * *inside this package* — never `services.price`, which is the catalogue price
 * and is not what the patient is being quoted. The total is the sum of the
 * lines' own subtotals and is computed from nothing else, so a patient reading
 * a per-line price and a total is reading two views of one set of stored
 * numbers rather than two independent claims. Service names are the clinic's
 * own authored localized names, resolved upstream in `readPublicPackages`.
 *
 * There is no line comparing a package price against the catalogue price. A
 * discount the clinic did not state is a discount this system invented.
 */
export function renderPackageDetail(
  entry: {
    name: string;
    departmentName: string;
    items?: readonly {
      serviceName: string;
      sessions: number;
      pricePerSession: number;
      subtotal: number;
    }[];
    totalSessions: number;
    pricePerSession: number | null;
    totalPrice: number | null;
    notes: string | null;
  },
  currency: string | null,
  locale: Locale,
): string {
  const label = locale === "ar"
    ? { department: "القسم", sessions: "عدد الجلسات", price: "السعر", perSession: "سعر الجلسة", details: "التفاصيل", packageTotal: "إجمالي الباكيدج", sessionsWord: "جلسات", sessionWord: "جلسة", each: "للجلسة" }
    : { department: "Department", sessions: "Sessions", price: "Price", perSession: "Price per session", details: "Details", packageTotal: "Package total", sessionsWord: "sessions", sessionWord: "session", each: "per session" };
  const money = (value: number) => (currency ? `${value} ${currency}` : String(value));
  const items = (entry.items ?? []).filter(
    (item) =>
      Number.isFinite(item.sessions) &&
      item.sessions > 0 &&
      Number.isFinite(item.pricePerSession),
  );

  const lines = [`${entry.name.trim()}:`, `${label.department}: ${entry.departmentName.trim()}`];

  if (items.length > 0) {
    // One dashed line per service, in the clinic's own order. `sessions` and
    // `pricePerSession` are printed as stored; nothing is rounded, converted or
    // completed here.
    for (const item of items) {
      const count = `${item.sessions} ${
        item.sessions === 1 ? label.sessionWord : label.sessionsWord
      }`;
      lines.push(
        `- ${item.serviceName.trim()} — ${count} — ${money(item.pricePerSession)} ${label.each}`,
      );
    }
    // The sum of the lines above, and only of those. A package whose stored
    // `total_price` disagrees with its own lines is not something to average
    // between or to pick a winner from: the lines are what the patient just
    // read, so the total is theirs.
    const total = items.reduce((sum, item) => sum + item.subtotal, 0);
    lines.push("");
    lines.push(`${label.packageTotal}: ${money(Math.round(total * 100) / 100)}`);
  } else {
    // The legacy, department-only package, unchanged.
    if (Number.isFinite(entry.totalSessions) && entry.totalSessions > 0) {
      lines.push(`${label.sessions}: ${entry.totalSessions}`);
    }
    if (entry.totalPrice !== null && Number.isFinite(entry.totalPrice)) {
      lines.push(`${label.price}: ${money(entry.totalPrice)}`);
    }
    if (entry.pricePerSession !== null && Number.isFinite(entry.pricePerSession)) {
      lines.push(`${label.perSession}: ${money(entry.pricePerSession)}`);
    }
  }

  const notes = typeof entry.notes === "string" ? entry.notes.trim() : "";
  // The clinic's own words, quoted. Untrusted, clinic-authored text: it is
  // rendered, never followed as an instruction.
  if (notes.length > 0) lines.push(`${label.details}: ${notes}`);
  return lines.join("\n");
}

/**
 * The accepted insurers, numbered, one per line.
 *
 * A numbered block rather than the dashed catalog shape: these are not options
 * grouped under anything, and «1- أكسا» is how the brief asks for them. It goes
 * through {@link renderChoiceList} so the numbering is the same numbering every
 * other list in the system uses — but nothing here is an *offer*, so no number
 * selects anything and the engine is never asked to resolve one against it.
 */
export function renderInsuranceList(labels: readonly string[]): string {
  return renderChoiceList(labels);
}

// ---------------------------------------------------------------------------
// The booking summary
// ---------------------------------------------------------------------------

/**
 * The fields a booking summary may carry, in the order a patient reads them.
 *
 * Order is data rather than a template so that a field the clinic did not
 * configure — no service chosen, no price on it — simply does not appear,
 * instead of leaving a labelled blank. `patient` is first and it is deliberate:
 * the single most important thing to get right on a third-party booking is
 * *whose* appointment this is, and burying it after the department is how a
 * sender confirms an appointment believing it is theirs.
 */
export const SUMMARY_FIELDS = [
  "patient",
  "department",
  "doctor",
  "day",
  "time",
  "service",
  "price",
] as const;

export type SummaryField = (typeof SUMMARY_FIELDS)[number];

const SUMMARY_LABELS: Readonly<Record<Locale, Record<SummaryField, string>>> = {
  ar: {
    patient: "المريض",
    department: "القسم",
    doctor: "الدكتور",
    day: "اليوم",
    time: "الوقت",
    service: "الخدمة",
    price: "السعر",
  },
  en: {
    patient: "Patient",
    department: "Department",
    doctor: "Doctor",
    day: "Day",
    time: "Time",
    service: "Service",
    price: "Price",
  },
};

/**
 * The booking summary body: one field per line, labelled, nothing else.
 *
 * ```
 * المريض: <اسم المريض>
 * القسم: <القسم>
 * الدكتور: <د. اسم الدكتور>
 * اليوم: الأربعاء — 09-09-2026
 * الوقت: 10:30 صباحًا
 * ```
 *
 * This is the last thing a patient reads before consenting to a write, so it
 * is the one message in the system that is optimised for *scanning* rather than
 * for sounding natural — which is also why the composer never hands it to the
 * polish pass. Three rules, all of them corrections of the single-line version
 * this replaces:
 *
 *   * one field per line, never several joined by commas;
 *   * no separator rules (`----`, `====`, `***`) — the line breaks already
 *     separate the fields, and a row of dashes reads as a rendering failure;
 *   * only values the server produced, and never an internal id or a canonical
 *     enum. Every value here is an offer label the patient has already been
 *     shown.
 */
export function renderSummary(
  values: Partial<Record<SummaryField, string | null | undefined>>,
  locale: Locale,
): string {
  const labels = SUMMARY_LABELS[locale];
  return SUMMARY_FIELDS.map((field) => {
    const value = values[field];
    if (typeof value !== "string" || value.trim().length === 0) return null;
    return `${labels[field]}: ${value.trim()}`;
  })
    .filter((line): line is string => line !== null)
    .join("\n");
}
