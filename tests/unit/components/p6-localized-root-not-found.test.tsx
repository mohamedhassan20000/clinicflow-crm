import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RootNotFound from "@/app/not-found";
import OperatorNotFound from "@/app/(operator)/not-found";
import ProtectedNotFound from "@/app/(protected)/not-found";
import { localeDirection } from "@/lib/i18n/config";
import arMessages from "@/messages/ar.json";
import enMessages from "@/messages/en.json";

describe("Phase 6 localized root not-found", () => {
  it("renders the safe English public fallback with a home link", async () => {
    render(await RootNotFound());

    expect(screen.getByRole("heading", { name: "We couldn’t find that page." })).toBeInTheDocument();
    expect(screen.getByText(/link may be incorrect or the page may have moved/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
    expect(screen.queryByText(/patient|tenant|supabase|stack trace/i)).not.toBeInTheDocument();
  });

  it("keeps Arabic and English copy aligned with the root layout directions", () => {
    expect(Object.keys(arMessages.notFound).sort()).toEqual(Object.keys(enMessages.notFound).sort());
    expect(enMessages.notFound.title).toBe("We couldn’t find that page.");
    expect(arMessages.notFound.title).toBe("لم نتمكن من العثور على هذه الصفحة.");
    expect(localeDirection("en")).toBe("ltr");
    expect(localeDirection("ar")).toBe("rtl");
  });

  it("leaves the protected and operator fallbacks authoritative", () => {
    const protectedView = render(<ProtectedNotFound />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to dashboard" })).toHaveAttribute("href", "/dashboard");
    protectedView.unmount();

    render(<OperatorNotFound />);
    expect(screen.getByRole("heading", { name: "Operator page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Mission Control" })).toHaveAttribute("href", "/operator");
  });
});
