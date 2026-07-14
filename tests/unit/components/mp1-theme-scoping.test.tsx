import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AuthLayout from "@/app/(auth)/layout";
import SignupLayout from "@/app/(public)/signup/layout";
import AuthCallbackLayout from "@/app/auth/layout";
import { LegalPage } from "@/components/marketing/legal-page";
import {
  MARKETING_SECTION_TONES,
  MarketingPage,
} from "@/components/marketing/marketing-page";
import { marketingCopy } from "@/lib/marketing-copy";

function expectForcedScope(
  element: Element | null,
  theme: "light" | "dark",
) {
  expect(element).not.toBeNull();
  expect(element).toHaveClass(theme);
  expect(element).toHaveClass(`forced-${theme}-scope`);
}

function surfaceOwnedClasses(container: HTMLElement) {
  return Array.from(container.querySelectorAll("[class]:not([data-slot])"))
    .map((element) => element.getAttribute("class"))
    .join(" ");
}

describe("Post-Pre-P2 MP1 theme scoping", () => {
  it("renders marketing and legal surfaces as light-only class trees", () => {
    const marketing = render(
      <MarketingPage
        registrationMode="invite_only"
        weeklyLimit={20}
        acceptedThisWeek={0}
      />,
    );
    expectForcedScope(marketing.container.firstElementChild, "light");
    expect(surfaceOwnedClasses(marketing.container)).not.toMatch(/\bdark:/);
    marketing.unmount();

    const legal = render(<LegalPage content={marketingCopy.legal.privacy} />);
    expectForcedScope(legal.container.firstElementChild, "light");
    expect(surfaceOwnedClasses(legal.container)).not.toMatch(/\bdark:/);
  });

  it("keeps the marketing section rhythm in one exported tone map", () => {
    expect(MARKETING_SECTION_TONES).toEqual({
      hero: "bg-[var(--m-paper)]",
      proof: "bg-[var(--m-panel)]",
      product: "bg-[var(--m-paper)]",
      features: "bg-[var(--m-warm)]",
      security: "bg-[#073846]",
      pricing: "bg-[var(--m-paper)]",
      earlyAccess: "bg-[var(--m-panel)]",
      faq: "bg-[var(--m-warm)]",
      footer: "bg-[#073846]",
    });
    expect(new Set(Object.values(MARKETING_SECTION_TONES))).toHaveLength(4);
  });

  it("renders every authentication layout with a forced-dark scope", () => {
    for (const Layout of [AuthLayout, SignupLayout, AuthCallbackLayout]) {
      const view = render(
        <Layout>
          <p>Authentication content</p>
        </Layout>,
      );
      expectForcedScope(view.container.firstElementChild, "dark");
      view.unmount();
    }
  });
});
