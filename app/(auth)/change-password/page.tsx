import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { ChangePasswordForm } from "@/components/auth/change-password-form";

export const metadata: Metadata = {
  title: "Set new password",
};

export default function ChangePasswordPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-warning/10 text-warning">
          <ShieldAlert className="h-5 w-5" />
        </span>
        <div className="space-y-1.5">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Set a new password
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Your account requires a password change before you can continue.
          </p>
        </div>
      </div>

      <ChangePasswordForm />
    </div>
  );
}
