import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing-page";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "ClinicFlow — Your clinic, in one calm workspace",
  description:
    "Run appointments, patients, billing, and clinic operations from one secure workspace built for modern private clinics.",
  robots: { index: true, follow: true },
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function Home({ searchParams }: PageProps) {
  const params = await searchParams;

  // Preserve the existing password-reset and magic-link handoff. Hash-based
  // implicit-flow tokens are handled by /auth/confirm links generated today.
  const authKeys = ["code", "token_hash", "type", "error", "error_description"];
  if (authKeys.some((key) => typeof params[key] === "string")) {
    const query = new URLSearchParams();
    for (const key of [...authKeys, "next"]) {
      const value = params[key];
      if (typeof value === "string" && value) query.set(key, value);
    }
    if (!query.has("next")) query.set("next", "/reset-password");
    const { redirect } = await import("next/navigation");
    redirect(`/auth/confirm?${query.toString()}`);
  }

  const supabase = await createClient();
  const { data } = await supabase.rpc("get_public_registration_status");
  const status = data?.[0];

  return (
    <>
      <script
        // Supabase implicit-flow fragments are invisible to the server. Keep
        // the old recovery handoff without redirecting ordinary visitors.
        dangerouslySetInnerHTML={{
          __html: `(function(){try{var h=window.location.hash||"";if(h.indexOf("access_token=")!==-1||h.indexOf("token_hash=")!==-1){window.location.replace("/auth/confirm"+h)}}catch(e){}})();`,
        }}
      />
      <MarketingPage
        registrationMode={status?.registration_mode ?? "invite_only"}
        weeklyLimit={status?.weekly_invite_limit ?? 20}
        acceptedThisWeek={Number(status?.accepted_clinics_this_week ?? 0)}
      />
    </>
  );
}
