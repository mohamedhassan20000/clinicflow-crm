import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LegalPage } from "@/components/marketing/legal-page";
import { MARKETING_SITE_URL } from "@/lib/marketing-copy";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal.terms");

  return {
    title: t("title"),
    description: t("description"),
    alternates: { canonical: `${MARKETING_SITE_URL}/terms` },
    robots: { index: true, follow: true },
  };
}

export default function TermsPage() {
  return <LegalPage document="terms" />;
}
