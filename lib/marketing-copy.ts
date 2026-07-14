import type { MessageTranslator } from "@/lib/i18n/translator";

export const MARKETING_SITE_URL = "https://clinicflow.fit";

/**
 * P2C — the marketing copy, now sourced from `messages/{en,ar}.json` under the `marketing` and
 * `legal` namespaces.
 *
 * The shape below is unchanged from the P1.5C/Pre-P2 literal object, deliberately: every consumer
 * (`marketing-page.tsx`, `legal-page.tsx`, the mobile menu) keeps reading `copy.hero.title` exactly
 * as before. Only the *source* of each string moved. That is what let a 500-line page and a
 * fully-approved visual design pick up Arabic without a redesign.
 *
 * Two things stay in code on purpose:
 *   - **Asset paths** (`/marketing/*.avif`) — an image is not copy, and a translator must never be
 *     able to point the page at a file that does not exist.
 *   - **The workflow clock times** — `08:00` … `17:30` are a visual rhythm through the clinic day,
 *     not sentences. They are digit-shaped by the locale formatter at render, not translated.
 *
 * Numbers are interpolated as **pre-formatted strings**, never as ICU numbers: digit shaping is
 * owned by `lib/datetime.ts` (§4.4 — Latin digits by default, Arabic-Indic per clinic toggle), and
 * handing a raw number to ICU would let the message layer silently impose its own numbering system.
 */

/** The four product workflows, in clinic-day order. Text is translated; images are not. */
const WORKFLOW_IDS = ["schedule", "frontDesk", "patientRecord", "reports"] as const;

const WORKFLOW_ASSETS: Record<
  (typeof WORKFLOW_IDS)[number],
  { time: string; desktop: string; mobile: string }
> = {
  schedule: {
    time: "08:00",
    desktop: "/marketing/schedule-desktop.avif",
    mobile: "/marketing/schedule-mobile.avif",
  },
  frontDesk: {
    time: "09:30",
    desktop: "/marketing/patients-desktop.avif",
    mobile: "/marketing/patients-mobile.avif",
  },
  patientRecord: {
    time: "13:00",
    desktop: "/marketing/patient-record-desktop.avif",
    mobile: "/marketing/patient-record-mobile.avif",
  },
  reports: {
    time: "17:30",
    desktop: "/marketing/reports-desktop.avif",
    mobile: "/marketing/reports-mobile.avif",
  },
};

export type MarketingCopy = ReturnType<typeof getMarketingCopy>;
export type LegalCopy = ReturnType<typeof getLegalCopy>;

/**
 * Builds the marketing copy tree for the active locale.
 *
 * `t` is a next-intl translator scoped to the `marketing` namespace — `useTranslations("marketing")`
 * on the client, `getTranslations("marketing")` on the server. Both satisfy `MessageTranslator`.
 */
export function getMarketingCopy(t: MessageTranslator) {
  return {
    brand: t("brand"),
    nav: {
      label: t("nav.label"),
      home: t("nav.home"),
      menu: t("nav.menu"),
      closeMenu: t("nav.closeMenu"),
      menuTitle: t("nav.menuTitle"),
      product: t("nav.product"),
      features: t("nav.features"),
      security: t("nav.security"),
      pricing: t("nav.pricing"),
      faq: t("nav.faq"),
      login: t("nav.login"),
      earlyAccess: t("nav.earlyAccess"),
    },
    hero: {
      eyebrow: t("hero.eyebrow"),
      title: t("hero.title"),
      /** The clause the hero sets in the accent face. Must be a literal substring of `hero.title`. */
      titleAccent: t("hero.titleAccent"),
      body: t("hero.body"),
      primary: t("hero.primary"),
      openPrimary: t("hero.openPrimary"),
      secondary: t("hero.secondary"),
      assurances: t.raw<string[]>("hero.assurances"),
      assurancesLabel: t("hero.assurancesLabel"),
      screenshotAlt: t("hero.screenshotAlt"),
      screenshotCaption: t("hero.screenshotCaption"),
    },
    stats: {
      eyebrow: t("stats.eyebrow"),
      /**
       * Labels only. The *values* are in `lib/marketing-stats.ts` — provisional pre-launch display
       * figures, kept in one place so they can be swapped for real data without touching copy, and
       * deliberately not described anywhere as verified customer metrics.
       */
      label: (id: string) => t(`stats.items.${id}.label`),
      detail: (id: string) => t(`stats.items.${id}.detail`),
      note: t("stats.note"),
    },
    proof: {
      eyebrow: t("proof.eyebrow"),
      title: t("proof.title"),
      body: t("proof.body"),
      progress: (accepted: string, limit: string) => t("proof.progress", { accepted, limit }),
      progressLabel: t("proof.progressLabel"),
    },
    product: {
      eyebrow: t("product.eyebrow"),
      title: t("product.title"),
      body: t("product.body"),
      demoNotice: t("product.demoNotice"),
      workflows: t.raw<Array<{ time: string; label: string; title: string; body: string; bullets: string[]; alt: string }>>("product.workflows")
        .map((workflow, index) => ({ ...workflow, ...WORKFLOW_ASSETS[WORKFLOW_IDS[index]] })),
    },
    features: {
      eyebrow: t("features.eyebrow"),
      title: t("features.title"),
      body: t("features.body"),
      items: t.raw<{ title: string; body: string }[]>("features.items"),
    },
    security: {
      eyebrow: t("security.eyebrow"),
      title: t("security.title"),
      body: t("security.body"),
      items: t.raw<{ title: string; body: string }[]>("security.items"),
      note: t("security.note"),
    },
    pricing: {
      eyebrow: t("pricing.eyebrow"),
      title: t("pricing.title"),
      body: t("pricing.body"),
      cta: t("pricing.cta"),
      pending: t("pricing.pending"),
      tiers: t.raw<{ name: string; description: string; highlights: string[] }[]>("pricing.tiers"),
    },
    earlyAccess: {
      eyebrow: t("earlyAccess.eyebrow"),
      title: t("earlyAccess.title"),
      body: t("earlyAccess.body"),
      button: t("earlyAccess.button"),
      openButton: t("earlyAccess.openButton"),
      dialogTitle: t("earlyAccess.dialogTitle"),
      dialogDescription: t("earlyAccess.dialogDescription"),
    },
    faq: {
      eyebrow: t("faq.eyebrow"),
      title: t("faq.title"),
      expand: "+",
      items: t.raw<{ question: string; answer: string }[]>("faq.items"),
    },
    footer: {
      tagline: t("footer.tagline"),
      email: "hello@clinicflow.app",
      login: t("footer.login"),
      privacy: t("footer.privacy"),
      terms: t("footer.terms"),
      legal: t("footer.legal"),
      navLabel: t("footer.navLabel"),
      copyright: (year: string) => t("footer.copyright", { year }),
    },
    backToTop: t("backToTop"),
  };
}

/** The `/privacy` and `/terms` outlines. Still pending professional review — see AI_AGENT_PLAN §3.7. */
export function getLegalCopy(t: MessageTranslator) {
  return {
    back: t("back"),
    noticeTitle: t("noticeTitle"),
    noticeBody: t("noticeBody"),
    privacy: {
      title: t("privacy.title"),
      description: t("privacy.description"),
      updated: t("privacy.updated"),
      sections: t.raw<{ title: string; body: string }[]>("privacy.sections"),
    },
    terms: {
      title: t("terms.title"),
      description: t("terms.description"),
      updated: t("terms.updated"),
      sections: t.raw<{ title: string; body: string }[]>("terms.sections"),
    },
  };
}
