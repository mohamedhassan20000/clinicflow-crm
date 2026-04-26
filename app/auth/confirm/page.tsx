import type { Metadata } from "next";
import { Suspense } from "react";
import { ConfirmRunner } from "@/components/auth/confirm-runner";

export const metadata: Metadata = { title: "Confirming…" };

// Supabase recovery emails can land here with several different link shapes:
//   1. ?code=<pkce-code>                — PKCE / code-exchange flow
//   2. ?token_hash=<hash>&type=recovery — Supabase email-template flow
//   3. #access_token=…&refresh_token=…  — implicit flow (hash, server-invisible)
// We need a client component to read the URL hash, so this page is purely a
// shell that delegates to the client runner.
export default function AuthConfirmPage() {
  return (
    <Suspense fallback={null}>
      <ConfirmRunner />
    </Suspense>
  );
}
