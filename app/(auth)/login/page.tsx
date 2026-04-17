import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = {
  title: "Sign in · ClinicFlow",
};

export default function LoginPage() {
  return (
    <div className="w-full max-w-md">
      <Card className="border-border/60 shadow-xl shadow-primary/5 backdrop-blur-sm">
        <CardHeader className="space-y-2 text-center">
          <CardTitle className="font-heading text-2xl">Welcome back</CardTitle>
          <CardDescription>
            Sign in to your ClinicFlow staff account
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>
      <p className="mt-4 text-center text-xs text-muted-foreground">
        Access is restricted to authorized staff only.
      </p>
    </div>
  );
}
