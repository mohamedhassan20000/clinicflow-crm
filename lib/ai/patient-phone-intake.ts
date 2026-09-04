/**
 * Reading a phone number a patient typed into WhatsApp, country and all.
 *
 * ## The defect this exists for
 *
 * Intake normalized every number against the clinic's own country and treated
 * the result as binary: `libphonenumber-js` either returned E.164 or it
 * returned null, and null became "I could not read that, send it again". Manual
 * QA (clinic configured in Türkiye) sent `3030308765156` and got the same blunt
 * re-ask, over and over, with no way for the patient to say what it actually
 * was. Two different problems were collapsed into one dead end:
 *
 *   * **A number from somewhere else.** A Kuwaiti patient typing their own
 *     local number is not making a mistake, and the clinic's country is the
 *     wrong lens to read it through. The fix is a question — *which country is
 *     this number from?* — not a rejection, and certainly not `+90` glued onto
 *     the front of it.
 *   * **A number with a digit missing or a digit too many.** Here the country
 *     is not in doubt at all; the digits are. The fix is to say so and let the
 *     patient confirm or correct.
 *
 * ## How the two are told apart
 *
 * By the national prefix, not by guesswork. A number written with a leading `0`
 * is written in *national* format: the patient is telling us it is a local
 * number, so a length that does not fit the clinic's country is a typo. A
 * number with no leading `0` and no country code says nothing about where it is
 * from, so the honest move is to ask.
 *
 * ## What this module will not do
 *
 * * It never invents, pads, truncates or reinterprets a digit. Every accepted
 *   value is `libphonenumber-js`'s own E.164 for a number it calls valid.
 * * It never prepends the clinic's country code to a number that country cannot
 *   parse. The clinic's country is the default *assumption*, and an assumption
 *   that fails becomes a question.
 * * It decides nothing about duplicates, linkage or privacy. It returns a
 *   reading; the caller applies the same intake rules it always did.
 */

import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
  type CountryCode,
} from "libphonenumber-js";
import { normalizeHumanText } from "@/lib/ai/human-input";
import { isPhoneCountry } from "@/lib/phone/registry";

export type PhoneIntakeReading =
  /** A real number. `e164` is the canonical form, produced by the parser. */
  | {
      status: "accepted";
      e164: string;
      country: CountryCode;
      /** Where the country came from. Never "the clinic's, because it had to be". */
      source: "international" | "clinic_country" | "stated_country";
    }
  /** Plausible digits, no country code, and not a number in the clinic's country. */
  | { status: "needs_country"; digits: string }
  /** Written as a local number, with the wrong number of digits. */
  | {
      status: "needs_confirmation";
      digits: string;
      problem: "too_short" | "too_long";
      country: CountryCode;
    }
  /** Not a phone number at all — letters, four digits, a date. */
  | { status: "unreadable" };

/** The shortest and longest a real international number can be (ITU E.164). */
const MIN_DIGITS = 6;
const MAX_DIGITS = 15;

/**
 * The digits, and nothing else.
 *
 * Arabic-Indic digits, spaces, dashes, parentheses and the bidi marks WhatsApp
 * inserts around an LTR number inside an RTL message all come out; a leading
 * `00` becomes `+`, which is the same number written the other way.
 */
function readDigits(input: string): { text: string; international: boolean } | null {
  const text = normalizeHumanText(input ?? "")
    .replace(/[​-‏‪-‮⁦-⁩]/g, "")
    .replace(/[()\-.\s]/g, "")
    .replace(/^00/, "+")
    .trim();
  if (!/^\+?\d{4,20}$/.test(text)) return null;
  return { text, international: text.startsWith("+") };
}

function lengthProblem(
  text: string,
  country?: CountryCode,
): "too_short" | "too_long" | null {
  const verdict = country
    ? validatePhoneNumberLength(text, country)
    : validatePhoneNumberLength(text);
  if (verdict === "TOO_SHORT") return "too_short";
  if (verdict === "TOO_LONG") return "too_long";
  return null;
}

/**
 * What this message says about a phone number.
 *
 * `clinicCountry` is the default assumption and only that. `statedCountry` is
 * the country the patient has just named, and when it is present it replaces
 * the assumption entirely — that is the whole point of having asked.
 */
export function readPatientPhone(
  raw: string | null | undefined,
  options: { clinicCountry?: string | null; statedCountry?: CountryCode | null } = {},
): PhoneIntakeReading {
  const digits = readDigits(raw ?? "");
  if (!digits) return { status: "unreadable" };
  const bare = digits.text.replace(/^\+/, "");
  if (bare.length < MIN_DIGITS || bare.length > MAX_DIGITS) {
    // Outside E.164 entirely. Still not silently rejected: the caller asks.
    return {
      status: "needs_confirmation",
      digits: digits.text,
      problem: bare.length < MIN_DIGITS ? "too_short" : "too_long",
      country: resolveCountry(options.statedCountry, options.clinicCountry),
    };
  }

  // A number the patient wrote with its own country code answers the country
  // question itself, whatever the clinic's country is and whatever they have
  // just told us. "+965…" is Kuwaiti because it says so.
  if (digits.international) {
    const parsed = parsePhoneNumberFromString(digits.text);
    if (parsed?.isValid() && parsed.country) {
      return {
        status: "accepted",
        e164: parsed.number,
        country: parsed.country,
        source: "international",
      };
    }
    const problem = lengthProblem(digits.text) ?? "too_short";
    return {
      status: "needs_confirmation",
      digits: digits.text,
      problem,
      country: resolveCountry(options.statedCountry, options.clinicCountry),
    };
  }

  const stated = options.statedCountry ?? null;
  const country = resolveCountry(stated, options.clinicCountry);
  const parsed = parsePhoneNumberFromString(digits.text, country);
  if (parsed?.isValid()) {
    return {
      status: "accepted",
      e164: parsed.number,
      country: parsed.country ?? country,
      source: stated ? "stated_country" : "clinic_country",
    };
  }

  // Written in national format — the patient is telling us it is a local
  // number of the country in play, so the country is settled and the digits
  // are what is wrong. Same when they have just named the country themselves.
  const nationalFormat = digits.text.startsWith("0") || stated !== null;
  const problem = lengthProblem(digits.text, country);
  if (nationalFormat) {
    return {
      status: "needs_confirmation",
      digits: digits.text,
      problem: problem ?? (bare.length > 11 ? "too_long" : "too_short"),
      country,
    };
  }
  // No country code, no national prefix, not a number here. Ask.
  return { status: "needs_country", digits: digits.text };
}

function resolveCountry(
  stated: CountryCode | null | undefined,
  clinicCountry: string | null | undefined,
): CountryCode {
  if (stated && isPhoneCountry(stated)) return stated;
  const upper = (clinicCountry ?? "").toUpperCase();
  return isPhoneCountry(upper) ? upper : "TR";
}

/**
 * The country names, in Arabic and English, indexed once.
 *
 * Built from `Intl.DisplayNames` over the countries `libphonenumber-js`
 * actually supports, rather than written out by hand: a hand-written list is a
 * list of the countries somebody thought of, and the patient is under no
 * obligation to be from one of them.
 */
const COUNTRY_NAME_INDEX: ReadonlyMap<string, CountryCode> = (() => {
  const index = new Map<string, CountryCode>();
  const arabic = new Intl.DisplayNames(["ar"], { type: "region" });
  const english = new Intl.DisplayNames(["en"], { type: "region" });
  const add = (name: string | undefined, code: CountryCode) => {
    if (!name) return;
    const key = normalizeHumanText(name).toLocaleLowerCase();
    if (key.length < 3 || index.has(key)) return;
    index.set(key, code);
  };
  for (const code of getCountries()) {
    add(english.of(code), code);
    const ar = arabic.of(code);
    add(ar, code);
    // "الكويت" is the display name; "كويت" is what people type.
    if (ar?.startsWith("ال")) add(ar.slice(2), code);
  }
  // The handful people say a different way. Aliases only — every one of these
  // resolves to a country the index already has.
  const aliases: ReadonlyArray<readonly [string, CountryCode]> = [
    ["türkiye", "TR"], ["turkiye", "TR"], ["turkey", "TR"], ["تركيا", "TR"], ["تركية", "TR"],
    ["uae", "AE"], ["emirates", "AE"], ["الامارات", "AE"], ["الإمارات", "AE"],
    ["ksa", "SA"], ["saudi", "SA"], ["السعودية", "SA"], ["السعوديه", "SA"],
    ["مصر", "EG"], ["egypt", "EG"],
    ["الكويت", "KW"], ["كويت", "KW"], ["kuwait", "KW"],
    ["قطر", "QA"], ["البحرين", "BH"], ["عمان", "OM"], ["الاردن", "JO"], ["الأردن", "JO"],
    ["لبنان", "LB"], ["سوريا", "SY"], ["العراق", "IQ"], ["فلسطين", "PS"],
    ["uk", "GB"], ["britain", "GB"], ["england", "GB"], ["usa", "US"], ["america", "US"],
  ];
  for (const [name, code] of aliases) {
    index.set(normalizeHumanText(name).toLocaleLowerCase(), code);
  }
  return index;
})();

/** Dial codes, longest first, so `+966` is never read as `+96`. */
const DIAL_CODES: ReadonlyArray<readonly [string, CountryCode]> = (() => {
  const pairs: Array<readonly [string, CountryCode]> = [];
  for (const code of getCountries()) {
    try {
      pairs.push([getCountryCallingCode(code), code] as const);
    } catch {
      // A country with no calling code cannot be named by one.
    }
  }
  return pairs.sort((left, right) => right[0].length - left[0].length);
})();

/**
 * The country this message names, or null.
 *
 * Answers «الرقم تابع لأي دولة؟» — a country name in Arabic or English, or the
 * dial code itself ("+965", "965"). Null means the message did not say, which
 * is the caller's cue to keep waiting rather than to assume.
 */
export function readStatedPhoneCountry(
  input: string | null | undefined,
): CountryCode | null {
  const text = normalizeHumanText(input ?? "").toLocaleLowerCase().trim();
  if (!text || text.length > 120) return null;
  // A dial code is only a country when it is written as one — "+965" or a bare
  // "965". A long digit string is a phone number, not an answer about a country.
  const dial = /^\+?(\d{1,4})$/.exec(text.replace(/[\s\-()]/g, ""));
  if (dial) {
    const match = DIAL_CODES.find(([code]) => code === dial[1]);
    if (match) return match[1];
  }
  for (const [name, code] of COUNTRY_NAME_INDEX) {
    if (text === name) return code;
  }
  // Inside a sentence — "الرقم ده كويتي", "it's from Kuwait". Longest name
  // first so "السعودية" is not shadowed by a shorter name inside it.
  const names = [...COUNTRY_NAME_INDEX.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (name.length >= 4 && text.includes(name)) return COUNTRY_NAME_INDEX.get(name)!;
  }
  return null;
}
