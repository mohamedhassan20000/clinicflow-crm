import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LegalPage } from "@/components/marketing/legal-page";
import { MARKETING_SITE_URL } from "@/lib/marketing-copy";

export async function generateMetadata(): Promise<Metadata> {
  const [t, marketing] = await Promise.all([
    getTranslations("legal.terms"),
    getTranslations("marketing.seo"),
  ]);
  const socialImage = "/brand/opengraph-image.png";
  const canonicalUrl = `${MARKETING_SITE_URL}/terms`;

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

export default function TermsPage() {
  return <LegalPage document="terms" />;
}
