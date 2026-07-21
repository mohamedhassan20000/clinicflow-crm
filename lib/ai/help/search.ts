import "server-only";

import { normalizeSearchText, transliterateQuery } from "@/lib/ai/entity-search";
import {
  HELP_ARTICLES,
  type HelpArticle,
  type HelpArticleContent,
} from "@/lib/ai/help/corpus";
import {
  resolveNavigationTargets,
  type NavigationResolution,
} from "@/lib/ai/help/navigation";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { hasAiUserPermission } from "@/lib/ai/permissions";
import type { AuthedUser } from "@/lib/rbac";
import type { PromptLocale } from "@/lib/ai/prompts/doctor";

/**
 * Deterministic retrieval over the curated help corpus (P4.7A).
 *
 * There is no embedding model and no index here on purpose. The corpus is a few
 * dozen curated articles, so exact normalized-token scoring is both sufficient
 * and *auditable*: a test can assert that a given query returns a given article,
 * which is the property that keeps the phase's central promise — the assistant
 * answers only from this corpus — verifiable rather than aspirational.
 *
 * Matching reuses the P4.6C Arabic/English normalizer, so a query typed with
 * diacritics, alef/taa-marbuta variants, Arabic-Indic digits, or in Latin
 * transliteration reaches the same article as the canonical spelling.
 */

/** Field weights. Title and keywords are what an author curates for retrieval. */
const WEIGHT_TITLE = 6;
const WEIGHT_KEYWORD = 5;
const WEIGHT_SUMMARY = 2;
const WEIGHT_BODY = 1;

/**
 * The floor a match must clear to count as an answer.
 *
 * Set above a single body-field hit on purpose. The step text mentions ordinary
 * words — "email", "save", "date" — that a semantically unrelated question can
 * brush against ("email the report to the ministry" grazes the invoicing
 * article's "deliver the invoice by email"). One incidental body word is not a
 * reason to present an article as the answer, and surfacing it anyway is exactly
 * the confident-but-wrong retrieval this phase exists to prevent. A real query
 * lands on a curated keyword, the title, or several words at once, all of which
 * clear this comfortably.
 */
const MIN_SCORE = WEIGHT_BODY + WEIGHT_SUMMARY;

/**
 * Tokens too common in help phrasing to discriminate between articles. Scoring
 * them rewards every article equally and lets a long question drown the one
 * distinguishing word.
 */
const STOP_TOKENS = new Set([
  // English
  "how", "do", "i", "a", "an", "the", "to", "in", "on", "of", "for", "is", "it",
  "can", "my", "me", "we", "you", "what", "where", "when", "and", "or", "with",
  "from", "at", "this", "that", "clinic", "clinicflow", "please", "help",
  // Arabic
  "كيف", "هل", "ما", "ماذا", "اين", "متى", "في", "من", "الى", "على", "عن",
  "مع", "هذا", "هذه", "التي", "الذي", "ان", "او", "و", "يمكن", "اريد", "لو",
  "سمحت", "العياده", "العيادة", "كلينيك", "فلو",
]);

function tokenize(value: string): string[] {
  return normalizeSearchText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_TOKENS.has(token));
}

/**
 * Query tokens, plus the transliterated variant when the query crosses scripts.
 *
 * An Arabic query against an English-authored keyword (and the reverse) would
 * otherwise score zero regardless of how well it matches semantically.
 *
 * Transliteration runs over the **content tokens only**, not the raw query. A
 * question like "how do I…" is entirely stop tokens, and transliterating those
 * produces Arabic character-strings that then match Arabic keywords by accident
 * — the failure mode being an all-stopword query returning a confident wrong
 * article. Stripping stop tokens first means only meaningful words get a
 * cross-script variant, and a query with no meaningful words yields no tokens
 * at all.
 */
function queryTokens(query: string): Set<string> {
  const contentTokens = tokenize(query);
  const tokens = new Set(contentTokens);
  const transliterated = transliterateQuery(contentTokens.join(" "));
  if (transliterated) {
    for (const token of tokenize(transliterated)) tokens.add(token);
  }
  return tokens;
}

function scoreField(tokens: ReadonlySet<string>, text: string, weight: number): number {
  const fieldTokens = new Set(tokenize(text));
  let hits = 0;
  for (const token of tokens) {
    if (fieldTokens.has(token)) hits += 1;
  }
  return hits * weight;
}

/**
 * Scores one article against the query in **both** locales.
 *
 * Deliberate: a receptionist working in the Arabic UI may still type "invoice",
 * and an English-locale user may type an Arabic patient-facing term. Retrieval
 * matches across both language fields; only the *rendered answer* is
 * locale-specific.
 */
function scoreArticle(tokens: ReadonlySet<string>, article: HelpArticle): number {
  let score = 0;
  for (const content of [article.en, article.ar]) {
    score += scoreField(tokens, content.title, WEIGHT_TITLE);
    score += scoreField(tokens, content.keywords.join(" "), WEIGHT_KEYWORD);
    score += scoreField(tokens, content.summary, WEIGHT_SUMMARY);
    score += scoreField(
      tokens,
      [...content.steps, ...content.prerequisites, ...content.notes].join(" "),
      WEIGHT_BODY,
    );
  }
  return score;
}

export type HelpSearchResult = {
  article_id: string;
  title: string;
  summary: string;
  prerequisites: readonly string[];
  steps: readonly string[];
  notes: readonly string[];
  /** Where the workflow lives, e.g. "Settings → Messaging". Always present. */
  section: string;
  /** Deep link — present only when the caller can actually open the page. */
  link?: string;
  /**
   * Why there is no link, when there is none. A page hidden by the clinic admin,
   * a primary-admin-only workflow requested by a secondary admin, or a failed
   * authority lookup is named but never taught; other denials remove the
   * article entirely.
   */
  unavailable_reason?:
    | "hidden_by_admin"
    | "primary_admin_required"
    | "lookup_failed";
  /** Model-facing instruction for the unavailable case. */
  guidance?: string;
};

const UNAVAILABLE_GUIDANCE = {
  hidden_by_admin:
    "This page has been turned off for this user by their clinic administrator. Tell them the feature exists and where it lives, that it is not enabled for their account, and that their clinic administrator controls this under Settings → Customize. Do not give them the URL and do not describe the steps as something they can do right now.",
  primary_admin_required:
    "This workflow is reserved for the clinic's primary administrator. Tell this secondary administrator that the feature exists and where it lives, but that the clinic's primary administrator must handle it. Do not give them the URL and do not describe the steps as something they can do right now.",
  lookup_failed:
    "This user's access to that page could not be verified, so it must be treated as unavailable. Tell them you could not confirm their access and to try again shortly. Do not give them the URL.",
} as const;

/**
 * Which articles this user may see at all.
 *
 * Three of the four filters remove the article **without a trace**, and that is
 * the security-relevant decision of this module:
 *
 *  - `roles` — a workflow outside the caller's role is not something they can be
 *    guided toward, ever. Naming it would disclose the shape of other roles'
 *    surfaces to no useful end, since no action they take can unlock it.
 *  - `requiredFeatures` — a module or premium capability the clinic has not
 *    bought must not be described. Describing it turns the assistant into a
 *    tour of functionality the user cannot reach, which the phase brief
 *    explicitly forbids ("never expose … disabled modules, or premium-only
 *    functionality").
 *  - `requiredUserPermission` — same argument at per-user granularity.
 *
 * The fourth case, a page the administrator hid for this specific user, is
 * different and is deliberately *not* silent: the user has a real, actionable
 * remedy (ask their administrator), and the honest answer — "that exists, it
 * lives here, it is not enabled for you" — is the headline acceptance criterion
 * of this phase. It is handled downstream in {@link searchHelp}, where the
 * article is returned with its section but with no steps and no link.
 */
async function filterArticlesForUser(
  user: AuthedUser,
  articles: readonly HelpArticle[],
): Promise<HelpArticle[]> {
  const roleMatched = articles.filter((article) => article.roles.includes(user.role));

  const needsEntitlements = roleMatched.some(
    (article) => article.requiredFeatures?.length,
  );
  const entitlements = needsEntitlements ? await getEntitlements(user.clinicId) : null;

  const featureMatched = roleMatched.filter((article) => {
    if (!article.requiredFeatures?.length) return true;
    if (!entitlements?.subscriptionAllowed) return false;
    return article.requiredFeatures.every((feature) => hasFeature(entitlements, feature));
  });

  // Resolve each distinct permission once rather than per article.
  const permissionKeys = [
    ...new Set(
      featureMatched
        .map((article) => article.requiredUserPermission)
        .filter((key): key is NonNullable<typeof key> => Boolean(key)),
    ),
  ];
  const granted = new Map(
    await Promise.all(
      permissionKeys.map(
        async (key) => [key, await hasAiUserPermission(user, key)] as const,
      ),
    ),
  );

  return featureMatched.filter(
    (article) =>
      !article.requiredUserPermission || granted.get(article.requiredUserPermission) === true,
  );
}

function render(
  article: HelpArticle,
  locale: PromptLocale,
  navigation: NavigationResolution | undefined,
): HelpSearchResult | null {
  const content: HelpArticleContent = article[locale];
  const section = navigation?.breadcrumb ?? content.title;

  if (!navigation || navigation.status === "available") {
    return {
      article_id: article.id,
      title: content.title,
      summary: content.summary,
      prerequisites: content.prerequisites,
      steps: content.steps,
      notes: content.notes,
      section,
      ...(navigation?.href ? { link: navigation.href } : {}),
    };
  }

  if (
    navigation.status === "hidden_by_admin" ||
    navigation.status === "primary_admin_required" ||
    navigation.status === "lookup_failed"
  ) {
    // Named, not taught. The user learns the feature exists and who can enable
    // it — and gets neither the URL nor a set of steps presented as actionable.
    return {
      article_id: article.id,
      title: content.title,
      summary: content.summary,
      prerequisites: [],
      steps: [],
      notes: [],
      section,
      unavailable_reason: navigation.status,
      guidance: UNAVAILABLE_GUIDANCE[navigation.status],
    };
  }

  // `role_forbidden` / `not_entitled` reaching here means the article's own
  // declarations disagreed with its destination's. Drop it: the navigation
  // registry is the stricter authority, and a disagreement is a corpus bug, not
  // a reason to answer. A test asserts this case is unreachable in the shipped
  // corpus.
  return null;
}

export type HelpSearchOptions = {
  query: string;
  locale: PromptLocale;
  limit?: number;
};

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 5;

export async function searchHelp(
  user: AuthedUser,
  { query, locale, limit = DEFAULT_LIMIT }: HelpSearchOptions,
): Promise<HelpSearchResult[]> {
  const authorized = await filterArticlesForUser(user, HELP_ARTICLES);
  if (authorized.length === 0) return [];

  const tokens = queryTokens(query);
  if (tokens.size === 0) return [];

  const ranked = authorized
    .map((article) => ({ article, score: scoreArticle(tokens, article) }))
    .filter((candidate) => candidate.score >= MIN_SCORE)
    .sort(
      (a, b) =>
        // Ties broken by article id so results are stable across processes —
        // an unstable order would make the retrieval fixtures flaky and, worse,
        // make the same question answerable differently on two requests.
        b.score - a.score || a.article.id.localeCompare(b.article.id),
    )
    .slice(0, Math.min(Math.max(limit, 1), MAX_LIMIT));

  if (ranked.length === 0) return [];

  const navigation = await resolveNavigationTargets(
    user,
    ranked.map((candidate) => candidate.article.navigationTarget),
    locale,
  );

  return ranked
    .map((candidate) =>
      render(candidate.article, locale, navigation.get(candidate.article.navigationTarget)),
    )
    .filter((result): result is HelpSearchResult => result !== null);
}
