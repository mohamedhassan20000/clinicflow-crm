import { MARKETING_SITE_URL } from "@/lib/marketing-copy";

export type StructuredDataFaqItem = {
  question: string;
  answer: string;
};

type WebSiteSchema = {
  "@type": "WebSite";
  "@id": string;
  name: "ClinicFlow";
  alternateName: ["Clinic Flow", "كلينيك فلو"];
  url: string;
};

type OrganizationSchema = {
  "@type": "Organization";
  "@id": string;
  name: "ClinicFlow";
  url: string;
  logo: string;
};

type SoftwareApplicationSchema = {
  "@type": "SoftwareApplication";
  "@id": string;
  name: "ClinicFlow";
  applicationCategory: "BusinessApplication";
  applicationSubCategory: "Clinic Management Software";
  operatingSystem: "Web";
  url: string;
  description: string;
};

type FaqPageSchema = {
  "@type": "FAQPage";
  "@id": string;
  mainEntity: Array<{
    "@type": "Question";
    name: string;
    acceptedAnswer: {
      "@type": "Answer";
      text: string;
    };
  }>;
};

export type HomepageStructuredData = {
  "@context": "https://schema.org";
  "@graph": [WebSiteSchema, OrganizationSchema, SoftwareApplicationSchema, FaqPageSchema];
};

export function buildHomepageStructuredData({
  description,
  faqItems,
}: {
  description: string;
  faqItems: readonly StructuredDataFaqItem[];
}): HomepageStructuredData {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${MARKETING_SITE_URL}/#website`,
        name: "ClinicFlow",
        alternateName: ["Clinic Flow", "كلينيك فلو"],
        url: MARKETING_SITE_URL,
      },
      {
        "@type": "Organization",
        "@id": `${MARKETING_SITE_URL}/#organization`,
        name: "ClinicFlow",
        url: MARKETING_SITE_URL,
        logo: `${MARKETING_SITE_URL}/brand/icon-512.png`,
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${MARKETING_SITE_URL}/#software-application`,
        name: "ClinicFlow",
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "Clinic Management Software",
        operatingSystem: "Web",
        url: MARKETING_SITE_URL,
        description,
      },
      {
        "@type": "FAQPage",
        "@id": `${MARKETING_SITE_URL}/#faq`,
        mainEntity: faqItems.map(({ question, answer }) => ({
          "@type": "Question",
          name: question,
          acceptedAnswer: {
            "@type": "Answer",
            text: answer,
          },
        })),
      },
    ],
  };
}

export function serializeStructuredData(data: HomepageStructuredData): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
