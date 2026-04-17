import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { ChangePasswordForm } from "@/components/auth/change-password-form";

export const metadata: Metadata = {
  title: "Set new password",
};

export default function ChangePasswordPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-warning/10 text-warning">
            <ShieldAlert className="h-4 w-4" />
          </span>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Set a new password
          </h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Your account requires a password change before you can continue.
        </p>
      </div>
      <ChangePasswordForm />
    </div>
  );
}
