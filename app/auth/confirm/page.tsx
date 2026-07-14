import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { ConfirmRunner } from "@/components/auth/confirm-runner";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataConfirming") };
}

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function pickStr(
  v: string | string[] | undefined,
  fallback = "",
): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return fallback;
}

function safeNext(value: string): string {
  if (!value) return "/dashboard";
  if (!value.startsWith("/") || value.startsWith("//")) return "/dashboard";
  return value;
}

// Supabase recovery / magic-link emails can land here with several different
// link shapes:
//   1. ?code=<pkce-code>                — PKCE flow. MUST be exchanged server-
//      side because the verifier cookie is HTTP-only and unreadable by JS.
//   2. ?token_hash=<hash>&type=recovery — token-hash flow, also server-side.
//   3. #access_token=…&refresh_token=…  — implicit flow (URL fragment, never
//      reaches the server) — handled by the client runner below.
//
// We attempt server-side handling first; if neither query param is present the
// page falls through to the client runner so it can inspect window.location.hash.
export default async function AuthConfirmPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const next = safeNext(pickStr(sp.next, "/dashboard"));
  const code = pickStr(sp.code);
  const tokenHash = pickStr(sp.token_hash);
  const type = pickStr(sp.type);

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      const reason = encodeURIComponent(error.message);
      redirect(`/forgot-password?expired=1&reason=${reason}`);
    }
    redirect(next);
  }

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: type as any,
      token_hash: tokenHash,
    });
    if (error) {
      const reason = encodeURIComponent(error.message);
      redirect(`/forgot-password?expired=1&reason=${reason}`);
    }
    redirect(next);
  }

  // No query params → likely the implicit/hash variant. Hand off to the client.
  return (
    <Suspense fallback={null}>
      <ConfirmRunner />
    </Suspense>
  );
}
