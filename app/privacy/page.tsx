import type { Metadata } from "next";
import { LegalPage } from "@/components/marketing/legal-page";
import { MARKETING_SITE_URL, marketingCopy as copy } from "@/lib/marketing-copy";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: copy.legal.privacy.description,
  alternates: { canonical: `${MARKETING_SITE_URL}/privacy` },
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return <LegalPage content={copy.legal.privacy} />;
}
