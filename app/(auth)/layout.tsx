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
            <div className="space-y-3">
              <p className="text-sm font-medium uppercase tracking-[0.15em] text-cyan-300/90">
                Clinic management, reimagined
              </p>
              <h1 className="text-4xl xl:text-5xl font-semibold leading-[1.1] text-white">
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
                <li key={title} className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15">
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
      <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden bg-background px-6 py-12">
        {/* subtle background texture for right panel */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.025]"
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
            <Stethoscope className="h-4.5 w-4.5" />
          </span>
          <span className="text-lg font-semibold tracking-tight">ClinicFlow</span>
        </Link>

        <div className="relative z-10 w-full max-w-[400px]">
          {children}
        </div>

        <p className="mt-8 text-center text-xs text-muted-foreground/60">
          © {new Date().getFullYear()} ClinicFlow
        </p>
      </main>
    </div>
  );
}
