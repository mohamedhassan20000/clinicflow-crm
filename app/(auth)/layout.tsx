import Image from "next/image";
import Link from "next/link";
import {
  CalendarCheck,
  Users,
  Briefcase,
  TrendingUp,
  ShieldCheck,
} from "lucide-react";
import { useTranslations } from "next-intl";

const features = [
  { icon: CalendarCheck, labelKey: "featureAppointmentScheduling" },
  { icon: Users, labelKey: "featurePatientManagement" },
  { icon: Briefcase, labelKey: "featureStaffWorkflows" },
  { icon: TrendingUp, labelKey: "featureRevenueTracking" },
  { icon: ShieldCheck, labelKey: "featureSecureClinicAccess" },
];

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const t = useTranslations("auth");
  return (
    <div className="dark forced-dark-scope flex min-h-dvh bg-background text-foreground">

      {/* ══════════════════════════════════════════
          LEFT  —  Cinematic brand panel (lg+)
          ══════════════════════════════════════════ */}
      <aside className="relative hidden lg:flex lg:w-[56%] xl:w-[60%] flex-col overflow-hidden">

        {/* Base — near-black deep space */}
        <div className="absolute inset-0 bg-[#080e18]" />

        {/* ── Atmospheric / space layer ── */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">

          {/* ── Orbital ring arc ── */}
          <div
            className="absolute rounded-full"
            style={{
              insetInlineEnd: "-20%",
              top: "4%",
              width: "70%",
              height: "82%",
              border: "1px solid rgba(0,220,255,0.13)",
              boxShadow: "inset 0 0 80px rgba(0,200,255,0.03)",
            }}
          />

          {/* Orbital bright glowing dot — top-right of ring */}
          <div
            className="absolute h-3.5 w-3.5 rounded-full"
            style={{
              insetInlineEnd: "21%",
              top: "4.5%",
              background: "rgba(0,220,255,1)",
              boxShadow:
                "0 0 6px 2px rgba(0,220,255,0.9), " +
                "0 0 20px 8px rgba(0,210,255,0.55), " +
                "0 0 50px 18px rgba(0,195,255,0.25), " +
                "0 0 100px 40px rgba(0,180,255,0.10)",
            }}
          />

          {/* Soft halo bloom around the bright dot */}
          <div
            className="absolute rounded-full"
            style={{
              insetInlineEnd: "18%",
              top: "1%",
              width: "9%",
              height: "11%",
              background:
                "radial-gradient(ellipse, rgba(0,210,255,0.16) 0%, transparent 70%)",
              filter: "blur(20px)",
            }}
          />

          {/* ── Teal aurora base — deep lower-left bloom ── */}
          <div
            className="aurora-blob-3 absolute"
            style={{
              bottom: "-8%",
              insetInlineStart: "-5%",
              width: "72%",
              height: "58%",
              borderRadius: "50%",
              background:
                "radial-gradient(ellipse, rgba(20,184,166,0.28) 0%, rgba(6,148,162,0.12) 40%, transparent 72%)",
              filter: "blur(90px)",
            }}
          />

          {/* Secondary right-side cyan depth blob */}
          <div
            className="aurora-blob-2 absolute"
            style={{
              top: "28%",
              insetInlineEnd: "-10%",
              width: "50%",
              height: "55%",
              borderRadius: "50%",
              background:
                "radial-gradient(ellipse, rgba(0,180,210,0.14) 0%, transparent 68%)",
              filter: "blur(80px)",
            }}
          />

          {/* Upper-left faint teal glow */}
          <div
            className="aurora-blob-1 absolute"
            style={{
              top: "-10%",
              insetInlineStart: "-8%",
              width: "50%",
              height: "50%",
              borderRadius: "50%",
              background:
                "radial-gradient(ellipse, rgba(6,148,162,0.15) 0%, transparent 68%)",
              filter: "blur(100px)",
            }}
          />

          {/* Grid overlay */}
          <div
            className="absolute inset-0"
            style={{
              opacity: 0.055,
              backgroundImage:
                "linear-gradient(rgba(255,255,255,0.5) 1px,transparent 1px)," +
                "linear-gradient(90deg,rgba(255,255,255,0.5) 1px,transparent 1px)",
              backgroundSize: "44px 44px",
            }}
          />

          {/* Film grain */}
          <div
            className="absolute inset-0 opacity-[0.045] mix-blend-overlay"
            style={{
              backgroundImage:
                "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.6 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")",
            }}
          />

          {/* Vignette edges */}
          <div
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(ellipse 80% 88% at 42% 52%, transparent 35%, rgba(8,14,24,0.72) 100%)",
            }}
          />
        </div>

        {/* ── Panel content ── */}
        <div className="relative z-10 flex flex-1 flex-col justify-between p-12 xl:p-16">

          {/* Top — logo lockup */}
          <Link
            href="/"
            className="flex items-center gap-3 w-fit"
            aria-label={t("clinicflowHome")}
          >
            <Image
              src="/brand/clinicflow-mark.png"
              alt=""
              width={42}
              height={36}
              className="h-9 w-auto shrink-0 object-contain drop-shadow-[0_0_16px_rgba(0,220,255,0.90)]"
              priority
            />
            <div>
              <p className="text-[1.4rem] font-semibold leading-none tracking-tight text-white">
                {t("clinicflow")}</p>
              <p className="mt-1 text-[11px] font-medium tracking-[0.18em] uppercase text-white/36">
                {t("clinicCrmPlatform")}</p>
            </div>
          </Link>

          {/* Center — hero marketing block */}
          <div className="space-y-9">

            {/* Live status pill */}
            <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.15] bg-white/[0.07] px-3.5 py-1.5 text-[11px] font-medium tracking-wide text-white/80 backdrop-blur-sm">
              <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span className="absolute inset-0 rounded-full bg-emerald-300 opacity-75 pulse-dot" />
                <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-300" />
              </span>
              {t("onlineSecureKvkkReady")}
            </span>

            {/* Headline */}
            <div className="space-y-3">
              <h1
                className="relative text-[2.2rem] xl:text-[2.8rem] font-semibold leading-[0.96] tracking-tight text-white auth-stagger"
                style={{ animationDelay: "80ms" }}
              >
                <span
                  aria-hidden
                  className="pointer-events-none absolute -inset-8 -z-10 rounded-[40%] opacity-30 blur-3xl"
                  style={{
                    background:
                      "radial-gradient(ellipse at center, oklch(0.85 0.18 200 / 0.28) 0%, transparent 65%)",
                  }}
                />
                {t("smartClinicManagement")}{" "}
                <span className="block mt-1.5 font-display italic font-normal text-cyan-200">
                  {t("forModernMedicalTeams")}</span>
              </h1>

              <p
                className="max-w-[28rem] text-[0.9375rem] leading-relaxed text-white/55 auth-stagger"
                style={{ animationDelay: "160ms" }}
              >
                {t("appointmentsPatientRecordsFollowUpsBilling")}</p>
            </div>

            {/* Interactive feature list — icon + text, text doubles on hover */}
            <ul className="space-y-2">
              {features.map(({ icon: Icon, labelKey }, i) => (
                <li
                  key={labelKey}
                  className="auth-feature-item group flex items-center gap-3 cursor-default py-1 transition-all duration-300 ease-out [will-change:transform] hover:translate-x-2 rtl:hover:-translate-x-2"
                  style={{ animationDelay: `${240 + i * 75}ms` }}
                >
                  {/* Icon — glows and scales on hover */}
                  <span className="flex shrink-0 items-center justify-center transition-all duration-300 group-hover:drop-shadow-[0_0_12px_rgba(0,210,255,0.80)]">
                    <Icon className="h-[18px] w-[18px] text-cyan-400/60 transition-all duration-300 group-hover:text-cyan-300 group-hover:scale-125" />
                  </span>

                  {/* Label — always at full size, brightens on hover */}
                  <span className="text-[1.15rem] font-medium leading-none text-white/60 transition-colors duration-300 ease-out group-hover:text-white/95 group-hover:font-semibold">
                  {t(labelKey)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Bottom — copyright */}
          <p className="text-[11px] text-white/22">
            © {new Date().getFullYear()} {t("clinicflowAllRightsReserved")}</p>
        </div>
      </aside>

      {/* ══════════════════════════════════════════
          RIGHT  —  Auth form panel
          ══════════════════════════════════════════ */}
      <main className="auth-right-panel relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 py-12">

        {/* Dot-grid texture */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.016]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, oklch(0.6 0.14 208) 1px, transparent 0)",
            backgroundSize: "28px 28px",
          }}
        />

        {/* Ambient teal glow center */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 70% 55% at 50% 50%, oklch(0.6 0.14 208 / 0.055) 0%, transparent 72%)",
          }}
        />

        {/* Mobile logo — hidden on lg+ */}
        <Link
          href="/"
          className="relative z-10 mb-8 flex flex-col items-center gap-2 lg:hidden"
          aria-label={t("clinicflowHome")}
        >
          <Image
            src="/brand/clinicflow-mark.png"
            alt={t("clinicflow")}
            width={47}
            height={40}
            className="h-10 w-auto object-contain drop-shadow-[0_0_14px_rgba(0,220,255,0.60)]"
            priority
          />
          <p className="text-base font-semibold tracking-tight">{t("clinicflow")}</p>
          <p className="text-[10px] font-medium tracking-[0.16em] uppercase text-muted-foreground/50">
            {t("clinicCrmPlatform")}</p>
        </Link>

        {/* Auth card */}
        <div className="auth-card relative z-10 w-full max-w-[400px] rounded-2xl border border-border/50 bg-card/70 p-8 shadow-[0_8px_32px_-8px_oklch(0.6_0.14_208_/_0.15)] backdrop-blur-xl">
          {children}
        </div>

        <p className="relative z-10 mt-6 text-center text-xs text-muted-foreground/55">
          © {new Date().getFullYear()} {t("clinicflow2")}</p>
      </main>

    </div>
  );
}
