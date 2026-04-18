import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = {
  title: "Sign in",
};

export default function LoginPage() {
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
      <div className="auth-stagger" style={{ animationDelay: "140ms" }}>
        <LoginForm />
      </div>
    </div>
  );
}
