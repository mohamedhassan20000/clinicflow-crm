import Image from "next/image";
import Link from "next/link";
import {
  CalendarCheck,
  Users,
  Briefcase,
  TrendingUp,
  ShieldCheck,
} from "lucide-react";

const features = [
  { icon: CalendarCheck, label: "Appointment Scheduling" },
  { icon: Users,         label: "Patient Management"      },
  { icon: Briefcase,     label: "Staff Workflows"         },
  { icon: TrendingUp,    label: "Revenue Tracking"        },
  { icon: ShieldCheck,   label: "Secure Clinic Access"    },
];

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-dvh">

      {/* ══════════════════════════════════════════
          LEFT  —  Cinematic brand panel (lg+)
          ══════════════════════════════════════════ */}
      <aside className="relative hidden lg:flex lg:w-[56%] xl:w-[60%] flex-col overflow-hidden">

        {/* Deep cinematic gradient — very dark navy base */}
        <div className="absolute inset-0 bg-[linear-gradient(150deg,#020b14_0%,#041e33_30%,#063652_55%,#084d6e_80%,#0a6384_100%)]" />

        {/* ── Atmospheric layer ── */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">

          {/* Primary aurora blobs — strong and vivid */}
          <div className="aurora-blob-1 absolute -top-32 -left-16 h-[56rem] w-[56rem] rounded-full bg-cyan-400/[0.22] blur-[100px]" />
          <div className="aurora-blob-2 absolute top-[20%] -right-24 h-[42rem] w-[42rem] rounded-full bg-sky-300/[0.16] blur-[90px]" />
          <div className="aurora-blob-3 absolute -bottom-20 left-[12%] h-[50rem] w-[50rem] rounded-full bg-teal-400/[0.24] blur-[110px]" />

          {/* Central bloom — the bright glowing hotspot in the reference */}
          <div
            className="absolute"
            style={{
              top: "8%",
              left: "38%",
              width: "62%",
              height: "55%",
              background:
                "radial-gradient(ellipse at center, rgba(0,210,255,0.18) 0%, rgba(0,180,220,0.08) 38%, transparent 72%)",
              filter: "blur(24px)",
            }}
          />

          {/* Secondary warm teal accent — lower-left depth */}
          <div
            className="absolute -bottom-8 -left-8 h-[32rem] w-[32rem] rounded-full opacity-40"
            style={{
              background: "radial-gradient(circle, rgba(20,184,166,0.35) 0%, transparent 65%)",
              filter: "blur(80px)",
            }}
          />

          {/* Subtle grid — more visible than before */}
          <div
            className="absolute inset-0 opacity-[0.065]"
            style={{
              backgroundImage:
                "linear-gradient(rgba(255,255,255,0.55) 1px,transparent 1px)," +
                "linear-gradient(90deg,rgba(255,255,255,0.55) 1px,transparent 1px)",
              backgroundSize: "44px 44px",
            }}
          />

          {/* Film grain — subtle texture */}
          <div
            className="absolute inset-0 opacity-[0.048] mix-blend-overlay"
            style={{
              backgroundImage:
                "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.6 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")",
            }}
          />

          {/* Edge vignette — cinematic depth */}
          <div
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(ellipse 80% 86% at 44% 50%, transparent 38%, rgba(2,11,20,0.65) 100%)",
            }}
          />
        </div>

        {/* ── Panel content ── */}
        <div className="relative z-10 flex flex-1 flex-col justify-between p-12 xl:p-16">

          {/* Top — logo lockup */}
          <Link
            href="/login"
            className="flex items-center gap-3 w-fit"
            aria-label="ClinicFlow home"
          >
            {/* Logo mark — ~2× larger, height matches wordmark */}
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
                ClinicFlow
              </p>
              <p className="mt-1 text-[11px] font-medium tracking-[0.18em] uppercase text-white/36">
                Clinic CRM Platform
              </p>
            </div>
          </Link>

          {/* Center — hero marketing block */}
          <div className="space-y-9">

            {/* Live status pill */}
            <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.15] bg-white/[0.08] px-3.5 py-1.5 text-[11px] font-medium tracking-wide text-white/80 backdrop-blur-sm">
              <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span className="absolute inset-0 rounded-full bg-emerald-300 opacity-75 pulse-dot" />
                <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-300" />
              </span>
              Online — Secure &amp; KVKK-ready
            </span>

            {/* Headline */}
            <div className="space-y-3">
              <h1
                className="relative text-[2.2rem] xl:text-[2.8rem] font-semibold leading-[0.96] tracking-tight text-white auth-stagger"
                style={{ animationDelay: "80ms" }}
              >
                {/* Glow halo behind heading */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute -inset-8 -z-10 rounded-[40%] opacity-30 blur-3xl"
                  style={{
                    background:
                      "radial-gradient(ellipse at center, oklch(0.85 0.18 200 / 0.28) 0%, transparent 65%)",
                  }}
                />
                Smart clinic management{" "}
                <span
                  className="block mt-1.5 font-display italic font-normal text-cyan-200"
                  style={{ fontFamily: "var(--font-instrument)" }}
                >
                  for modern medical teams
                </span>
              </h1>

              <p
                className="max-w-[28rem] text-[0.9375rem] leading-relaxed text-white/55 auth-stagger"
                style={{ animationDelay: "160ms" }}
              >
                Appointments, patient records, follow-ups, billing, and staff
                workflows in one secure platform.
              </p>
            </div>

            {/* Interactive feature list — minimal, no background cards */}
            <ul className="space-y-1">
              {features.map(({ icon: Icon, label }, i) => (
                <li
                  key={label}
                  className="auth-feature-item group flex items-center gap-3 cursor-default py-1.5 transition-all duration-200 ease-out [will-change:transform] hover:translate-x-2"
                  style={{ animationDelay: `${240 + i * 75}ms` }}
                >
                  <span className="flex shrink-0 items-center justify-center transition-all duration-200 group-hover:drop-shadow-[0_0_10px_rgba(0,210,255,0.72)]">
                    <Icon className="h-[18px] w-[18px] text-cyan-400/58 transition-all duration-200 group-hover:text-cyan-200 group-hover:scale-110" />
                  </span>
                  <span className="text-[0.8125rem] font-medium text-white/60 transition-colors duration-200 group-hover:text-white/92">
                    {label}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Bottom — copyright */}
          <p className="text-[11px] text-white/22">
            © {new Date().getFullYear()} ClinicFlow. All rights reserved.
          </p>
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
          href="/login"
          className="relative z-10 mb-8 flex flex-col items-center gap-2 lg:hidden"
          aria-label="ClinicFlow home"
        >
          <Image
            src="/brand/clinicflow-mark.png"
            alt="ClinicFlow"
            width={47}
            height={40}
            className="h-10 w-auto object-contain drop-shadow-[0_0_14px_rgba(0,220,255,0.60)]"
            priority
          />
          <p className="text-base font-semibold tracking-tight">ClinicFlow</p>
          <p className="text-[10px] font-medium tracking-[0.16em] uppercase text-muted-foreground/50">
            Clinic CRM Platform
          </p>
        </Link>

        {/* Auth card */}
        <div className="auth-card relative z-10 w-full max-w-[400px] rounded-2xl border border-border/50 bg-card/70 p-8 shadow-[0_8px_32px_-8px_oklch(0.6_0.14_208_/_0.15)] backdrop-blur-xl">
          {children}
        </div>

        <p className="relative z-10 mt-6 text-center text-xs text-muted-foreground/55">
          © {new Date().getFullYear()} ClinicFlow
        </p>
      </main>

    </div>
  );
}
