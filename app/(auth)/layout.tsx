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
  { icon: Users,         label: "Patient Management" },
  { icon: Briefcase,     label: "Staff Workflows" },
  { icon: TrendingUp,    label: "Revenue Tracking" },
  { icon: ShieldCheck,   label: "Secure Clinic Access" },
];

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-dvh">

      {/* ════════════════════════════════════════
          LEFT BRAND PANEL  (desktop only)
          ════════════════════════════════════════ */}
      <aside className="relative hidden lg:flex lg:w-[55%] xl:w-[58%] flex-col overflow-hidden">

        {/* Deep teal-navy gradient base */}
        <div className="absolute inset-0 bg-[linear-gradient(145deg,_#06172a_0%,_#0b3a5c_42%,_#0c5a7e_75%,_#0891b2_100%)]" />

        {/* Aurora blobs */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="aurora-blob-1 absolute -top-48 -left-24 h-[44rem] w-[44rem] rounded-full bg-cyan-400/[0.13] blur-[96px]" />
          <div className="aurora-blob-2 absolute top-1/2 -right-32 h-[32rem] w-[32rem] rounded-full bg-sky-300/[0.09] blur-[80px]" />
          <div className="aurora-blob-3 absolute -bottom-36 left-[30%] h-[38rem] w-[38rem] rounded-full bg-teal-500/[0.18] blur-[110px]" />

          {/* Subtle grid overlay */}
          <div
            className="absolute inset-0 opacity-[0.035]"
            style={{
              backgroundImage:
                "linear-gradient(rgba(255,255,255,0.55) 1px,transparent 1px)," +
                "linear-gradient(90deg,rgba(255,255,255,0.55) 1px,transparent 1px)",
              backgroundSize: "44px 44px",
            }}
          />

          {/* Film grain */}
          <div
            className="absolute inset-0 opacity-[0.04] mix-blend-overlay"
            style={{
              backgroundImage:
                "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.6 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")",
            }}
          />

          {/* Radial vignette — darkens edges for depth */}
          <div
            className="absolute inset-0 opacity-40"
            style={{
              background:
                "radial-gradient(ellipse 80% 80% at 50% 50%, transparent 50%, rgba(6,23,42,0.7) 100%)",
            }}
          />
        </div>

        {/* ── Panel content ── */}
        <div className="relative z-10 flex flex-1 flex-col justify-between p-10 xl:p-14">

          {/* Top — logo lockup */}
          <div>
            <Link
              href="/login"
              className="flex items-center gap-3 w-fit"
              aria-label="ClinicFlow home"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl overflow-hidden bg-white/10 ring-1 ring-white/20 backdrop-blur-sm">
                <Image
                  src="/brand/clinicflow-mark.svg"
                  alt=""
                  aria-hidden="true"
                  width={32}
                  height={32}
                  className="h-8 w-8 object-contain"
                />
              </span>
              <div>
                <p className="text-[1.1rem] font-semibold leading-none tracking-tight text-white">
                  ClinicFlow
                </p>
                <p className="mt-0.5 text-[10px] font-medium tracking-[0.18em] uppercase text-white/38">
                  Clinic CRM Platform
                </p>
              </div>
            </Link>
          </div>

          {/* Center — hero marketing block */}
          <div className="space-y-8">

            {/* Live status pill */}
            <span className="inline-flex items-center gap-2 rounded-full border border-white/14 bg-white/[0.08] px-3 py-1.5 text-[11px] font-medium tracking-wide text-white/80 backdrop-blur-sm">
              <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span className="absolute inset-0 rounded-full bg-emerald-300 opacity-75 pulse-dot" />
                <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-300" />
              </span>
              Online — Secure &amp; KVKK-ready
            </span>

            {/* Heading */}
            <div className="space-y-3">
              <h1 className="relative text-[2.15rem] xl:text-[2.6rem] font-semibold leading-[0.97] tracking-tight text-white">
                {/* Subtle glow behind headline */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute -inset-6 -z-10 rounded-[40%] opacity-40 blur-2xl"
                  style={{
                    background:
                      "radial-gradient(ellipse at center, oklch(0.85 0.15 200 / 0.22) 0%, transparent 70%)",
                  }}
                />
                Smart clinic management{" "}
                <span
                  className="block mt-1 font-display italic font-normal text-cyan-200"
                  style={{ fontFamily: "var(--font-instrument)" }}
                >
                  for modern medical teams
                </span>
              </h1>
              <p className="max-w-[26rem] text-[0.9375rem] leading-relaxed text-white/58">
                Appointments, patient records, follow-ups, billing, and staff
                workflows in one secure platform.
              </p>
            </div>

            {/* Feature list */}
            <ul className="space-y-2.5">
              {features.map(({ icon: Icon, label }) => (
                <li
                  key={label}
                  className="group flex items-center gap-3"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-white/12 to-white/[0.04] ring-1 ring-white/18 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] transition-colors duration-150 group-hover:ring-cyan-400/35">
                    <Icon className="h-3.5 w-3.5 text-cyan-300" />
                  </span>
                  <span className="text-[0.8125rem] font-medium text-white/80">
                    {label}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Bottom — copyright */}
          <p className="text-[11px] text-white/24">
            © {new Date().getFullYear()} ClinicFlow. All rights reserved.
          </p>
        </div>
      </aside>

      {/* ════════════════════════════════════════
          RIGHT FORM PANEL
          ════════════════════════════════════════ */}
      <main className="auth-right-panel relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 py-12">

        {/* Subtle dot-grid texture */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.016]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, oklch(0.6 0.14 208) 1px, transparent 0)",
            backgroundSize: "28px 28px",
          }}
        />

        {/* Mobile logo — hidden on lg+ */}
        <Link
          href="/login"
          className="relative z-10 mb-8 flex flex-col items-center gap-2 lg:hidden"
          aria-label="ClinicFlow home"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary shadow-lg shadow-primary/25 overflow-hidden">
            <Image
              src="/brand/clinicflow-mark.svg"
              alt="ClinicFlow"
              width={40}
              height={40}
              className="h-10 w-10 object-contain"
              priority
            />
          </span>
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
