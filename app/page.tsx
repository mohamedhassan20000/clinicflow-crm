import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { MarketingPage } from "@/components/marketing/marketing-page";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";
import { getMarketingCopy } from "@/lib/marketing-copy";
import type { MessageTranslator } from "@/lib/i18n/translator";
import { resolveLocale } from "@/lib/preferences/server";
import {
  buildHomepageStructuredData,
  serializeStructuredData,
} from "@/lib/seo/structured-data";
import { createClient } from "@/lib/supabase/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing");
  const socialImage = "/brand/opengraph-image.png";
  return {
    title: { absolute: t("seo.title") },
    description: t("seo.description"),
    alternates: { canonical: "/" },
    robots: { index: true, follow: true },
    openGraph: {
      type: "website",
      url: "/",
      siteName: "ClinicFlow",
      title: t("seo.socialTitle"),
      description: t("seo.socialDescription"),
      images: [{
        url: socialImage,
        width: 1200,
        height: 630,
        alt: t("seo.imageAlt"),
      }],
    },
    twitter: {
      card: "summary_large_image",
      title: t("seo.socialTitle"),
      description: t("seo.twitterDescription"),
      images: [{
        url: socialImage,
        width: 1200,
        height: 630,
        alt: t("seo.imageAlt"),
      }],
    },
  };
}

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

  // P2A: the marketing switcher writes the anonymous locale cookie only — it touches no account,
  // and an authenticated user's stored language never reads from it (§4.1).
  const [locale, t, marketingTranslations] = await Promise.all([
    resolveLocale(),
    getTranslations("language"),
    getTranslations("marketing"),
  ]);
  const marketingCopy = getMarketingCopy(
    marketingTranslations as unknown as MessageTranslator,
  );
  const structuredData = buildHomepageStructuredData({
    description: marketingTranslations("seo.description"),
    faqItems: marketingCopy.faq.items,
  });
  const languageSwitcher = (
    <LanguageSwitcher
      locale={locale}
      scope="marketing"
      className="h-11 w-auto gap-2 rounded-full border-[var(--m-line)] bg-transparent px-4 text-[var(--m-ink)] hover:bg-[var(--m-soft)]"
      aria-label={t("marketingLabel")}
      labels={{
        selectLabel: t("selectLabel"),
        updated: t("updated"),
        updateFailed: t("updateFailed"),
      }}
    />
  );

  return (
    <>
      <script
        // Supabase implicit-flow fragments are invisible to the server. Keep
        // the old recovery handoff without redirecting ordinary visitors.
        dangerouslySetInnerHTML={{
          __html: `(function(){try{var h=window.location.hash||"";if(h.indexOf("access_token=")!==-1||h.indexOf("token_hash=")!==-1){window.location.replace("/auth/confirm"+h)}}catch(e){}})();`,
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeStructuredData(structuredData) }}
      />
      <MarketingPage statusPromise={registrationStatus} languageSwitcher={languageSwitcher} />
    </>
  );
}
