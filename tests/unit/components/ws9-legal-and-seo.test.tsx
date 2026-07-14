import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PrivacyPage, { generateMetadata as privacyMetadata } from "@/app/privacy/page";
import TermsPage, { generateMetadata as termsMetadata } from "@/app/terms/page";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

describe("WS9 legal and SEO surfaces", () => {
  it("renders honest legal-review notices without definitive commitments", () => {
    render(<PrivacyPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pending legal review" })).toBeInTheDocument();
    expect(screen.getByText(/does not create definitive commitments/i)).toBeInTheDocument();

    render(<TermsPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeInTheDocument();
    expect(screen.getAllByText(/prices, billing arrangements, renewal rules/i).length).toBeGreaterThan(0);
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
});
