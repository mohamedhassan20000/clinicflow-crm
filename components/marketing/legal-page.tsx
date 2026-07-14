import Link from "next/link";
import { AlertCircle, ArrowUpRight } from "lucide-react";
import { MarketingLogo } from "@/components/marketing/marketing-logo";
import { PublicThemeShell, PublicThemeToggle } from "@/components/marketing/public-theme";
import { useTranslations } from "next-intl";
import { getLegalCopy, getMarketingCopy, type LegalCopy } from "@/lib/marketing-copy";
import type { MessageTranslator } from "@/lib/i18n/translator";

/**
 * P2C — which of the two outlines to render. The *content* now comes from the message catalog, so
 * the page takes a document key rather than a copy object: `/privacy` and `/terms` cannot hand it
 * an English literal any more, which is exactly the mistake this shape prevents.
 */
export function LegalPage({ document }: { document: "privacy" | "terms" }) {
  const legal: LegalCopy = getLegalCopy(useTranslations("legal") as unknown as MessageTranslator);
  const marketing = getMarketingCopy(useTranslations("marketing") as unknown as MessageTranslator);
  const content = legal[document];

  return (
    <PublicThemeShell className="min-h-dvh bg-[var(--m-paper)] text-[var(--m-ink)]">
      <header className="border-b border-[var(--m-line)]">
        <div className="mx-auto flex h-[4.5rem] max-w-5xl items-center justify-between px-5">
          <MarketingLogo className="text-[var(--m-ink)] focus-visible:ring-offset-[var(--m-paper)]" />
          <div className="flex items-center gap-2">
            <PublicThemeToggle />
            <Link
              href="/"
              className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--m-line-strong)] bg-[var(--m-panel)] px-4 text-sm font-semibold hover:bg-[var(--m-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0d9488]"
            >
              {legal.back}
              <ArrowUpRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </header>

      <article className="mx-auto max-w-5xl px-5 py-16 sm:py-24">
        <header className="max-w-3xl">
          <p className="marketing-section-label">{content.updated}</p>
          <h1 className="mt-5 font-display text-6xl font-normal leading-[.92] tracking-[-.05em] sm:text-7xl">
            {content.title}
          </h1>
          <p className="mt-6 text-xl leading-8 text-[var(--m-muted)]">{content.description}</p>
        </header>

        <aside
          className="mt-12 flex items-start gap-4 rounded-2xl border border-[#ce8b34]/30 bg-[#fff3d9] p-5 text-[#5d3a0b] dark:border-[#f4bd67]/20 dark:bg-[#4a3518] dark:text-[#ffe5b2]"
          aria-labelledby="legal-review-notice"
        >
          <AlertCircle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div>
            <h2 id="legal-review-notice" className="text-base font-bold tracking-normal">{legal.noticeTitle}</h2>
            <p className="mt-1 text-sm leading-6">{legal.noticeBody}</p>
          </div>
        </aside>

        <div className="mt-14 divide-y divide-[var(--m-line)] border-y border-[var(--m-line)]">
          {content.sections.map((section, index) => (
            <section key={section.title} className="grid gap-4 py-8 sm:grid-cols-[3rem_1fr] sm:gap-7" aria-labelledby={`legal-section-${index}`}>
              <span className="font-mono text-xs font-semibold text-[var(--m-accent-text)]" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <h2 id={`legal-section-${index}`} className="text-xl font-semibold tracking-[-.025em]">{section.title}</h2>
                <p className="mt-3 max-w-3xl leading-7 text-[var(--m-muted)]">{section.body}</p>
              </div>
            </section>
          ))}
        </div>
      </article>

      <footer className="border-t border-[var(--m-line)] px-5 py-8 text-sm text-[var(--m-muted)]">
        <div className="mx-auto flex max-w-5xl flex-wrap justify-between gap-4">
          <span>{marketing.footer.copyright(new Intl.NumberFormat("en", { useGrouping: false }).format(new Date().getFullYear()))}</span>
          <div className="flex gap-5">
            <Link href="/privacy" className="hover:text-[var(--m-ink)]">{marketing.footer.privacy}</Link>
            <Link href="/terms" className="hover:text-[var(--m-ink)]">{marketing.footer.terms}</Link>
          </div>
        </div>
      </footer>
    </PublicThemeShell>
  );
}
