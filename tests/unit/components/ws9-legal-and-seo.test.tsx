import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PrivacyPage, { generateMetadata as privacyMetadata } from "@/app/privacy/page";
import TermsPage, { generateMetadata as termsMetadata } from "@/app/terms/page";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import arMessages from "@/messages/ar.json";
import enMessages from "@/messages/en.json";

describe("WS9 legal and SEO surfaces", () => {
  it("renders production notices for both legal documents", () => {
    render(<PrivacyPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "About ClinicFlow’s role" })).toBeInTheDocument();
    expect(screen.getByText(/reflects how ClinicFlow currently processes data/i)).toBeInTheDocument();

    render(<TermsPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Service limits and clinical responsibility" })).toBeInTheDocument();
    expect(screen.getByText(/does not diagnose patients or make medical decisions/i)).toBeInTheDocument();
    expect(screen.queryByText(/pending legal review/i)).not.toBeInTheDocument();
  });

  it("indexes only the public marketing/legal surfaces and publishes canonical URLs", async () => {
    const robotRules = robots();
    expect(robotRules.sitemap).toBe("https://clinicflow.fit/sitemap.xml");
    expect(JSON.stringify(robotRules.rules)).toContain("/operator");

    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toEqual([
      "https://clinicflow.fit",
      "https://clinicflow.fit/privacy",
      "https://clinicflow.fit/terms",
    ]);
    // P2C: metadata is resolved per-request now, so the title and description follow the
    // reader's locale rather than being frozen English at build time.
    expect((await privacyMetadata()).alternates?.canonical).toBe("https://clinicflow.fit/privacy");
    expect((await termsMetadata()).alternates?.canonical).toBe("https://clinicflow.fit/terms");
  });

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
    expect(arMessages.legal.noticeTitle).toBe("حدود الخدمة والمسؤولية السريرية");
    expect(enMessages.legal.noticeTitle).toBe("Service limits and clinical responsibility");
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
