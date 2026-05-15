import Image from "next/image";
import Link from "next/link";

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="auth-right-panel relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 py-12">
      {/* ── Ambient background ── */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="aurora-blob-1 absolute -top-40 -left-20 h-[42rem] w-[42rem] rounded-full bg-cyan-500/10 blur-[120px]" />
        <div className="aurora-blob-2 absolute -bottom-20 -right-20 h-[34rem] w-[34rem] rounded-full bg-sky-400/[0.07] blur-[100px]" />
        <div className="aurora-blob-3 absolute top-1/2 left-1/2 h-[30rem] w-[30rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-teal-500/[0.07] blur-[140px]" />
        {/* Subtle dot grid */}
        <div
          className="absolute inset-0 opacity-[0.018]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, oklch(0.6 0.14 208) 1px, transparent 0)",
            backgroundSize: "28px 28px",
          }}
        />
        {/* Film grain */}
        <div
          className="absolute inset-0 opacity-[0.025] mix-blend-overlay"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.6 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")",
          }}
        />
      </div>

      {/* ── Logo lockup ── */}
      <Link
        href="/login"
        className="relative z-10 mb-8 flex items-center"
        aria-label="ClinicFlow home"
      >
        <Image
          src="/brand/clinicflow-logo.png"
          alt="ClinicFlow"
          width={168}
          height={42}
          className="h-10 w-auto object-contain"
          priority
        />
      </Link>

      {/* ── Auth card ── */}
      <div className="auth-card relative z-10 w-full max-w-[420px] rounded-2xl border border-border/50 bg-card/70 p-8 shadow-[0_8px_32px_-8px_oklch(0.6_0.14_208_/_0.15)] backdrop-blur-xl">
        {children}
      </div>

      {/* ── Footer ── */}
      <p className="relative z-10 mt-6 text-center text-xs text-muted-foreground/60">
        © {new Date().getFullYear()} ClinicFlow. All rights reserved.
      </p>
    </div>
  );
}
