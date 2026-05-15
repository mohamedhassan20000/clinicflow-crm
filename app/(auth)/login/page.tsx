import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = {
  title: "Sign in",
};

interface LoginPageProps {
  searchParams: Promise<{ password_changed?: string }>;
}

const featurePills = [
  "Secure Staff Access",
  "Appointment Scheduling",
  "Patient Management",
  "Revenue Tracking",
];

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const passwordChanged = params.password_changed === "1";

  return (
    <div className="space-y-6">
      {/* Marketing header */}
      <div className="space-y-4 auth-stagger" style={{ animationDelay: "60ms" }}>
        <div className="space-y-2">
          <h2 className="text-[1.75rem] leading-[1.1] tracking-tight text-foreground">
            Smart clinic management{" "}
            <span
              className="block italic font-normal text-primary"
              style={{ fontFamily: "var(--font-instrument)" }}
            >
              for modern medical teams
            </span>
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Appointments, patient records, follow-ups, billing, and staff
            workflows in one secure platform.
          </p>
        </div>

        {/* Feature pills */}
        <div className="flex flex-wrap gap-1.5">
          {featurePills.map((label) => (
            <span
              key={label}
              className="inline-flex items-center rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary/75"
            >
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-border/40" />

      {/* Password-changed success notice */}
      {passwordChanged && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
          Password updated. Sign in again with your new password.
        </div>
      )}

      {/* Login form — auth logic untouched */}
      <div className="auth-stagger" style={{ animationDelay: "140ms" }}>
        <LoginForm />
      </div>
    </div>
  );
}
