import Link from "next/link";
import {
  Stethoscope,
  CalendarCheck,
  Users,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";

const features = [
  {
    icon: CalendarCheck,
    title: "Smart scheduling",
    desc: "Conflict-free booking with real-time slot detection.",
  },
  {
    icon: Users,
    title: "Patient records",
    desc: "Unified profiles, history, and medical notes in one place.",
  },
  {
    icon: TrendingUp,
    title: "Live dashboards",
    desc: "Role-scoped KPIs and appointment analytics.",
  },
  {
    icon: ShieldCheck,
    title: "Enterprise security",
    desc: "Row-level security, full audit trail, KVKK-ready.",
  },
];

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-dvh">
      {/* ── Left brand panel (desktop only) ── */}
      <aside className="relative hidden lg:flex lg:w-[48%] xl:w-[52%] flex-col overflow-hidden">
        {/* deep teal gradient base */}
        <div className="absolute inset-0 bg-[linear-gradient(135deg,_#0c4a6e_0%,_#075985_40%,_#0891b2_100%)]" />

        {/* aurora blobs */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="aurora-blob-1 absolute -top-32 -left-32 h-[36rem] w-[36rem] rounded-full bg-cyan-400/20 blur-[80px]" />
          <div className="aurora-blob-2 absolute top-1/2 -right-24 h-[28rem] w-[28rem] rounded-full bg-sky-300/15 blur-[70px]" />
          <div className="aurora-blob-3 absolute -bottom-24 left-1/4 h-[32rem] w-[32rem] rounded-full bg-teal-500/25 blur-[90px]" />
          {/* subtle grid overlay */}
          <div
            className="absolute inset-0 opacity-[0.04]"
            style={{
              backgroundImage:
                "linear-gradient(rgba(255,255,255,0.6) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.6) 1px,transparent 1px)",
              backgroundSize: "40px 40px",
            }}
          />
          {/* film grain overlay */}
          <div
            className="absolute inset-0 opacity-[0.05] mix-blend-overlay"
            style={{
              backgroundImage:
                "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.6 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")",
            }}
          />
        </div>

        {/* content */}
        <div className="relative z-10 flex flex-1 flex-col justify-between p-10 xl:p-14">
          {/* logo */}
          <Link
            href="/login"
            className="flex items-center gap-3 w-fit"
            aria-label="ClinicFlow home"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/25 backdrop-blur-sm">
              <Stethoscope className="h-5 w-5 text-white" />
            </span>
            <span className="text-xl font-semibold tracking-tight text-white">
              ClinicFlow
            </span>
          </Link>

          {/* hero copy */}
          <div className="space-y-6">
            <div className="space-y-4">
              {/* live status pill */}
              <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-medium tracking-wide text-white/90 backdrop-blur-sm">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inset-0 rounded-full bg-emerald-300 opacity-75 pulse-dot" />
                  <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-300" />
                </span>
                Online — RLS active
              </span>

              <h1 className="relative text-4xl xl:text-5xl font-semibold leading-[0.98] tracking-tight text-white">
                <span
                  aria-hidden
                  className="pointer-events-none absolute -inset-8 -z-10 rounded-[40%] opacity-50 blur-2xl"
                  style={{
                    background:
                      "radial-gradient(ellipse at center, oklch(0.85 0.15 200 / 0.25) 0%, transparent 65%)",
                  }}
                />
                Run your clinic{" "}
                <span
                  className="block font-display italic font-normal text-cyan-200"
                  style={{ fontFamily: "var(--font-instrument)" }}
                >
                  effortlessly.
                </span>
              </h1>
              <p className="max-w-sm text-base leading-relaxed text-white/65">
                One platform for scheduling, patient records, and team
                collaboration — purpose-built for private clinics.
              </p>
            </div>

            {/* feature list */}
            <ul className="space-y-3">
              {features.map(({ icon: Icon, title, desc }) => (
                <li
                  key={title}
                  className="group flex items-start gap-3 transition-transform duration-150 ease-out hover:-translate-y-0.5"
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-white/15 to-white/5 ring-1 ring-white/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.15)] transition-colors group-hover:ring-cyan-300/40">
                    <Icon className="h-3.5 w-3.5 text-cyan-300" />
                  </span>
                  <div>
                    <p className="text-sm font-medium text-white">{title}</p>
                    <p className="text-xs leading-relaxed text-white/55">{desc}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* footer */}
          <p className="text-xs text-white/30">
            © {new Date().getFullYear()} ClinicFlow. All rights reserved.
          </p>
        </div>
      </aside>

      {/* ── Right form panel ── */}
      <main className="auth-right-panel relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 py-12">
        {/* subtle background texture for right panel */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.015]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, oklch(0.6 0.14 208) 1px, transparent 0)",
            backgroundSize: "28px 28px",
          }}
        />

        {/* mobile logo — only shows below lg */}
        <Link
          href="/login"
          className="mb-8 flex items-center gap-2.5 lg:hidden"
          aria-label="ClinicFlow home"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow">
            <Stethoscope className="h-[18px] w-[18px]" />
          </span>
          <span className="text-lg font-semibold tracking-tight">ClinicFlow</span>
        </Link>

        <div className="auth-card relative z-10 w-full max-w-[400px] rounded-2xl border border-border/50 bg-card/70 p-8 shadow-[0_8px_32px_-8px_oklch(0.6_0.14_208_/_0.15)] backdrop-blur-xl">
          {children}
        </div>

        <p className="mt-8 text-center text-xs text-muted-foreground/60">
          © {new Date().getFullYear()} ClinicFlow
        </p>
      </main>
    </div>
  );
}
