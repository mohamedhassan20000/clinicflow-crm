import type { Metadata } from "next";
import { LegalPage } from "@/components/marketing/legal-page";
import { MARKETING_SITE_URL, marketingCopy as copy } from "@/lib/marketing-copy";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: copy.legal.terms.description,
  alternates: { canonical: `${MARKETING_SITE_URL}/terms` },
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return <LegalPage content={copy.legal.terms} />;
}
