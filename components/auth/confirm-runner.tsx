"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

function safeNext(value: string | null): string {
  if (!value) return "/dashboard";
  if (!value.startsWith("/") || value.startsWith("//")) return "/dashboard";
  return value;
}

// This runner only handles the implicit/hash-fragment variant
// (`#access_token=…&refresh_token=…`). PKCE `?code=` and token-hash
// `?token_hash=` are handled server-side in app/auth/confirm/page.tsx.
export function ConfirmRunner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    const next = safeNext(params.get("next"));
    let active = true;

    async function go() {
      try {
        const hash = window.location.hash.startsWith("#")
          ? window.location.hash.slice(1)
          : "";
        const hashParams = new URLSearchParams(hash);
        const accessToken = hashParams.get("access_token");
        const refreshToken = hashParams.get("refresh_token");

        if (!accessToken || !refreshToken) {
          throw new Error("Confirmation link is missing or invalid.");
        }

        const { error: e } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (e) throw e;
        if (!active) return;
        router.replace(next);
      } catch (e) {
        if (!active) return;
        setError(
          e instanceof Error ? e.message : "Reset link expired or invalid.",
        );
        setTimeout(() => {
          if (active) router.replace("/forgot-password?expired=1");
        }, 1800);
      }
    }

    go();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
      {error ? (
        <>
          <p className="text-sm font-medium text-destructive">{error}</p>
          <p className="text-xs text-muted-foreground">
            Redirecting you to request a new link…
          </p>
        </>
      ) : (
        <>
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Confirming your reset link…
          </p>
        </>
      )}
    </div>
  );
}
