import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = {
  title: "Sign in",
};

interface LoginPageProps {
  searchParams: Promise<{ password_changed?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const passwordChanged = params.password_changed === "1";

  return (
    <div className="space-y-7">
      <div className="space-y-2 auth-stagger" style={{ animationDelay: "60ms" }}>
        <h2 className="text-[2rem] leading-[1.05] tracking-tight text-foreground">
          <span
            className="italic font-normal"
            style={{ fontFamily: "var(--font-instrument)" }}
          >
            Welcome back.
          </span>
        </h2>
        <p className="text-sm text-muted-foreground">
          Sign in to continue to ClinicFlow.
        </p>
      </div>
      {passwordChanged && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
          Password updated. Sign in again with your new password.
        </div>
      )}
      <div className="auth-stagger" style={{ animationDelay: "140ms" }}>
        <LoginForm />
      </div>
    </div>
  );
}
