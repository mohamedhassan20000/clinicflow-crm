/**
 * P2C — the landing page's animated statistics band.
 *
 * ## These are provisional pre-launch display values. They are not verified customer metrics.
 *
 * ClinicFlow is in invite-only early access. The figures below were set by the founder for the
 * current pre-launch presentation of the marketing site and **must never be presented, captioned,
 * or described as verified live customer numbers** — no "trusted by", no "join 30 clinics already
 * using ClinicFlow", no implied audit. The surrounding copy is deliberately neutral for that reason,
 * and the section's own note says so on the page.
 *
 * They live here, alone, so that replacing them with real production data later is a one-file edit
 * with no hunt through components: change `value` and nothing else moves. The *labels* are in
 * `messages/{en,ar}.json` under `marketing.stats.items`, because those are copy and need Arabic.
 *
 * The one genuinely live number on this page is the weekly early-access cohort progress, which is
 * read from `get_public_registration_status()` at request time (§3.2) and is not part of this band.
 */

export type MarketingStat = {
  /** Message-file key under `marketing.stats.items` — pairs the value with its translated label. */
  id: "clinics" | "professionals" | "countries";
  /** The number the counter animates up to from zero. */
  value: number;
  /** Rendered verbatim after the number, in both locales (e.g. a plus sign). Empty for none. */
  suffix: string;
};

export const MARKETING_STATS: readonly MarketingStat[] = [
  { id: "clinics", value: 30, suffix: "+" },
  { id: "professionals", value: 100, suffix: "+" },
  { id: "countries", value: 7, suffix: "" },
];

/** How long the count-up runs, in ms. Ignored entirely under `prefers-reduced-motion: reduce`. */
export const STAT_COUNT_DURATION_MS = 1600;
