import Link from "next/link";
import { Suspense } from "react";
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
import { EarlyAccessButton } from "@/components/marketing/early-access-button";
import { MarketingLogo } from "@/components/marketing/marketing-logo";
import { MobileMarketingMenu } from "@/components/marketing/mobile-marketing-menu";
import { ProductScreenshot } from "@/components/marketing/product-screenshot";
import { marketingCopy as copy } from "@/lib/marketing-copy";

type RegistrationStatus = {
  registrationMode: string;
  weeklyLimit: number;
  acceptedThisWeek: number;
};

type Props = RegistrationStatus | { statusPromise: Promise<RegistrationStatus> };

const fallbackStatus: RegistrationStatus = {
  registrationMode: "invite_only",
  weeklyLimit: 20,
  acceptedThisWeek: 0,
};

const navigation = [
  ["#product", copy.nav.product],
  ["#features", copy.nav.features],
  ["#security", copy.nav.security],
  ["#pricing", copy.nav.pricing],
  ["#faq", copy.nav.faq],
] as const;

const featureIcons = [
  CalendarDays,
  FileHeart,
  WalletCards,
  MessagesSquare,
  BarChart3,
  UsersRound,
] as const;

const securityIcons = [Layers3, DatabaseZap, UserRoundCheck, History, FileArchive] as const;

function normalizeStatus(status: RegistrationStatus) {
  const safeLimit = Math.max(status.weeklyLimit, 1);
  const safeAccepted = Math.min(Math.max(status.acceptedThisWeek, 0), safeLimit);
  return { ...status, safeLimit, safeAccepted };
}

function CohortProgress({ status }: { status: RegistrationStatus }) {
  const { safeLimit, safeAccepted } = normalizeStatus(status);
  const percentage = Math.round((safeAccepted / safeLimit) * 100);

  return (
    <div className="rounded-2xl border border-[var(--m-line)] bg-[var(--m-paper)] p-5">
      <div className="flex items-end justify-between gap-4">
        <span className="text-sm font-semibold">{copy.proof.progress(safeAccepted, safeLimit)}</span>
        <span className="font-mono text-sm text-[#087f7b] dark:text-[#77ddd5]">{percentage}%</span>
      </div>
      <div
        className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--m-soft)]"
        role="progressbar"
        aria-label={copy.proof.progressLabel}
        aria-valuemin={0}
        aria-valuemax={safeLimit}
        aria-valuenow={safeAccepted}
        aria-valuetext={copy.proof.progress(safeAccepted, safeLimit)}
      >
        <div className="h-full rounded-full bg-[linear-gradient(90deg,#087f7b,#14c5cf)]" style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

async function LiveCohortProgress({ statusPromise }: { statusPromise: Promise<RegistrationStatus> }) {
  return <CohortProgress status={await statusPromise} />;
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

function CohortText({ status }: { status: RegistrationStatus }) {
  const { safeLimit, safeAccepted } = normalizeStatus(status);
  return <>{copy.proof.progress(safeAccepted, safeLimit)}</>;
}

async function LiveCohortText({ statusPromise }: { statusPromise: Promise<RegistrationStatus> }) {
  return <CohortText status={await statusPromise} />;
}

export function MarketingPage(props: Props) {
  let statusPromise: Promise<RegistrationStatus> | null = null;
  let status = fallbackStatus;
  if ("statusPromise" in props) {
    statusPromise = props.statusPromise;
  } else {
    status = props;
  }

  return (
    <main className="marketing-page min-h-dvh overflow-hidden bg-[var(--m-paper)] text-[var(--m-ink)]">
      <header className="sticky top-0 z-40 border-b border-[var(--m-line)] bg-[color-mix(in_oklab,var(--m-paper)_88%,transparent)] backdrop-blur-xl">
        <div className="mx-auto flex h-[4.5rem] max-w-[90rem] items-center justify-between px-5 lg:px-10">
          <MarketingLogo />
          <nav aria-label={copy.nav.label} className="hidden items-center gap-7 text-sm font-medium text-[var(--m-muted)] md:flex">
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
          <div className="hidden items-center gap-2 md:flex">
            <Button asChild variant="ghost" className="h-11 rounded-full px-5 text-[var(--m-ink)] hover:bg-[var(--m-soft)]">
              <Link href="/login">{copy.nav.login}</Link>
            </Button>
            <Button asChild className="h-11 rounded-full bg-[#087f7b] px-5 text-white hover:bg-[#076e6b]">
              <Link href="#early-access">{copy.nav.earlyAccess}</Link>
            </Button>
          </div>
          <MobileMarketingMenu />
        </div>
      </header>

      <section className="relative mx-auto grid min-h-[calc(100dvh-4.5rem)] max-w-[90rem] items-center gap-12 px-5 py-12 md:py-20 lg:grid-cols-[.82fr_1.18fr] lg:px-10">
        <div className="marketing-hero-copy relative z-10 max-w-2xl">
          <p className="marketing-eyebrow">
            <span className="size-1.5 rounded-full bg-[#12b8c8]" aria-hidden="true" />
            {copy.hero.eyebrow}
          </p>
          <h1 className="mt-6 max-w-3xl font-display text-[clamp(3.25rem,7.2vw,7.4rem)] font-normal leading-[.88] tracking-[-.06em] text-balance">
            {copy.hero.title}
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-8 text-[var(--m-muted)] sm:text-xl">
            {copy.hero.body}
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            {statusPromise ? (
              <Suspense
                fallback={(
                  <EarlyAccessButton
                    registrationMode={fallbackStatus.registrationMode}
                    label={copy.hero.primary}
                    openLabel={copy.hero.openPrimary}
                    className="h-12 rounded-full bg-[#087f7b] px-7 text-base text-white shadow-[0_14px_30px_-18px_rgba(8,127,123,.7)] hover:bg-[#076e6b]"
                  />
                )}
              >
                <LiveEarlyAccessButton
                  statusPromise={statusPromise}
                  label={copy.hero.primary}
                  openLabel={copy.hero.openPrimary}
                  className="h-12 rounded-full bg-[#087f7b] px-7 text-base text-white shadow-[0_14px_30px_-18px_rgba(8,127,123,.7)] hover:bg-[#076e6b]"
                />
              </Suspense>
            ) : (
              <EarlyAccessButton
                registrationMode={status.registrationMode}
                label={copy.hero.primary}
                openLabel={copy.hero.openPrimary}
                className="h-12 rounded-full bg-[#087f7b] px-7 text-base text-white shadow-[0_14px_30px_-18px_rgba(8,127,123,.7)] hover:bg-[#076e6b]"
              />
            )}
            <Button asChild variant="outline" className="h-12 rounded-full border-[var(--m-line-strong)] bg-[var(--m-panel)] px-7 text-base text-[var(--m-ink)] hover:bg-[var(--m-soft)]">
              <Link href="#product">
                {copy.hero.secondary}
                <ArrowDown className="size-4" />
              </Link>
            </Button>
          </div>
          <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-[var(--m-muted)]" aria-label="Early-access assurances">
            {copy.hero.assurances.map((item) => (
              <li key={item} className="flex items-center gap-2">
                <span className="grid size-5 place-items-center rounded-full bg-[#d6f3ee] text-[#087f7b] dark:bg-[#0d5b61] dark:text-[#9ce8df]">
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

        <div className="marketing-care-path pointer-events-none absolute inset-0 -z-10 opacity-70" aria-hidden="true" />
      </section>

      <section className="border-y border-[var(--m-line)] bg-[var(--m-panel)] px-5 py-10 lg:px-10" aria-labelledby="cohort-title">
        <div className="mx-auto grid max-w-[90rem] items-center gap-8 md:grid-cols-[1fr_minmax(18rem,.72fr)]">
          <div>
            <p className="font-mono text-xs font-semibold uppercase tracking-[.16em] text-[#087f7b] dark:text-[#77ddd5]">
              {copy.proof.eyebrow}
            </p>
            <h2 id="cohort-title" className="mt-2 text-2xl font-semibold tracking-[-.035em] sm:text-3xl">
              {copy.proof.title}
            </h2>
            <p className="mt-3 max-w-3xl leading-7 text-[var(--m-muted)]">{copy.proof.body}</p>
          </div>
          {statusPromise ? (
            <Suspense fallback={<CohortProgress status={fallbackStatus} />}>
              <LiveCohortProgress statusPromise={statusPromise} />
            </Suspense>
          ) : (
            <CohortProgress status={status} />
          )}
        </div>
      </section>

      <section id="product" className="scroll-mt-24 px-5 py-24 lg:px-10 lg:py-32" aria-labelledby="product-title">
        <div className="mx-auto max-w-[90rem]">
          <div className="marketing-scroll-reveal grid gap-8 border-b border-[var(--m-line)] pb-14 lg:grid-cols-[.7fr_1.3fr]">
            <p className="marketing-section-label">{copy.product.eyebrow}</p>
            <div>
              <h2 id="product-title" className="font-display text-5xl font-normal leading-[.96] tracking-[-.045em] text-balance sm:text-6xl lg:text-7xl">
                {copy.product.title}
              </h2>
              <p className="mt-6 max-w-3xl text-lg leading-8 text-[var(--m-muted)]">{copy.product.body}</p>
              <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-[var(--m-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--m-muted)]">
                <ShieldCheck className="size-4 text-[#087f7b]" aria-hidden="true" />
                {copy.product.demoNotice}
              </p>
            </div>
          </div>

          <div className="mt-20 space-y-28">
            {copy.product.workflows.map((workflow, index) => (
              <article key={workflow.title} className="marketing-scroll-reveal grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
                <div className={index % 2 === 1 ? "lg:order-2" : undefined}>
                  <div className="flex items-center gap-4">
                    <span className="font-mono text-xs font-semibold tracking-[.16em] text-[#087f7b] dark:text-[#77ddd5]">{workflow.time}</span>
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
                        <ClipboardCheck className="mt-0.5 size-4 shrink-0 text-[#087f7b] dark:text-[#77ddd5]" aria-hidden="true" />
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

      <section id="features" className="scroll-mt-24 border-y border-[var(--m-line)] bg-[var(--m-panel)] px-5 py-24 lg:px-10 lg:py-28" aria-labelledby="features-title">
        <div className="mx-auto max-w-[90rem]">
          <div className="marketing-scroll-reveal max-w-3xl">
            <p className="marketing-section-label">{copy.features.eyebrow}</p>
            <h2 id="features-title" className="mt-4 font-display text-5xl font-normal leading-none tracking-[-.045em] sm:text-6xl">
              {copy.features.title}
            </h2>
            <p className="mt-5 text-lg leading-8 text-[var(--m-muted)]">{copy.features.body}</p>
          </div>
          <div className="mt-12 grid gap-px overflow-hidden rounded-[1.75rem] border border-[var(--m-line)] bg-[var(--m-line)] md:grid-cols-2 lg:grid-cols-3">
            {copy.features.items.map((item, index) => {
              const Icon = featureIcons[index];
              return (
                <article key={item.title} className="marketing-card min-h-64 bg-[var(--m-paper)] p-7 sm:p-8">
                  <span className="grid size-11 place-items-center rounded-xl bg-[var(--m-soft)] text-[#087f7b] dark:text-[#77ddd5]">
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

      <section id="security" className="scroll-mt-24 bg-[#073846] px-5 py-24 text-white lg:px-10 lg:py-32" aria-labelledby="security-title">
        <div className="mx-auto max-w-[90rem]">
          <div className="marketing-scroll-reveal grid gap-10 lg:grid-cols-[.9fr_1.1fr]">
            <div>
              <p className="font-mono text-xs font-semibold uppercase tracking-[.17em] text-[#6ee7dc]">{copy.security.eyebrow}</p>
              <h2 id="security-title" className="mt-5 max-w-2xl font-display text-5xl font-normal leading-[.96] tracking-[-.045em] text-balance sm:text-6xl">
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

      <section id="pricing" className="scroll-mt-24 px-5 py-24 lg:px-10 lg:py-28" aria-labelledby="pricing-title">
        <div className="mx-auto max-w-[90rem]">
          <div className="marketing-scroll-reveal max-w-3xl">
            <p className="marketing-section-label">{copy.pricing.eyebrow}</p>
            <h2 id="pricing-title" className="mt-4 font-display text-5xl font-normal leading-none tracking-[-.045em] sm:text-6xl">
              {copy.pricing.title}
            </h2>
            <p className="mt-5 text-lg leading-8 text-[var(--m-muted)]">{copy.pricing.body}</p>
          </div>
          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {copy.pricing.tiers.map((tier, index) => (
              <article key={tier.name} className={`marketing-card flex min-h-[23rem] flex-col rounded-[1.75rem] border p-7 ${index === 1 ? "border-[#0d9488] bg-[#e5f7f4] dark:bg-[#0a4b51]" : "border-[var(--m-line)] bg-[var(--m-panel)]"}`}>
                <p className="font-mono text-[11px] font-semibold uppercase tracking-[.16em] text-[#066d6a] dark:text-[#89e5dc]">{copy.pricing.pending}</p>
                <h3 className="mt-6 text-3xl font-semibold tracking-[-.04em]">{tier.name}</h3>
                <p className="mt-3 leading-7 text-[var(--m-muted)]">{tier.description}</p>
                <ul className="mt-8 grid gap-3">
                  {tier.highlights.map((highlight) => (
                    <li key={highlight} className="flex items-center gap-2.5 text-sm font-medium">
                      <Check className="size-4 text-[#087f7b] dark:text-[#89e5dc]" aria-hidden="true" />
                      {highlight}
                    </li>
                  ))}
                </ul>
                <Button asChild variant="outline" className="mt-auto h-11 rounded-full border-[var(--m-line-strong)] bg-[var(--m-paper)] text-[var(--m-ink)] hover:bg-[var(--m-soft)]">
                  <Link href="#early-access">{copy.pricing.cta}</Link>
                </Button>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="early-access" className="scroll-mt-20 px-5 pb-24 lg:px-10 lg:pb-32" aria-labelledby="early-access-title">
        <div className="marketing-scroll-reveal relative mx-auto grid max-w-[90rem] overflow-hidden rounded-[2rem] bg-[#0a4653] px-7 py-12 text-white sm:px-12 lg:grid-cols-[1fr_auto] lg:items-end lg:px-16 lg:py-16">
          <div className="absolute inset-block-start-0 inset-inline-end-0 size-80 -translate-y-1/2 rounded-full bg-[#18c7d5]/20 blur-3xl" aria-hidden="true" />
          <div className="relative">
            <p className="font-mono text-xs font-semibold uppercase tracking-[.17em] text-[#79e8df]">{copy.earlyAccess.eyebrow}</p>
            <h2 id="early-access-title" className="mt-4 max-w-3xl font-display text-5xl font-normal leading-[.96] tracking-[-.045em] text-balance sm:text-6xl">
              {copy.earlyAccess.title}
            </h2>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-[#c5e0e3]">{copy.earlyAccess.body}</p>
            <p className="mt-6 font-mono text-xs text-[#9ed4d7]">
              {statusPromise ? (
                <Suspense fallback={<CohortText status={fallbackStatus} />}>
                  <LiveCohortText statusPromise={statusPromise} />
                </Suspense>
              ) : (
                <CohortText status={status} />
              )}
            </p>
          </div>
          {statusPromise ? (
            <Suspense
              fallback={(
                <EarlyAccessButton
                  registrationMode={fallbackStatus.registrationMode}
                  className="relative mt-8 h-12 rounded-full bg-white px-7 text-base text-[#073846] hover:bg-[#e6fbf8] lg:mt-0"
                />
              )}
            >
              <LiveEarlyAccessButton
                statusPromise={statusPromise}
                className="relative mt-8 h-12 rounded-full bg-white px-7 text-base text-[#073846] hover:bg-[#e6fbf8] lg:mt-0"
              />
            </Suspense>
          ) : (
            <EarlyAccessButton
              registrationMode={status.registrationMode}
              className="relative mt-8 h-12 rounded-full bg-white px-7 text-base text-[#073846] hover:bg-[#e6fbf8] lg:mt-0"
            />
          )}
        </div>
      </section>

      <section id="faq" className="scroll-mt-24 border-t border-[var(--m-line)] bg-[var(--m-panel)] px-5 py-24 lg:px-10 lg:py-28" aria-labelledby="faq-title">
        <div className="mx-auto grid max-w-[90rem] gap-12 lg:grid-cols-[.68fr_1.32fr]">
          <div className="marketing-scroll-reveal">
            <p className="marketing-section-label">{copy.faq.eyebrow}</p>
            <h2 id="faq-title" className="mt-4 max-w-xl font-display text-5xl font-normal leading-[.96] tracking-[-.045em] sm:text-6xl">
              {copy.faq.title}
            </h2>
          </div>
          <div className="divide-y divide-[var(--m-line)] border-y border-[var(--m-line)]">
            {copy.faq.items.map(({ question, answer }) => (
              <details key={question} className="group py-1">
                <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-5 rounded-lg py-4 text-lg font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0d9488]">
                  {question}
                  <span className="grid size-8 shrink-0 place-items-center rounded-full border border-[var(--m-line)] text-[#087f7b] transition-transform group-open:rotate-45 dark:text-[#77ddd5]" aria-hidden="true">
                    {copy.faq.expand}
                  </span>
                </summary>
                <p className="max-w-3xl pb-6 pe-10 leading-7 text-[var(--m-muted)]">{answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <footer id="contact" className="bg-[#073846] px-5 py-12 text-white lg:px-10">
        <div className="mx-auto grid max-w-[90rem] gap-10 md:grid-cols-[1fr_auto] md:items-end">
          <div>
            <MarketingLogo inverse />
            <p className="mt-4 max-w-md text-sm leading-6 text-[#b7d5d9]">{copy.footer.tagline}</p>
            <p className="mt-2 text-xs text-[#8fb9be]">{copy.footer.legal}</p>
          </div>
          <nav aria-label="Footer navigation" className="flex flex-wrap gap-x-6 gap-y-3 text-sm text-[#c4dde0]">
            <a href={`mailto:${copy.footer.email}`} className="hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6ee7dc]">{copy.footer.email}</a>
            <Link href="/login" className="hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6ee7dc]">{copy.footer.login}</Link>
            <Link href="/privacy" className="hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6ee7dc]">{copy.footer.privacy}</Link>
            <Link href="/terms" className="hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6ee7dc]">{copy.footer.terms}</Link>
          </nav>
        </div>
        <div className="mx-auto mt-10 max-w-[90rem] border-t border-white/10 pt-5 font-mono text-[11px] uppercase tracking-[.14em] text-[#7faeb4]">
          {copy.footer.copyright(new Date().getFullYear())}
        </div>
      </footer>
    </main>
  );
}
