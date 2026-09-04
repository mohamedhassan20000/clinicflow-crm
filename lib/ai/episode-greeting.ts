import { normalizeHumanText } from "@/lib/ai/human-input";

/**
 * P11S — the opening of a conversation episode, said once and said properly.
 *
 * ## Why this is not prompt text
 *
 * The prompt already asked the model to "briefly introduce yourself as the
 * clinic assistant" on a fresh episode. That produced an introduction most of
 * the time, which is the problem: a patient's first contact with a clinic is
 * the one sentence that must not be probabilistic. It has to name the clinic,
 * say plainly that this is an automated assistant, and — when the patient has
 * asked for nothing yet — offer the two things it can do. A model that omits
 * any of those on one turn in ten is a clinic introducing itself badly to one
 * patient in ten.
 *
 * So the opening is composed here, from the clinic's own name, and the reply
 * path prepends it to the first assistant message of every episode.
 *
 * ## What "a new episode" means
 *
 * Exactly one thing, and it is already a fact the reply path holds: **no
 * outbound message exists inside the current episode**. Because
 * `ai_context_reset_at` bounds that read (P11O), this is true both for a sender
 * writing to the clinic for the first time and for a Done thread that has just
 * received a new inbound message. There is no separate "first ever" case and
 * no flag to keep in step with the transcript.
 *
 * ## The two shapes
 *
 * The requirement is explicit that a greeting must not cost the patient a turn.
 * So:
 *
 *   * **The inbound is a bare greeting** ("السلام عليكم", "hi") — there is
 *     nothing else to answer, so the opening *is* the reply: welcome,
 *     introduction, and the offer to book or ask.
 *   * **The inbound carries a request** ("السلام عليكم، عايز أعرف عنوانكم") —
 *     the opening is a short prefix and the turn's real answer follows it in
 *     the same message. No offer line: the patient has already said what they
 *     want, and asking again would be the redundant turn this avoids.
 *
 * An Islamic greeting is answered the way it is answered, before anything else.
 * That is not decoration; "السلام عليكم" has one correct reply and a clinic
 * that does not give it sounds like a machine that did not listen.
 */

export type EpisodeGreetingLocale = "ar" | "en";

/** `وعليكم السلام…` — the required response, not an optional flourish. */
const ISLAMIC_RESPONSE: Record<EpisodeGreetingLocale, string> = {
  ar: "وعليكم السلام ورحمة الله وبركاته 🌿",
  en: "Wa alaykum assalam wa rahmatullahi wa barakatuh.",
};

const WELCOME_WITH_CLINIC: Record<EpisodeGreetingLocale, (clinic: string) => string> = {
  ar: (clinic) => `أهلًا وسهلًا بك في ${clinic} 👋`,
  en: (clinic) => `Welcome to ${clinic} 👋`,
};

/** Used only when the clinic record carries no usable name. */
const WELCOME_WITHOUT_CLINIC: Record<EpisodeGreetingLocale, string> = {
  ar: "أهلًا وسهلًا بك 👋",
  en: "Welcome 👋",
};

const INTRODUCTION: Record<EpisodeGreetingLocale, string> = {
  ar: "أنا المساعد الآلي للعيادة، تحت أمرك.",
  en: "I'm the clinic's automated assistant, here to help.",
};

const OFFER: Record<EpisodeGreetingLocale, string> = {
  ar: "تحب تحجز موعد، ولا عندك استفسار آخر؟",
  en: "Would you like to book an appointment, or do you have another question?",
};

/**
 * The Islamic greeting, in the spellings people actually type.
 *
 * Matched anywhere in the message rather than only at the start: "ازيك، السلام
 * عليكم" is still a salam and still has one correct answer.
 */
const ISLAMIC_GREETING = /(?:السلام\s*عليكم|سلام\s*عليكم|assalamu?\s*alaikum|assalam\s*alaykum|salam\s*alaykum|salamu?\s*alaikum)/i;

/**
 * Everything a message can consist of and still be "hello and nothing else".
 *
 * Deliberately a whitelist of whole tokens rather than a prefix test: a message
 * that contains a greeting *and* a request is not a bare greeting, and treating
 * it as one is exactly the wasted turn this module exists to prevent.
 */
const GREETING_TOKENS: readonly string[] = [
  // Arabic
  "السلام", "عليكم", "ورحمه", "ورحمة", "الله", "وبركاته", "سلام", "اهلا", "أهلا",
  "اهلين", "مرحبا", "مرحبتين", "هلا", "صباح", "مساء", "الخير", "النور", "ازيك",
  "ازيكم", "عامل", "ايه", "كيفك", "شلونك", "السلام،", "حياك", "حياكم", "يا",
  "دكتور", "دكتورة", "عيادة", "لو", "سمحت", "بعد", "اذنك", "إذنك",
  // English / transliteration
  "hi", "hello", "hey", "heya", "yo", "greetings", "good", "morning", "evening",
  "afternoon", "salam", "salaam", "assalamualaikum", "assalam", "alaikum",
  "alaykum", "wa", "rahmatullahi", "barakatuh", "there", "please",
];

const GREETING_SET = new Set(GREETING_TOKENS);

function normalize(raw: string | null | undefined): string {
  return normalizeHumanText(raw ?? "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the patient opened with `السلام عليكم` in any ordinary spelling. */
export function detectIslamicGreeting(raw: string | null | undefined): boolean {
  const text = normalizeHumanText(raw ?? "");
  return text.length > 0 && ISLAMIC_GREETING.test(text);
}

/**
 * True when the message is a greeting and carries no request of its own.
 *
 * A message with even one word outside the greeting vocabulary — "عنوانكم",
 * "احجز", "price" — is a request wearing a greeting, and gets the short prefix
 * rather than the offer.
 */
export function isBareGreeting(raw: string | null | undefined): boolean {
  const text = normalize(raw);
  if (!text) return false;
  const words = text.split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 10) return false;
  if (!words.some((word) => GREETING_SET.has(word))) return false;
  return words.every((word) => GREETING_SET.has(word));
}

export type EpisodeOpeningInput = {
  locale: EpisodeGreetingLocale;
  /** The clinic's own name, exactly as the clinic wrote it. Never invented. */
  clinicName: string | null;
  /** The patient's first message of this episode. */
  latestPatientText: string | null;
};

/**
 * The opening lines for the first assistant message of an episode.
 *
 * `standalone` says whether the caller should use this *as* the reply (the
 * patient said only hello) or prefix it to the turn's own answer.
 */
export function buildEpisodeOpening(input: EpisodeOpeningInput): {
  text: string;
  standalone: boolean;
} {
  const clinic = input.clinicName?.trim();
  const lines: string[] = [];
  if (detectIslamicGreeting(input.latestPatientText)) {
    lines.push(ISLAMIC_RESPONSE[input.locale]);
  }
  lines.push(
    clinic ? WELCOME_WITH_CLINIC[input.locale](clinic) : WELCOME_WITHOUT_CLINIC[input.locale],
  );
  lines.push(INTRODUCTION[input.locale]);
  const standalone = isBareGreeting(input.latestPatientText);
  if (standalone) lines.push(OFFER[input.locale]);
  return { text: lines.join("\n"), standalone };
}

/**
 * Puts the opening on this turn's reply.
 *
 * Returns the reply unchanged when there is nothing to open — the caller has
 * already decided this is a new episode, so the only case handled here is the
 * one where the reply is empty.
 */
export function applyEpisodeOpening(
  input: EpisodeOpeningInput & { replyText: string },
): string {
  const opening = buildEpisodeOpening(input);
  const reply = input.replyText.trim();
  if (!reply || opening.standalone) return opening.text;
  return `${opening.text}\n\n${reply}`;
}

/** Exported for the tests and for anything that needs to recognise the copy. */
export const EPISODE_OPENING_COPY = {
  islamicResponse: ISLAMIC_RESPONSE,
  introduction: INTRODUCTION,
  offer: OFFER,
} as const;
