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
  const [t, marketing] = await Promise.all([
    getTranslations("legal.privacy"),
    getTranslations("marketing.seo"),
  ]);
  const socialImage = "/brand/opengraph-image.png";
  const canonicalUrl = `${MARKETING_SITE_URL}/privacy`;

  return {
    title: { absolute: t("metadataTitle") },
    description: t("description"),
    alternates: { canonical: canonicalUrl },
    robots: { index: true, follow: true },
    openGraph: {
      type: "website",
      url: canonicalUrl,
      siteName: "ClinicFlow",
      title: t("metadataTitle"),
      description: t("description"),
      images: [{
        url: socialImage,
        width: 1200,
        height: 630,
        alt: marketing("imageAlt"),
      }],
    },
    twitter: {
      card: "summary_large_image",
      title: t("metadataTitle"),
      description: t("description"),
      images: [{
        url: socialImage,
        width: 1200,
        height: 630,
        alt: marketing("imageAlt"),
      }],
    },
  };
}

export default function PrivacyPage() {
  return <LegalPage document="privacy" />;
}
