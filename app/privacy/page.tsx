import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LegalPage } from "@/components/marketing/legal-page";
import { MARKETING_SITE_URL } from "@/lib/marketing-copy";

/**
 * P2C — metadata is localized too. `generateMetadata` resolves through the same request config as
 * the page, so a visitor reading the site in Arabic gets an Arabic `<title>` and description rather
 * than an Arabic page wearing an English tab.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal.privacy");

  return {
    title: t("title"),
    description: t("description"),
    alternates: { canonical: `${MARKETING_SITE_URL}/privacy` },
    robots: { index: true, follow: true },
  };
}

export default function PrivacyPage() {
  return <LegalPage document="privacy" />;
}
