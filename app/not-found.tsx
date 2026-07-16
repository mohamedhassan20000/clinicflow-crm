import Link from "next/link";
import { ArrowUpRight, FileQuestion } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { MarketingLogo } from "@/components/marketing/marketing-logo";

export default async function NotFound() {
  const t = await getTranslations("notFound");

  return (
    <main className="light forced-public-scope marketing-page relative flex min-h-dvh flex-col overflow-hidden bg-[var(--m-paper)] text-[var(--m-ink)]">
      <div className="marketing-care-path pointer-events-none absolute inset-0" aria-hidden="true" />

      <header className="relative z-10 border-b border-[var(--m-line)]">
        <div className="mx-auto flex h-[4.5rem] w-full max-w-5xl items-center px-5">
          <MarketingLogo className="text-[var(--m-ink)] focus-visible:ring-offset-[var(--m-paper)]" />
        </div>
      </header>

      <section className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 items-center px-5 py-16 sm:py-24">
        <div className="max-w-2xl">
          <div className="mb-7 flex size-14 items-center justify-center rounded-full border border-[var(--m-line)] bg-[var(--m-panel)] text-[var(--m-accent-text)]">
            <FileQuestion className="size-6" aria-hidden="true" />
          </div>
          <p className="marketing-section-label">{t("eyebrow")}</p>
          <h1 className="mt-5 font-display text-5xl font-normal leading-tight tracking-[-.045em] sm:text-7xl">
            {t("title")}
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-[var(--m-muted)] sm:text-xl">
            {t("description")}
          </p>
          <Link
            href="/"
            className="marketing-cta mt-9 inline-flex min-h-12 items-center gap-2 rounded-full bg-[#087f7b] px-6 text-base font-semibold text-white shadow-[0_14px_30px_-18px_rgba(8,127,123,.7)] hover:bg-[#076e6b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0d9488] focus-visible:ring-offset-3 focus-visible:ring-offset-[var(--m-paper)]"
          >
            {t("home")}
            <ArrowUpRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
          </Link>
        </div>
      </section>
    </main>
  );
}
