import Link from "next/link";
import { AlertCircle, ArrowUpRight } from "lucide-react";
import { MarketingLogo } from "@/components/marketing/marketing-logo";
import { marketingCopy as copy } from "@/lib/marketing-copy";

type LegalContent = typeof copy.legal.privacy | typeof copy.legal.terms;

export function LegalPage({ content }: { content: LegalContent }) {
  return (
    <main className="marketing-page min-h-dvh bg-[var(--m-paper)] text-[var(--m-ink)]">
      <header className="border-b border-[var(--m-line)]">
        <div className="mx-auto flex h-[4.5rem] max-w-5xl items-center justify-between px-5">
          <MarketingLogo />
          <Link
            href="/"
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--m-line-strong)] bg-[var(--m-panel)] px-4 text-sm font-semibold hover:bg-[var(--m-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0d9488]"
          >
            {copy.legal.back}
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </Link>
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
          className="mt-12 flex items-start gap-4 rounded-2xl border border-[#ce8b34]/30 bg-[#fff3d9] p-5 text-[#5d3a0b] dark:border-[#f1c474]/25 dark:bg-[#473211] dark:text-[#ffe7b6]"
          aria-labelledby="legal-review-notice"
        >
          <AlertCircle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div>
            <h2 id="legal-review-notice" className="text-base font-bold tracking-normal">{copy.legal.noticeTitle}</h2>
            <p className="mt-1 text-sm leading-6">{copy.legal.noticeBody}</p>
          </div>
        </aside>

        <div className="mt-14 divide-y divide-[var(--m-line)] border-y border-[var(--m-line)]">
          {content.sections.map((section, index) => (
            <section key={section.title} className="grid gap-4 py-8 sm:grid-cols-[3rem_1fr] sm:gap-7" aria-labelledby={`legal-section-${index}`}>
              <span className="font-mono text-xs font-semibold text-[#087f7b] dark:text-[#77ddd5]" aria-hidden="true">
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
          <span>{copy.footer.copyright(new Date().getFullYear())}</span>
          <div className="flex gap-5">
            <Link href="/privacy" className="hover:text-[var(--m-ink)]">{copy.footer.privacy}</Link>
            <Link href="/terms" className="hover:text-[var(--m-ink)]">{copy.footer.terms}</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
