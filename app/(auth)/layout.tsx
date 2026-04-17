import Link from "next/link";
import { Stethoscope } from "lucide-react";

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="relative flex min-h-dvh flex-1 flex-col overflow-hidden bg-background">
      {/* background ornaments */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <div className="absolute -top-40 -right-40 h-[32rem] w-[32rem] rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute top-1/3 -left-32 h-[28rem] w-[28rem] rounded-full bg-accent/20 blur-3xl" />
        <div className="absolute -bottom-32 right-1/4 h-[24rem] w-[24rem] rounded-full bg-warning/15 blur-3xl" />
      </div>

      <header className="container mx-auto flex items-center justify-between px-6 py-6">
        <Link
          href="/login"
          className="flex items-center gap-2 font-heading text-lg font-semibold text-foreground"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Stethoscope className="h-5 w-5" />
          </span>
          ClinicFlow
        </Link>
        <p className="hidden text-sm text-muted-foreground sm:block">
          Staff portal · Üsküdar University
        </p>
      </header>

      <main className="container mx-auto flex flex-1 items-center justify-center px-6 pb-16">
        {children}
      </main>

      <footer className="container mx-auto px-6 pb-6 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} ClinicFlow · A graduation project
      </footer>
    </div>
  );
}
