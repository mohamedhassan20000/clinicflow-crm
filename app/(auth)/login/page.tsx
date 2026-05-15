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
    <div className="space-y-6">
      {/* Simple heading */}
      <div className="space-y-1.5 auth-stagger" style={{ animationDelay: "60ms" }}>
        <h2 className="text-[1.75rem] font-semibold leading-tight tracking-tight text-foreground">
          Welcome back
        </h2>
        <p className="text-sm text-muted-foreground">
          Sign in to your ClinicFlow account
        </p>
      </div>

      {/* Password-changed success notice */}
      {passwordChanged && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
          Password updated. Sign in again with your new password.
        </div>
      )}

      {/* Login form — auth logic untouched */}
      <div className="auth-stagger" style={{ animationDelay: "120ms" }}>
        <LoginForm />
      </div>
    </div>
  );
}
