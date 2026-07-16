import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import type { Metadata } from "next";
import { createTranslator } from "next-intl";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import arMessages from "@/messages/ar.json";
import enMessages from "@/messages/en.json";

type PublicLocale = "en" | "ar";

async function loadLocalizedMetadata(locale: PublicLocale) {
  const messages = locale === "en" ? enMessages : arMessages;

  vi.resetModules();
  vi.doMock("next-intl/server", () => ({
    getLocale: async () => locale,
    getMessages: async () => messages,
    getTranslations: async (namespace?: string) =>
      createTranslator({ locale, messages, namespace: namespace as never }),
  }));
  vi.doMock("next/font/google", () => ({
    Manrope: () => ({ variable: "--font-manrope" }),
  }));
  vi.doMock("next/font/local", () => ({
    default: () => ({ variable: "--font-thmanyah" }),
  }));

  const [root, home, privacy, terms] = await Promise.all([
    import("@/app/layout"),
    import("@/app/page"),
    import("@/app/privacy/page"),
    import("@/app/terms/page"),
  ]);

  return {
    root: await root.generateMetadata(),
    home: await home.generateMetadata(),
    privacy: await privacy.generateMetadata(),
    terms: await terms.generateMetadata(),
  };
}

function absoluteTitle(metadata: Metadata) {
  if (!metadata.title || typeof metadata.title === "string" || !("absolute" in metadata.title)) {
    throw new Error("Expected an absolute metadata title");
  }
  return metadata.title.absolute;
}

function canonicalUrl(metadata: Metadata, metadataBase: string | URL) {
  const canonical = metadata.alternates?.canonical;
  if (typeof canonical !== "string" && !(canonical instanceof URL)) {
    throw new Error("Expected a canonical URL");
  }
  return new URL(canonical.toString(), metadataBase).toString();
}

describe("WS9 legal and SEO surfaces", () => {
  it("renders production notices for both legal documents", () => {
    render(<PrivacyPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "About ClinicFlow’s role" })).toBeInTheDocument();
    expect(screen.getByText(/reflects how ClinicFlow currently processes data/i)).toBeInTheDocument();

    render(<TermsPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "ClinicFlow Liability Limitations" })).toBeInTheDocument();
    expect(screen.getByText(/does not diagnose patients or make medical decisions/i)).toBeInTheDocument();
    expect(screen.queryByText(/pending legal review/i)).not.toBeInTheDocument();
  });

  it("indexes only the public marketing/legal surfaces and publishes canonical URLs", () => {
    const robotRules = robots();
    expect(robotRules.sitemap).toBe("https://www.clinicflow.fit/sitemap.xml");
    expect(JSON.stringify(robotRules.rules)).toContain("/operator");

    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toEqual([
      "https://www.clinicflow.fit",
      "https://www.clinicflow.fit/privacy",
      "https://www.clinicflow.fit/terms",
    ]);
  });

  it.each([
    {
      locale: "en" as const,
      brand: "ClinicFlow",
      titles: [
        "ClinicFlow | Clinic Management Software",
        "Privacy Policy | ClinicFlow",
        "Terms of Service | ClinicFlow",
      ],
    },
    {
      locale: "ar" as const,
      brand: "كلينيك فلو",
      titles: [
        "كلينيك فلو | نظام إدارة العيادات",
        "سياسة الخصوصية | كلينيك فلو",
        "شروط الخدمة | كلينيك فلو",
      ],
    },
  ])("resolves $locale public titles, canonicals, and indexing metadata", async ({ locale, brand, titles }) => {
    const metadata = await loadLocalizedMetadata(locale);
    const metadataBase = metadata.root.metadataBase;

    expect(metadataBase).toEqual(new URL("https://www.clinicflow.fit"));
    expect(metadata.root.title).toEqual({ default: "ClinicFlow", template: "%s · ClinicFlow" });
    expect(metadata.root.robots).toMatchObject({ index: false });

    const publicPages = [metadata.home, metadata.privacy, metadata.terms];
    expect(publicPages.map(absoluteTitle)).toEqual(titles);
    for (const title of publicPages.map(absoluteTitle)) {
      expect(title.split(brand)).toHaveLength(2);
      expect(title).not.toContain("·");
    }

    expect(publicPages.map((page) => canonicalUrl(page, metadataBase!))).toEqual([
      "https://www.clinicflow.fit/",
      "https://www.clinicflow.fit/privacy",
      "https://www.clinicflow.fit/terms",
    ]);
    for (const page of publicPages) {
      expect(page.robots).toMatchObject({ index: true, follow: true });
    }
  });

  it("keeps localized metadata-title keys aligned across both catalogs", () => {
    expect(enMessages.marketing.seo.title).toBe("ClinicFlow | Clinic Management Software");
    expect(arMessages.marketing.seo.title).toBe("كلينيك فلو | نظام إدارة العيادات");
    expect(enMessages.legal.privacy.metadataTitle).toBe("Privacy Policy | ClinicFlow");
    expect(arMessages.legal.privacy.metadataTitle).toBe("سياسة الخصوصية | كلينيك فلو");
    expect(enMessages.legal.terms.metadataTitle).toBe("Terms of Service | ClinicFlow");
    expect(arMessages.legal.terms.metadataTitle).toBe("شروط الخدمة | كلينيك فلو");
  });

  it.each([
    { path: "app/icon.png", width: 32, height: 32 },
    { path: "app/apple-icon.png", width: 180, height: 180 },
    { path: "public/brand/icon-192.png", width: 192, height: 192 },
    { path: "public/brand/icon-512.png", width: 512, height: 512 },
    { path: "public/brand/opengraph-image.png", width: 1200, height: 630 },
  ])("ships $path as a valid PNG at $width×$height", async ({ path, width, height }) => {
    const assetPath = resolve(path);
    const [file, metadata] = await Promise.all([stat(assetPath), sharp(assetPath).metadata()]);

    expect(file.size).toBeGreaterThan(0);
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(width);
    expect(metadata.height).toBe(height);
  });

  it("ships a non-empty multi-size ClinicFlow favicon", async () => {
    const favicon = await readFile(resolve("app/favicon.ico"));

    expect(favicon.byteLength).toBeGreaterThan(0);
    expect(favicon.readUInt16LE(0)).toBe(0);
    expect(favicon.readUInt16LE(2)).toBe(1);
    expect(favicon.readUInt16LE(4)).toBe(3);
    expect([0, 1, 2].map((index) => favicon[6 + (index * 16)])).toEqual([16, 32, 48]);
  });

  it.each(["en", "ar"] as const)(
    "publishes localized %s Open Graph and Twitter image metadata",
    async (locale) => {
      const metadata = await loadLocalizedMetadata(locale);
      const messages = locale === "en" ? enMessages : arMessages;
      const image = {
        url: "/brand/opengraph-image.png",
        width: 1200,
        height: 630,
        alt: messages.marketing.seo.imageAlt,
      };
      const pages = [metadata.home, metadata.privacy, metadata.terms];

      for (const page of pages) {
        expect(page.openGraph?.images).toEqual([image]);
        expect(page.twitter).toMatchObject({
          card: "summary_large_image",
          images: [image],
        });
      }

      expect(metadata.privacy.openGraph).toMatchObject({
        url: "https://www.clinicflow.fit/privacy",
        title: messages.legal.privacy.metadataTitle,
        description: messages.legal.privacy.description,
      });
      expect(metadata.terms.openGraph).toMatchObject({
        url: "https://www.clinicflow.fit/terms",
        title: messages.legal.terms.metadataTitle,
        description: messages.legal.terms.description,
      });
    },
  );

  it("ships semantically aligned English and Arabic production privacy policies", () => {
    const arabicPrivacy = arMessages.legal.privacy;
    const englishPrivacy = enMessages.legal.privacy;
    const arabicPolicyText = JSON.stringify(arabicPrivacy);
    const englishPolicyText = JSON.stringify(englishPrivacy);

    expect(arabicPrivacy.sections).toHaveLength(21);
    expect(englishPrivacy.sections).toHaveLength(arabicPrivacy.sections.length);
    expect(arabicPrivacy.updated).toBe("آخر تحديث: 15 يوليو 2026");
    expect(englishPrivacy.updated).toBe("Last updated: July 15, 2026");

    for (const provider of ["Supabase", "Vercel", "Resend", "Upstash", "Sentry", "Open Exchange Rates"]) {
      expect(arabicPolicyText).toContain(provider);
      expect(englishPolicyText).toContain(provider);
    }

    expect(arabicPolicyText).toContain("بيانات المرضى");
    expect(arabicPolicyText).toContain("ملفات الارتباط");
    expect(englishPolicyText).toContain("Patient data");
    expect(englishPolicyText).toContain("Cookies and browser storage");
    expect(englishPolicyText).toContain("soft deletion");
    expect(englishPolicyText).toContain("hello@clinicflow.app");

    for (const obsolete of [
      "في انتظار",
      "مسودة",
      "مخطط",
      "تحت المراجعة",
      "سيتم",
      "سوف يتم لاحقًا",
      "قد نضيف",
    ]) {
      expect(arabicPolicyText).not.toContain(obsolete);
    }

    for (const obsolete of [
      "Draft outline",
      "intended data-handling approach",
      "The final policy",
      "subject to legal and operational review",
    ]) {
      expect(englishPolicyText).not.toContain(obsolete);
    }
  });

  it("ships semantically equivalent production Terms in English and Arabic", () => {
    const arabicTerms = arMessages.legal.terms;
    const englishTerms = enMessages.legal.terms;
    const arabicTermsText = JSON.stringify(arabicTerms);
    const englishTermsText = JSON.stringify(englishTerms);

    expect(arabicTerms.sections).toHaveLength(25);
    expect(englishTerms.sections).toHaveLength(arabicTerms.sections.length);
    expect(arabicTerms.updated).toBe("آخر تحديث: 15 يوليو 2026");
    expect(englishTerms.updated).toBe("Last updated: July 15, 2026");
    expect(arMessages.legal.noticeTitle).toBe("حدود مسؤولية ClinicFlow");
    expect(enMessages.legal.noticeTitle).toBe("ClinicFlow Liability Limitations");
    expect(arMessages.marketing).not.toHaveProperty("legal");
    expect(enMessages.marketing).not.toHaveProperty("legal");

    const alignedConcepts: Array<[number, string, string]> = [
      [0, "إنشاء الحساب", "creating an account"],
      [1, "حسابات دخول", "patient login accounts"],
      [3, "Supabase Auth", "Supabase Auth"],
      [7, "14 يومًا", "14-day trial"],
      [10, "لا يقدم تشخيصًا طبيًا", "does not provide a medical diagnosis"],
      [14, "صالحة لمدة 24 ساعة", "valid for 24 hours"],
      [15, "أكثر من 30 يومًا", "more than 30 days"],
      [18, "ترخيص MIT", "MIT License"],
      [24, "hello@clinicflow.app", "hello@clinicflow.app"],
    ];
    for (const [index, arabicConcept, englishConcept] of alignedConcepts) {
      expect(arabicTerms.sections[index].body).toContain(arabicConcept);
      expect(englishTerms.sections[index].body).toContain(englishConcept);
    }

    for (const provider of [
      "Supabase",
      "Vercel",
      "Resend",
      "Upstash",
      "Sentry",
      "Open Exchange Rates",
    ]) {
      expect(arabicTermsText).toContain(provider);
      expect(englishTermsText).toContain(provider);
    }

    for (const obsolete of [
      "في انتظار",
      "مسودة",
      "مخطط",
      "تحت المراجعة",
      "سيتم",
      "سوف",
      "قريبًا",
      "لاحقًا",
    ]) {
      expect(arabicTermsText).not.toContain(obsolete);
    }

    for (const obsolete of [
      "Pending legal review",
      "Draft outline",
      "non-binding outline",
      "The final terms",
      "upcoming final terms",
      "have not been finalized",
    ]) {
      expect(englishTermsText).not.toContain(obsolete);
    }

    for (const unsupportedClaim of [
      "متوافق مع HIPAA",
      "معتمد من GDPR",
      "متوافق مع PDPL",
      "حاصل على ISO",
      "حاصل على SOC 2",
      "ضمان وقت التشغيل",
      "استرداد المدفوعات",
    ]) {
      expect(arabicTermsText).not.toContain(unsupportedClaim);
    }

    for (const unsupportedClaim of [
      "HIPAA compliant",
      "GDPR certified",
      "PDPL compliant",
      "ISO certified",
      "SOC 2 certified",
      "uptime guarantee",
      "refund policy",
    ]) {
      expect(englishTermsText).not.toContain(unsupportedClaim);
    }
  });
});
