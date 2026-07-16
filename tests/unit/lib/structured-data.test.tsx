import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import arMessages from "@/messages/ar.json";
import enMessages from "@/messages/en.json";
import { getMarketingCopy } from "@/lib/marketing-copy";
import type { MessageTranslator } from "@/lib/i18n/translator";
import {
  buildHomepageStructuredData,
  serializeStructuredData,
} from "@/lib/seo/structured-data";

vi.mock("@/components/marketing/marketing-page", () => ({
  MarketingPage: () => <main data-marketing-page />,
}));

vi.mock("@/components/i18n/language-switcher", () => ({
  LanguageSwitcher: () => <div data-language-switcher />,
}));

vi.mock("@/lib/preferences/server", () => ({
  resolveLocale: async () => "en",
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async () => ({ data: [] }),
  }),
}));

type PublicLocale = "en" | "ar";

function localizedStructuredData(locale: PublicLocale) {
  const messages = locale === "en" ? enMessages : arMessages;
  const translator = createTranslator({
    locale,
    messages,
    namespace: "marketing",
  }) as unknown as MessageTranslator;
  const copy = getMarketingCopy(translator);

  return {
    copy,
    data: buildHomepageStructuredData({
      description: translator("seo.description"),
      faqItems: copy.faq.items,
    }),
  };
}

describe("Phase 4 homepage structured data", () => {
  it.each(["en", "ar"] as const)(
    "builds the truthful localized %s graph from the rendered FAQ copy",
    (locale) => {
      const { copy, data } = localizedStructuredData(locale);
      const software = data["@graph"][2];
      const faq = data["@graph"][3];

      expect(data["@context"]).toBe("https://schema.org");
      expect(data["@graph"].map((node) => node["@type"])).toEqual([
        "WebSite",
        "Organization",
        "SoftwareApplication",
        "FAQPage",
      ]);
      expect(software.description).toBe(
        locale === "en"
          ? enMessages.marketing.seo.description
          : arMessages.marketing.seo.description,
      );
      expect(faq.mainEntity).toEqual(
        copy.faq.items.map(({ question, answer }) => ({
          "@type": "Question",
          name: question,
          acceptedAnswer: { "@type": "Answer", text: answer },
        })),
      );
      expect(faq.mainEntity).toHaveLength(copy.faq.items.length);
    },
  );

  it("uses only canonical public ClinicFlow URLs and verified application fields", () => {
    const { data } = localizedStructuredData("en");
    const [website, organization, software] = data["@graph"];

    expect(website).toMatchObject({
      name: "ClinicFlow",
      alternateName: ["Clinic Flow", "كلينيك فلو"],
      url: "https://www.clinicflow.fit",
    });
    expect(organization).toMatchObject({
      name: "ClinicFlow",
      url: "https://www.clinicflow.fit",
      logo: "https://www.clinicflow.fit/brand/icon-512.png",
    });
    expect(software).toMatchObject({
      name: "ClinicFlow",
      applicationCategory: "BusinessApplication",
      applicationSubCategory: "Clinic Management Software",
      operatingSystem: "Web",
      url: "https://www.clinicflow.fit",
    });
  });

  it("omits unsupported commercial, reputation, private, and tenant fields", () => {
    const serialized = JSON.stringify(localizedStructuredData("en").data);
    const forbiddenKeys = [
      "aggregateRating",
      "review",
      "reviews",
      "offers",
      "price",
      "priceCurrency",
      "address",
      "telephone",
      "contactPoint",
      "sameAs",
      "installUrl",
      "downloadUrl",
      "patientId",
      "clinicId",
      "tenantId",
    ];

    for (const key of forbiddenKeys) {
      expect(serialized).not.toMatch(new RegExp(`"${key}"\\s*:`));
    }
    for (const privateRoute of ["/dashboard", "/patients", "/operator", "/api/", "/login"]) {
      expect(serialized).not.toContain(privateRoute);
    }
    expect(serialized).not.toContain('"@type":"SearchAction"');
  });

  it("escapes less-than signs before embedding JSON-LD", () => {
    const data = buildHomepageStructuredData({
      description: "</script><script>alert(1)</script>",
      faqItems: [{ question: "Is 1 < 2?", answer: "Yes < always." }],
    });
    const serialized = serializeStructuredData(data);

    expect(serialized).not.toContain("<");
    expect(serialized).toContain("\\u003c/script>");
    expect(JSON.parse(serialized)).toEqual(data);
  });

  it("server-renders one parseable homepage JSON-LD script without replacing the marketing page", async () => {
    const { default: Home } = await import("@/app/page");
    const markup = renderToStaticMarkup(
      await Home({ searchParams: Promise.resolve({}) }),
    );
    const container = document.createElement("div");
    container.innerHTML = markup;
    const scripts = container.querySelectorAll('script[type="application/ld+json"]');

    expect(scripts).toHaveLength(1);
    expect(() => JSON.parse(scripts[0].textContent ?? "")).not.toThrow();
    expect(container.querySelector("main[data-marketing-page]")).not.toBeNull();
  });
});
