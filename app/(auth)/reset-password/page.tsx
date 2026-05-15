import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { KeyRound } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export const metadata: Metadata = { title: "Set new password" };

export default async function ResetPasswordPage() {
  // The /auth/confirm callback exchanges the email link's code for a session
  // before forwarding here. If we somehow land here without one, push back to
  // the forgot-password screen so the user can ask for a fresh email.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/forgot-password?expired=1");

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <KeyRound className="h-5 w-5" />
        </span>
        <div className="space-y-1.5">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Set a new password
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Enter your new password twice to update your account.
          </p>
        </div>
      </div>

      <ResetPasswordForm />
    </div>
  );
}
