import "server-only";

/**
 * Deterministic entity-search helpers shared by assistant search tools (P4.6C).
 *
 * The database is authoritative for matching and ranking
 * (`normalize_search_text` / `search_patients_ranked` in migration
 * 20260720120000): these helpers only prepare query variants (normalization +
 * ar/en transliteration) and classify the returned scores into confidence
 * levels. The language model never guesses matches from raw data — it receives
 * ranked candidates plus server-computed confidence metadata.
 */

const ARABIC_DIACRITICS = /[ً-ْـ]/g;
const ARABIC_INDIC_DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};
const ARABIC_LETTER_FOLDS: Record<string, string> = {
  "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا",
  "ة": "ه", "ى": "ي", "ؤ": "و", "ئ": "ي",
};

/** TS mirror of SQL `normalize_search_text` (kept in behavioral parity by tests). */
export function normalizeSearchText(value: string): string {
  const folded = value
    .toLowerCase()
    .replace(ARABIC_DIACRITICS, "")
    .replace(/./gu, (ch) => ARABIC_LETTER_FOLDS[ch] ?? ARABIC_INDIC_DIGITS[ch] ?? ch);
  return folded
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** TS mirror of SQL `normalize_phone`: digits only, Arabic-Indic digits mapped. */
export function normalizePhoneDigits(value: string): string {
  return value
    .replace(/./g, (ch) => ARABIC_INDIC_DIGITS[ch] ?? ch)
    .replace(/[^0-9]/g, "");
}

/**
 * Common Arabic given/family names keyed by their normalized Arabic form, each
 * with normalized Latin transliteration variants. Deterministic and curated —
 * token lookup first, generic character mapping as fallback.
 */
const NAME_MAP: Record<string, string[]> = {
  "محمد": ["mohamed", "muhammad", "mohammad", "mohammed", "muhammed", "mohamad"],
  "احمد": ["ahmed", "ahmad"],
  "حسن": ["hassan", "hasan"],
  "حسين": ["hussein", "hussain", "husain", "hossein"],
  "علي": ["ali", "aly"],
  "عمر": ["omar", "umar", "amr"],
  "عثمان": ["othman", "osman", "uthman"],
  "خالد": ["khaled", "khalid"],
  "ابراهيم": ["ibrahim", "ebrahim", "brahim"],
  "يوسف": ["youssef", "yousef", "yusuf", "yossef", "joseph"],
  "عبدالله": ["abdullah", "abdallah", "abdulla"],
  "عبدالرحمن": ["abdulrahman", "abdelrahman", "abdurrahman"],
  "عبدالعزيز": ["abdulaziz", "abdelaziz"],
  "مصطفى": ["mostafa", "mustafa", "moustafa"],
  "محمود": ["mahmoud", "mahmud", "mahmood"],
  "سالم": ["salem", "salim"],
  "سعيد": ["saeed", "said", "sayed"],
  "سيد": ["sayed", "sayyid", "sid"],
  "طارق": ["tarek", "tariq", "tarik"],
  "فهد": ["fahad", "fahd"],
  "فيصل": ["faisal", "faysal", "feisal"],
  "ماجد": ["majed", "majid"],
  "ناصر": ["nasser", "naser"],
  "سلطان": ["sultan", "soltan"],
  "بدر": ["badr", "bader"],
  "جاسم": ["jassim", "jasem", "jasim"],
  "مبارك": ["mubarak", "mbarak"],
  "منصور": ["mansour", "mansoor", "mansur"],
  "وليد": ["walid", "waleed"],
  "زياد": ["ziad", "zeyad", "ziyad"],
  "كريم": ["karim", "kareem"],
  "شريف": ["sherif", "sharif", "shareef"],
  "سامي": ["sami", "samy"],
  "رامي": ["rami", "ramy"],
  "هاني": ["hani", "hany"],
  "عادل": ["adel", "adil"],
  "ايمن": ["ayman", "aymen"],
  "حمد": ["hamad", "hamed"],
  "حامد": ["hamed", "hamid"],
  "جمال": ["gamal", "jamal", "jammal"],
  "فاطمة": ["fatima", "fatma", "fatema", "fatimah"],
  "فاطمه": ["fatima", "fatma", "fatema", "fatimah"],
  "عائشة": ["aisha", "aysha", "aicha"],
  "عائشه": ["aisha", "aysha", "aicha"],
  "مريم": ["mariam", "maryam", "meryem"],
  "سارة": ["sara", "sarah"],
  "ساره": ["sara", "sarah"],
  "نور": ["nour", "noor", "nur"],
  "نورة": ["noura", "nora", "norah"],
  "نوره": ["noura", "nora", "norah"],
  "هدى": ["huda", "hoda"],
  "منى": ["mona", "muna"],
  "ليلى": ["laila", "layla", "leila"],
  "دانة": ["dana", "danah"],
  "دانه": ["dana", "danah"],
  "ريم": ["reem", "rim"],
  "شيخة": ["shaikha", "sheikha"],
  "شيخه": ["shaikha", "sheikha"],
  "امل": ["amal", "aml"],
  "ايمان": ["iman", "eman", "emaan"],
  "خديجة": ["khadija", "khadijah", "khadeeja"],
  "خديجه": ["khadija", "khadijah", "khadeeja"],
  "زينب": ["zainab", "zeinab", "zaynab"],
};

/**
 * The curated Latin readings of one Arabic name part, conventional spelling
 * first, or null when the table does not know it.
 *
 * Exported for `name-transliteration.ts`, which needs exactly this distinction:
 * a name part the table knows can be transliterated onto a patient file without
 * asking, and one it does not know can only ever be *proposed*.
 */
export function arabicNameVariants(part: string): readonly string[] | null {
  const key = normalizeSearchText(part);
  return NAME_MAP[key] ?? null;
}

const LATIN_TO_ARABIC_TOKEN: Record<string, string> = Object.fromEntries(
  Object.entries(NAME_MAP).flatMap(([arabic, variants]) =>
    variants.map((variant) => [variant, arabic]),
  ),
);

/** Ordered digraph-first fallback mapping for unmapped Latin tokens. */
const LATIN_TO_ARABIC_CHARS: Array<[string, string]> = [
  ["kh", "خ"], ["sh", "ش"], ["th", "ث"], ["dh", "ذ"], ["gh", "غ"],
  ["aa", "ا"], ["ee", "ي"], ["oo", "و"], ["ou", "و"], ["ai", "ي"], ["ei", "ي"],
  ["b", "ب"], ["t", "ت"], ["j", "ج"], ["g", "ج"], ["h", "ه"], ["d", "د"],
  ["r", "ر"], ["z", "ز"], ["s", "س"], ["f", "ف"], ["q", "ق"], ["k", "ك"],
  ["l", "ل"], ["m", "م"], ["n", "ن"], ["w", "و"], ["y", "ي"], ["p", "ب"],
  ["v", "ف"], ["c", "ك"], ["x", "كس"], ["e", ""], ["i", ""], ["o", ""], ["u", ""],
];

const ARABIC_TO_LATIN_CHARS: Record<string, string> = {
  "ا": "a", "ب": "b", "ت": "t", "ث": "th", "ج": "j", "ح": "h", "خ": "kh",
  "د": "d", "ذ": "dh", "ر": "r", "ز": "z", "س": "s", "ش": "sh", "ص": "s",
  "ض": "d", "ط": "t", "ظ": "z", "ع": "a", "غ": "gh", "ف": "f", "ق": "q",
  "ك": "k", "ل": "l", "م": "m", "ن": "n", "ه": "h", "و": "w", "ي": "y",
  "ء": "", "لا": "la",
};

const ARABIC_SCRIPT = /[؀-ۿ]/;

function latinTokenToArabic(token: string): string {
  const mapped = LATIN_TO_ARABIC_TOKEN[token];
  if (mapped) return mapped;
  let rest = token;
  let out = "";
  // Word-initial vowel is a real alef; later short vowels are dropped.
  if (/^[aeiou]/.test(rest) && !rest.startsWith("aa")) {
    out += "ا";
    rest = rest.slice(1);
  }
  outer: while (rest.length > 0) {
    for (const [latin, arabic] of LATIN_TO_ARABIC_CHARS) {
      if (rest.startsWith(latin)) {
        out += arabic;
        rest = rest.slice(latin.length);
        continue outer;
      }
    }
    rest = rest.slice(1);
  }
  return out;
}

function arabicTokenToLatin(token: string): string {
  const variants = NAME_MAP[token];
  if (variants) return variants[0];
  let out = "";
  for (const ch of token) {
    out += ARABIC_TO_LATIN_CHARS[ch] ?? ch;
  }
  return out;
}

/**
 * Produces the cross-script variant of a name query (Latin → Arabic script or
 * Arabic → Latin), or null when there is nothing useful to add (numeric
 * queries, empty input, or a variant identical to the input).
 */
export function transliterateQuery(raw: string): string | null {
  const normalized = normalizeSearchText(raw);
  if (!normalized || /^[0-9 ]+$/.test(normalized)) return null;
  const tokens = normalized.split(" ");
  const variant = tokens
    .map((token) =>
      ARABIC_SCRIPT.test(token) ? arabicTokenToLatin(token) : latinTokenToArabic(token),
    )
    .filter((token) => token.length > 0)
    .join(" ");
  if (!variant || variant === normalized) return null;
  return variant;
}

export type SearchConfidence = "high" | "medium" | "low";

const HIGH_SCORE = 0.65;
const HIGH_LEAD = 0.2;
const MEDIUM_SCORE = 0.35;

/**
 * Classifies ranked scores (descending) into a clarification decision. "high"
 * requires both a strong top score and a clear lead over the runner-up, so two
 * equally likely candidates (e.g. namesakes) always force a clarification.
 */
export function classifyConfidence(scores: number[]): SearchConfidence {
  if (scores.length === 0) return "low";
  const [top, second] = scores;
  if (top >= HIGH_SCORE && (scores.length === 1 || top - (second ?? 0) >= HIGH_LEAD)) {
    return "high";
  }
  return top >= MEDIUM_SCORE ? "medium" : "low";
}
