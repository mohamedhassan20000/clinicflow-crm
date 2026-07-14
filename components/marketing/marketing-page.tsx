import Link from "next/link";
import { Suspense } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowDown,
  BarChart3,
  CalendarDays,
  Check,
  ClipboardCheck,
  DatabaseZap,
  FileArchive,
  FileHeart,
  History,
  Layers3,
  LockKeyhole,
  MessagesSquare,
  ShieldCheck,
  UserRoundCheck,
  UsersRound,
  WalletCards,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AnimatedStat } from "@/components/marketing/animated-stat";
import { BackToTopButton } from "@/components/marketing/back-to-top-button";
import { EarlyAccessButton } from "@/components/marketing/early-access-button";
import { MarketingLogo } from "@/components/marketing/marketing-logo";
import { MobileMarketingMenu } from "@/components/marketing/mobile-marketing-menu";
import { ProductScreenshot } from "@/components/marketing/product-screenshot";
import { PublicThemeShell, PublicThemeToggle } from "@/components/marketing/public-theme";
import { getMarketingCopy, type MarketingCopy } from "@/lib/marketing-copy";
import { MARKETING_STATS } from "@/lib/marketing-stats";
import type { MessageTranslator } from "@/lib/i18n/translator";

type RegistrationStatus = {
  registrationMode: string;
  weeklyLimit: number;
  acceptedThisWeek: number;
};

type Props = (RegistrationStatus | { statusPromise: Promise<RegistrationStatus> }) & {
  /**
   * P2A: the marketing language switcher, injected by the page so this component stays synchronous
   * (it is rendered directly by existing component tests). Omitted, the header renders as before.
   */
  languageSwitcher?: React.ReactNode;
};

const fallbackStatus: RegistrationStatus = {
  registrationMode: "invite_only",
  weeklyLimit: 20,
  acceptedThisWeek: 0,
};

export const MARKETING_SECTION_TONES = {
  hero: "bg-[var(--m-paper)]",
  stats: "bg-[var(--m-panel)]",
  proof: "bg-[var(--m-panel)]",
  product: "bg-[var(--m-paper)]",
  features: "bg-[var(--m-warm)]",
  security: "bg-[#073846]",
  pricing: "bg-[var(--m-paper)]",
  earlyAccess: "bg-[var(--m-panel)]",
  faq: "bg-[var(--m-warm)]",
  footer: "bg-[#073846]",
} as const;

const featureIcons = [
  CalendarDays,
  FileHeart,
  WalletCards,
  MessagesSquare,
  BarChart3,
  UsersRound,
] as const;

const securityIcons = [Layers3, DatabaseZap, UserRoundCheck, History, FileArchive] as const;

/**
 * Marketing digits stay **Latin in both locales**.
 *
 * That is not an oversight and it is not laziness: Latin digits in Arabic-language B2B software are
 * the regional norm in Kuwait and the wider GCC (AI_AGENT_PLAN §4.4), and the Arabic-Indic option is
 * a deliberate *per-clinic* setting inside the product — a preference an anonymous visitor to the
 * marketing site has not expressed and cannot have. Formatting is centralized here rather than
 * sprinkled as `String(n)` so that if the marketing site ever does grow a digit preference, there is
 * exactly one place to change.
 */
function marketingNumber(value: number): string {
  return new Intl.NumberFormat("en", { useGrouping: true }).format(value);
}

/** A year is an identifier, not a quantity — it never takes a thousands separator. */
function marketingYear(value: number): string {
  return new Intl.NumberFormat("en", { useGrouping: false }).format(value);
}

function normalizeStatus(status: RegistrationStatus) {
  const safeLimit = Math.max(status.weeklyLimit, 1);
  const safeAccepted = Math.min(Math.max(status.acceptedThisWeek, 0), safeLimit);
  return { ...status, safeLimit, safeAccepted };
}

/**
 * Renders the hero headline with its key clause in the accent face.
 *
 * The accent clause is a **message-file value** (`hero.titleAccent`), not a slice index or a word
 * count, because the clause that carries the weight of the sentence is not in the same position in
 * Arabic as in English — and a translator, not a `split(" ")`, is the one who knows which clause it
 * is. If the clause is not found verbatim in the title (a translator edited one and not the other),
 * the title renders whole and unaccented. Copy is never dropped to satisfy a decoration.
 */
function AccentedTitle({ title, accent, className }: { title: string; accent: string; className?: string }) {
  const at = accent ? title.indexOf(accent) : -1;

  if (at === -1) {
    return <span className={className}>{title}</span>;
  }

  return (
    <span className={className}>
      {title.slice(0, at)}
      <em className="marketing-accent not-italic">{accent}</em>
      {title.slice(at + accent.length)}
    </span>
  );
}

function CohortProgress({ status, copy }: { status: RegistrationStatus; copy: MarketingCopy }) {
  const { safeLimit, safeAccepted } = normalizeStatus(status);
  const percentage = Math.round((safeAccepted / safeLimit) * 100);
  const progressText = copy.proof.progress(marketingNumber(safeAccepted), marketingNumber(safeLimit));

  return (
    <div className="flex min-h-40 flex-col justify-center rounded-2xl border border-[var(--m-line)] bg-[var(--m-paper)] p-7 sm:p-8">
      <div className="flex items-end justify-between gap-6">
        <span className="text-base font-semibold sm:text-lg">{progressText}</span>
        <span className="marketing-accent font-mono text-base font-semibold sm:text-lg">
          {marketingNumber(percentage)}%
        </span>
      </div>
      <div
        className="mt-5 h-3 overflow-hidden rounded-full bg-[var(--m-soft)]"
        role="progressbar"
        aria-label={copy.proof.progressLabel}
        aria-valuemin={0}
        aria-valuemax={safeLimit}
        aria-valuenow={safeAccepted}
        aria-valuetext={progressText}
      >
        <div className="h-full rounded-full bg-[linear-gradient(90deg,#087f7b,#14c5cf)]" style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

async function LiveCohortProgress({
  statusPromise,
  copy,
}: {
  statusPromise: Promise<RegistrationStatus>;
  copy: MarketingCopy;
}) {
  return <CohortProgress status={await statusPromise} copy={copy} />;
}

async function LiveEarlyAccessButton({
  statusPromise,
  ...props
}: Omit<React.ComponentProps<typeof EarlyAccessButton>, "registrationMode"> & {
  statusPromise: Promise<RegistrationStatus>;
}) {
  const status = await statusPromise;
  return <EarlyAccessButton registrationMode={status.registrationMode} {...props} />;
}

function CohortText({ status, copy }: { status: RegistrationStatus; copy: MarketingCopy }) {
  const { safeLimit, safeAccepted } = normalizeStatus(status);
  return <>{copy.proof.progress(marketingNumber(safeAccepted), marketingNumber(safeLimit))}</>;
}

async function LiveCohortText({
  statusPromise,
  copy,
}: {
  statusPromise: Promise<RegistrationStatus>;
  copy: MarketingCopy;
}) {
  return <CohortText status={await statusPromise} copy={copy} />;
}

export function MarketingPage(props: Props) {
  const copy = getMarketingCopy(useTranslations("marketing") as unknown as MessageTranslator);

  const navigation = [
    ["#product", copy.nav.product],
    ["#features", copy.nav.features],
    ["#security", copy.nav.security],
    ["#pricing", copy.nav.pricing],
    ["#faq", copy.nav.faq],
  ] as const;

  let statusPromise: Promise<RegistrationStatus> | null = null;
  let status = fallbackStatus;
  if ("statusPromise" in props) {
    statusPromise = props.statusPromise;
  } else {
    status = props;
  }

  return (
    <PublicThemeShell className="min-h-dvh overflow-hidden bg-[var(--m-paper)] text-[var(--m-ink)]">
      <header className="sticky top-0 z-40 border-b border-[var(--m-line)] bg-[color-mix(in_oklab,var(--m-paper)_88%,transparent)] backdrop-blur-xl">
        <div className="mx-auto flex h-[4.5rem] max-w-[120rem] items-center justify-between gap-3 px-3 sm:px-5 lg:px-10 2xl:px-16">
          <MarketingLogo className="shrink-0 text-[var(--m-ink)] focus-visible:ring-offset-[var(--m-paper)]" />
          <nav aria-label={copy.nav.label} className="hidden items-center gap-7 text-sm font-medium text-[var(--m-muted)] xl:flex">
            {navigation.map(([href, label]) => (
              <Link
                key={href}
                href={href}
                className="rounded-md py-3 transition-colors hover:text-[var(--m-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0d9488] focus-visible:ring-offset-4"
              >
                {label}
              </Link>
            ))}
          </nav>
          <div className="flex shrink-0 items-center gap-2">
            {props.languageSwitcher}
            <PublicThemeToggle />
            <div className="hidden items-center gap-2 xl:flex">
              <Button asChild variant="ghost" className="h-11 rounded-full px-5 text-[var(--m-ink)] hover:bg-[var(--m-soft)]">
                <Link href="/login">{copy.nav.login}</Link>
              </Button>
              <Button asChild className="marketing-cta h-11 rounded-full bg-[#087f7b] px-5 text-white hover:bg-[#076e6b]">
                <Link href="#early-access">{copy.nav.earlyAccess}</Link>
              </Button>
            </div>
            <MobileMarketingMenu />
          </div>
        </div>
      </header>

      <section className={`${MARKETING_SECTION_TONES.hero} marketing-hero relative flex min-h-[calc(100dvh-4.5rem)] w-full items-center px-5 py-12 md:px-8 md:py-20 lg:px-10 2xl:px-16`}>
        <div className="marketing-care-path pointer-events-none absolute inset-0 z-0 opacity-70" aria-hidden="true" />
        <div className="relative z-10 mx-auto grid w-full max-w-[120rem] items-center gap-12 lg:grid-cols-[.82fr_1.18fr] lg:gap-14 2xl:grid-cols-[.72fr_1.28fr] 2xl:gap-20">
          <div className="marketing-hero-copy max-w-2xl">
          <p className="marketing-eyebrow marketing-hero-eyebrow">
            <span className="size-1.5 rounded-full bg-[#12b8c8]" aria-hidden="true" />
            {copy.hero.eyebrow}
          </p>
          <h1 className="marketing-hero-title mt-6 max-w-3xl font-display text-[clamp(3.05rem,6.2vw,6.65rem)] font-normal leading-[.93] tracking-[-.042em] text-balance">
            <AccentedTitle title={copy.hero.title} accent={copy.hero.titleAccent} />
          </h1>
          <p className="marketing-hero-body mt-7 max-w-xl text-lg leading-8 text-[var(--m-muted)] sm:text-xl">
            {copy.hero.body}
          </p>
          <div className="marketing-hero-actions mt-8 flex flex-col gap-3 sm:flex-row">
            {statusPromise ? (
              <Suspense
                fallback={(
                  <EarlyAccessButton
                    registrationMode={fallbackStatus.registrationMode}
                    label={copy.hero.primary}
                    openLabel={copy.hero.openPrimary}
                    className="marketing-cta h-12 rounded-full bg-[#087f7b] px-7 text-base text-white shadow-[0_14px_30px_-18px_rgba(8,127,123,.7)] hover:bg-[#076e6b]"
                  />
                )}
              >
                <LiveEarlyAccessButton
                  statusPromise={statusPromise}
                  label={copy.hero.primary}
                  openLabel={copy.hero.openPrimary}
                  className="marketing-cta h-12 rounded-full bg-[#087f7b] px-7 text-base text-white shadow-[0_14px_30px_-18px_rgba(8,127,123,.7)] hover:bg-[#076e6b]"
                />
              </Suspense>
            ) : (
              <EarlyAccessButton
                registrationMode={status.registrationMode}
                label={copy.hero.primary}
                openLabel={copy.hero.openPrimary}
                className="marketing-cta h-12 rounded-full bg-[#087f7b] px-7 text-base text-white shadow-[0_14px_30px_-18px_rgba(8,127,123,.7)] hover:bg-[#076e6b]"
              />
            )}
            <Button asChild variant="outline" className="marketing-cta h-12 rounded-full border-[var(--m-line-strong)] bg-[var(--m-panel)] px-7 text-base text-[var(--m-ink)] hover:bg-[var(--m-soft)]">
              <Link href="#product">
                {copy.hero.secondary}
                <ArrowDown className="size-4" />
              </Link>
            </Button>
          </div>
          <ul className="marketing-hero-assurances mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-[var(--m-muted)]" aria-label={copy.hero.assurancesLabel}>
            {copy.hero.assurances.map((item) => (
              <li key={item} className="flex items-center gap-2">
                <span className="grid size-5 place-items-center rounded-full bg-[#d6f3ee] text-[#087f7b]">
                  <Check className="size-3" aria-hidden="true" />
                </span>
                {item}
              </li>
            ))}
          </ul>
          </div>

          <div className="marketing-float relative min-w-0 lg:ps-4">
            <div className="absolute -inset-12 -z-10 rounded-[40%] bg-[radial-gradient(circle_at_center,rgba(20,197,207,.22),transparent_68%)] blur-2xl" aria-hidden="true" />
            <ProductScreenshot
              desktop="/marketing/dashboard-desktop.avif"
              mobile="/marketing/dashboard-mobile.avif"
              alt={copy.hero.screenshotAlt}
              priority
            />
            <p className="mt-3 text-center font-mono text-[11px] uppercase tracking-[.16em] text-[var(--m-muted)]">
              {copy.hero.screenshotCaption}
            </p>
          </div>
        </div>
      </section>

      <BackToTopButton label={copy.backToTop} />

      {/*
        P2C — the statistics band, immediately below the hero.

        The figures are provisional pre-launch display values from `lib/marketing-stats.ts` and the
        note under the band says so on the page. They are deliberately never captioned as verified
        customer metrics: this page already earns its credibility by refusing to fabricate
        testimonials, and a band of invented traction numbers would spend exactly that credibility.
      */}
      <section
        id="stats"
        className={`${MARKETING_SECTION_TONES.stats} marketing-tex-mesh relative border-b border-[var(--m-line)] px-5 py-16 md:px-8 lg:px-10 lg:py-20 2xl:px-16`}
        aria-labelledby="stats-title"
      >
        <div className="relative mx-auto max-w-[90rem]">
          <p id="stats-title" className="marketing-section-label">{copy.stats.eyebrow}</p>
          <dl className="marketing-scroll-reveal mt-10 grid gap-10 sm:grid-cols-3 sm:gap-6">
            {MARKETING_STATS.map((stat) => (
              <div key={stat.id} className="border-s-2 border-[var(--m-line-strong)] ps-6">
                <dd className="marketing-stat-figure font-display text-[clamp(2.75rem,5vw,4.25rem)] font-normal leading-none tracking-[-.04em] tabular-nums">
                  <AnimatedStat
                    value={stat.value}
                    suffix={stat.suffix}
                    formattedValue={marketingNumber(stat.value)}
                    className="marketing-accent"
                  />
                </dd>
                <dt className="mt-4 text-lg font-semibold tracking-[-.02em]">{copy.stats.label(stat.id)}</dt>
                <p className="mt-1.5 text-sm leading-6 text-[var(--m-muted)]">{copy.stats.detail(stat.id)}</p>
              </div>
            ))}
          </dl>
          <p className="mt-10 text-xs leading-5 text-[var(--m-faint)]">{copy.stats.note}</p>
        </div>
      </section>

      <section className={`${MARKETING_SECTION_TONES.proof} marketing-tex-glow relative flex min-h-[32rem] items-center border-y border-[var(--m-line)] px-5 py-24 sm:min-h-[36rem] sm:py-28 md:min-h-[40rem] md:px-8 md:py-32 lg:min-h-[44rem] lg:px-10 lg:py-36 2xl:min-h-[48rem] 2xl:px-16 2xl:py-40`} aria-labelledby="cohort-title">
        <div className="relative mx-auto grid w-full max-w-[90rem] items-center gap-12 md:grid-cols-[1fr_minmax(18rem,.72fr)] lg:gap-16">
          <div>
            <p className="font-mono text-xs font-semibold uppercase tracking-[.16em] text-[var(--m-accent-text)]">
              {copy.proof.eyebrow}
            </p>
            <h2 id="cohort-title" className="mt-4 text-3xl font-semibold tracking-[-.035em] sm:text-4xl">
              {copy.proof.title}
            </h2>
            <p className="mt-5 max-w-3xl text-lg leading-8 text-[var(--m-muted)]">{copy.proof.body}</p>
          </div>
          {statusPromise ? (
            <Suspense fallback={<CohortProgress status={fallbackStatus} copy={copy} />}>
              <LiveCohortProgress statusPromise={statusPromise} copy={copy} />
            </Suspense>
          ) : (
            <CohortProgress status={status} copy={copy} />
          )}
        </div>
      </section>

      <section id="product" className={`${MARKETING_SECTION_TONES.product} scroll-mt-24 px-5 py-24 lg:px-10 lg:py-32`} aria-labelledby="product-title">
        <div className="mx-auto max-w-[120rem]">
          <div className="marketing-scroll-reveal grid gap-8 border-b border-[var(--m-line)] pb-14 lg:grid-cols-[.7fr_1.3fr]">
            <p className="marketing-section-label">{copy.product.eyebrow}</p>
            <div>
              <h2 id="product-title" className="font-display text-[clamp(2.8rem,5vw,4.75rem)] font-normal leading-[.99] tracking-[-.032em] text-balance">
                {copy.product.title}
              </h2>
              <p className="mt-6 max-w-3xl text-lg leading-8 text-[var(--m-muted)]">{copy.product.body}</p>
              <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-[var(--m-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--m-muted)]">
                <ShieldCheck className="size-4 text-[var(--m-accent-text)]" aria-hidden="true" />
                {copy.product.demoNotice}
              </p>
            </div>
          </div>

          <div className="mt-20 space-y-28">
            {copy.product.workflows.map((workflow, index) => (
              <article
                key={workflow.title}
                className={`marketing-scroll-reveal grid items-center gap-10 lg:grid-cols-2 lg:gap-16 ${index % 2 === 1 ? "xl:grid-cols-[minmax(0,1.28fr)_minmax(22rem,.72fr)]" : "xl:grid-cols-[minmax(22rem,.72fr)_minmax(0,1.28fr)]"}`}
              >
                <div className={index % 2 === 1 ? "lg:order-2" : undefined}>
                  <div className="flex items-center gap-4">
                    <span className="marketing-accent font-mono text-xs font-semibold tracking-[.16em]">{workflow.time}</span>
                    <span className="h-px w-10 bg-[var(--m-line-strong)]" aria-hidden="true" />
                    <span className="text-sm font-semibold text-[var(--m-muted)]">{workflow.label}</span>
                  </div>
                  <h3 className="mt-5 max-w-xl text-4xl font-semibold leading-[1.02] tracking-[-.045em] text-balance sm:text-5xl">
                    {workflow.title}
                  </h3>
                  <p className="mt-5 max-w-xl text-lg leading-8 text-[var(--m-muted)]">{workflow.body}</p>
                  <ul className="mt-7 grid gap-3">
                    {workflow.bullets.map((bullet) => (
                      <li key={bullet} className="flex items-start gap-3 text-sm font-medium">
                        <ClipboardCheck className="mt-0.5 size-4 shrink-0 text-[var(--m-accent-text)]" aria-hidden="true" />
                        {bullet}
                      </li>
                    ))}
                  </ul>
                </div>
                <ProductScreenshot
                  desktop={workflow.desktop}
                  mobile={workflow.mobile}
                  alt={workflow.alt}
                  className={index % 2 === 1 ? "lg:order-1" : undefined}
                />
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="features" className={`${MARKETING_SECTION_TONES.features} marketing-tex-grid relative scroll-mt-24 border-y border-[var(--m-line)] px-5 py-24 lg:px-10 lg:py-28`} aria-labelledby="features-title">
        <div className="relative mx-auto max-w-[90rem]">
          <div className="marketing-scroll-reveal max-w-3xl">
            <p className="marketing-section-label">{copy.features.eyebrow}</p>
            <h2 id="features-title" className="mt-4 font-display text-[clamp(2.75rem,4.5vw,4rem)] font-normal leading-[1.01] tracking-[-.03em] text-balance">
              {copy.features.title}
            </h2>
            <p className="mt-5 text-lg leading-8 text-[var(--m-muted)]">{copy.features.body}</p>
          </div>
          <div className="mt-12 grid gap-px overflow-hidden rounded-[1.75rem] border border-[var(--m-line)] bg-[var(--m-line)] md:grid-cols-2 lg:grid-cols-3">
            {copy.features.items.map((item, index) => {
              const Icon = featureIcons[index];
              return (
                <article key={item.title} className="marketing-card min-h-64 bg-[var(--m-paper)] p-7 sm:p-8">
                  <span className="grid size-11 place-items-center rounded-xl bg-[var(--m-soft)] text-[var(--m-accent-text)]">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <h3 className="mt-10 text-xl font-semibold tracking-[-.025em]">{item.title}</h3>
                  <p className="mt-3 leading-7 text-[var(--m-muted)]">{item.body}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section id="security" className={`${MARKETING_SECTION_TONES.security} scroll-mt-24 px-5 py-24 text-white lg:px-10 lg:py-32`} aria-labelledby="security-title">
        <div className="mx-auto max-w-[90rem]">
          <div className="marketing-scroll-reveal grid gap-10 lg:grid-cols-[.9fr_1.1fr]">
            <div>
              <p className="marketing-section-label marketing-section-label-inverse">{copy.security.eyebrow}</p>
              <h2 id="security-title" className="mt-5 max-w-2xl font-display text-[clamp(2.75rem,4.5vw,4rem)] font-normal leading-[1.01] tracking-[-.03em] text-balance">
                {copy.security.title}
              </h2>
              <p className="mt-6 max-w-xl text-lg leading-8 text-[#c3dde0]">{copy.security.body}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {copy.security.items.map((item, index) => {
                const Icon = securityIcons[index];
                return (
                  <article key={item.title} className="rounded-2xl border border-white/10 bg-white/[.055] p-5 last:sm:col-span-2">
                    <Icon className="size-5 text-[#6ee7dc]" aria-hidden="true" />
                    <h3 className="mt-5 font-semibold">{item.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-[#b8d5d8]">{item.body}</p>
                  </article>
                );
              })}
            </div>
          </div>
          <p className="mt-10 flex max-w-4xl items-start gap-3 border-t border-white/10 pt-6 text-sm leading-6 text-[#a9cbd0]">
            <LockKeyhole className="mt-0.5 size-4 shrink-0 text-[#6ee7dc]" aria-hidden="true" />
            {copy.security.note}
          </p>
        </div>
      </section>

      <section id="pricing" className={`${MARKETING_SECTION_TONES.pricing} marketing-tex-glow relative scroll-mt-24 px-5 py-24 lg:px-10 lg:py-28`} aria-labelledby="pricing-title">
        <div className="relative mx-auto max-w-[90rem]">
          <div className="marketing-scroll-reveal max-w-3xl">
            <p className="marketing-section-label">{copy.pricing.eyebrow}</p>
            <h2 id="pricing-title" className="mt-4 font-display text-[clamp(2.75rem,4.5vw,4rem)] font-normal leading-[1.01] tracking-[-.03em] text-balance">
              {copy.pricing.title}
            </h2>
            <p className="mt-5 text-lg leading-8 text-[var(--m-muted)]">{copy.pricing.body}</p>
          </div>
          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {copy.pricing.tiers.map((tier, index) => (
              <article key={tier.name} className={`marketing-card flex min-h-[23rem] flex-col rounded-[1.75rem] border p-7 ${index === 1 ? "border-[#0d9488] bg-[var(--m-soft)]" : "border-[var(--m-line)] bg-[var(--m-panel)]"}`}>
                <p className="font-mono text-[11px] font-semibold uppercase tracking-[.16em] text-[var(--m-accent-text)]">{copy.pricing.pending}</p>
                <h3 className="mt-6 text-3xl font-semibold tracking-[-.04em]">{tier.name}</h3>
                <p className="mt-3 leading-7 text-[var(--m-muted)]">{tier.description}</p>
                <ul className="mt-8 grid gap-3">
                  {tier.highlights.map((highlight) => (
                    <li key={highlight} className="flex items-center gap-2.5 text-sm font-medium">
                      <Check className="size-4 text-[#087f7b]" aria-hidden="true" />
                      {highlight}
                    </li>
                  ))}
                </ul>
                <Button asChild variant="outline" className="marketing-cta mt-auto h-11 rounded-full border-[var(--m-line-strong)] bg-[var(--m-paper)] text-[var(--m-ink)] hover:bg-[var(--m-soft)]">
                  <Link href="#early-access">{copy.pricing.cta}</Link>
                </Button>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="early-access" className={`${MARKETING_SECTION_TONES.earlyAccess} flex min-h-[78dvh] scroll-mt-20 items-center px-5 py-48 lg:px-10 lg:py-60`} aria-labelledby="early-access-title">
        <div className="marketing-scroll-reveal relative mx-auto grid w-full max-w-[90rem] gap-12 overflow-hidden rounded-[2rem] border border-[var(--m-line)] bg-[var(--m-soft)] px-7 py-16 text-[var(--m-ink)] sm:px-12 sm:py-20 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-16 lg:px-16 lg:py-24">
          <div className="absolute inset-block-start-0 inset-inline-end-0 size-80 -translate-y-1/2 rounded-full bg-[#18c7d5]/20 blur-3xl" aria-hidden="true" />
          <div className="relative">
            <p className="font-mono text-xs font-semibold uppercase tracking-[.17em] text-[var(--m-accent-text)]">{copy.earlyAccess.eyebrow}</p>
            <h2 id="early-access-title" className="mt-6 max-w-3xl font-display text-[clamp(3.25rem,5vw,4.75rem)] font-normal leading-[1.01] tracking-[-.03em] text-balance">
              {copy.earlyAccess.title}
            </h2>
            <p className="mt-7 max-w-2xl text-xl leading-9 text-[var(--m-muted)] sm:text-[1.375rem]">{copy.earlyAccess.body}</p>
            <p className="mt-8 font-mono text-sm text-[var(--m-muted)]">
              {statusPromise ? (
                <Suspense fallback={<CohortText status={fallbackStatus} copy={copy} />}>
                  <LiveCohortText statusPromise={statusPromise} copy={copy} />
                </Suspense>
              ) : (
                <CohortText status={status} copy={copy} />
              )}
            </p>
          </div>
          {statusPromise ? (
            <Suspense
              fallback={(
                <EarlyAccessButton
                  registrationMode={fallbackStatus.registrationMode}
                  className="marketing-cta relative mt-10 h-12 rounded-full bg-[#087f7b] px-7 text-base text-white hover:bg-[#076e6b] lg:mt-0"
                />
              )}
            >
              <LiveEarlyAccessButton
                statusPromise={statusPromise}
                className="marketing-cta relative mt-10 h-12 rounded-full bg-[#087f7b] px-7 text-base text-white hover:bg-[#076e6b] lg:mt-0"
              />
            </Suspense>
          ) : (
            <EarlyAccessButton
              registrationMode={status.registrationMode}
              className="marketing-cta relative mt-10 h-12 rounded-full bg-[#087f7b] px-7 text-base text-white hover:bg-[#076e6b] lg:mt-0"
            />
          )}
        </div>
      </section>

      <section id="faq" className={`${MARKETING_SECTION_TONES.faq} marketing-tex-grid relative scroll-mt-24 border-t border-[var(--m-line)] px-5 py-24 lg:px-10 lg:py-28`} aria-labelledby="faq-title">
        <div className="relative mx-auto grid max-w-[90rem] gap-12 lg:grid-cols-[.68fr_1.32fr]">
          <div className="marketing-scroll-reveal">
            <p className="marketing-section-label">{copy.faq.eyebrow}</p>
            <h2 id="faq-title" className="mt-4 max-w-xl font-display text-[clamp(2.75rem,4.5vw,4rem)] font-normal leading-[1.01] tracking-[-.03em] text-balance">
              {copy.faq.title}
            </h2>
          </div>
          <div className="divide-y divide-[var(--m-line)] border-y border-[var(--m-line)]">
            {copy.faq.items.map(({ question, answer }) => (
              <details key={question} className="group py-1">
                <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-5 rounded-lg py-4 text-lg font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0d9488]">
                  {question}
                  <span className="grid size-8 shrink-0 place-items-center rounded-full border border-[var(--m-line)] text-[var(--m-accent-text)] transition-transform group-open:rotate-45" aria-hidden="true">
                    {copy.faq.expand}
                  </span>
                </summary>
                <p className="max-w-3xl pb-6 pe-10 leading-7 text-[var(--m-muted)]">{answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <footer id="contact" className={`${MARKETING_SECTION_TONES.footer} px-5 py-12 text-white lg:px-10`}>
        <div className="mx-auto grid max-w-[90rem] gap-10 md:grid-cols-[1fr_auto] md:items-end">
          <div>
            <MarketingLogo inverse />
            <p className="mt-4 max-w-md text-sm leading-6 text-[#b7d5d9]">{copy.footer.tagline}</p>
            <p className="mt-2 text-xs text-[#8fb9be]">{copy.footer.legal}</p>
          </div>
          <nav aria-label={copy.footer.navLabel} className="flex flex-wrap gap-x-6 gap-y-3 text-sm text-[#c4dde0]">
            <a href={`mailto:${copy.footer.email}`} className="hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6ee7dc]">{copy.footer.email}</a>
            <Link href="/login" className="hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6ee7dc]">{copy.footer.login}</Link>
            <Link href="/privacy" className="hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6ee7dc]">{copy.footer.privacy}</Link>
            <Link href="/terms" className="hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6ee7dc]">{copy.footer.terms}</Link>
          </nav>
        </div>
        <div className="mx-auto mt-10 max-w-[90rem] border-t border-white/10 pt-5 font-mono text-[11px] uppercase tracking-[.14em] text-[#7faeb4]">
          {copy.footer.copyright(marketingYear(new Date().getFullYear()))}
        </div>
      </footer>
    </PublicThemeShell>
  );
}
