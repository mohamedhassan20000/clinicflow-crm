import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MarketingPage } from "@/components/marketing/marketing-page";
import { MARKETING_SITE_URL } from "@/lib/marketing-copy";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  metadataBase: new URL(MARKETING_SITE_URL),
  title: "ClinicFlow — A clearer operating system for private clinics",
  description:
    "Run appointments, patient records, billing, follow-ups, reports, and clinic operations from one calm, role-aware workspace.",
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "ClinicFlow",
    title: "ClinicFlow — A clearer clinic day",
    description:
      "One connected workspace for private-clinic scheduling, patient records, billing, follow-ups, and reports.",
    images: [
      {
        url: "/marketing/dashboard-desktop.avif",
        width: 1440,
        height: 960,
        alt: "ClinicFlow clinic-operations dashboard using fictional demo data",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ClinicFlow — A clearer clinic day",
    description: "One connected operating workspace for modern private clinics.",
    images: ["/marketing/dashboard-desktop.avif"],
  },
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

async function loadRegistrationStatus() {
  const supabase = await createClient();
  const { data } = await supabase.rpc("get_public_registration_status");
  const status = data?.[0];

  return {
    registrationMode: status?.registration_mode ?? "invite_only",
    weeklyLimit: status?.weekly_invite_limit ?? 20,
    acceptedThisWeek: Number(status?.accepted_clinics_this_week ?? 0),
  };
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
    redirect(`/auth/confirm?${query.toString()}`);
  }

  // The public status can be remote and must not hold the marketing shell's
  // first byte. MarketingPage streams live values into stable fallbacks.
  const registrationStatus = loadRegistrationStatus();

  return (
    <>
      <script
        // Supabase implicit-flow fragments are invisible to the server. Keep
        // the old recovery handoff without redirecting ordinary visitors.
        dangerouslySetInnerHTML={{
          __html: `(function(){try{var h=window.location.hash||"";if(h.indexOf("access_token=")!==-1||h.indexOf("token_hash=")!==-1){window.location.replace("/auth/confirm"+h)}}catch(e){}})();`,
        }}
      />
      <MarketingPage statusPromise={registrationStatus} />
    </>
  );
}
