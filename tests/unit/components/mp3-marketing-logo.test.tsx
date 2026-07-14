import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarketingLogo } from "@/components/marketing/marketing-logo";

describe("Post-Pre-P2 MP3 marketing logo", () => {
  it.each([false, true])(
    "renders the transparent mark directly for inverse=%s",
    (inverse) => {
      render(<MarketingLogo inverse={inverse} />);

      const link = screen.getByRole("link", { name: "ClinicFlow home" });
      const mark = link.querySelector(":scope > img");

      expect(link).toHaveAttribute("href", "/");
      expect(link).toHaveClass(
        "min-h-11",
        "focus-visible:ring-2",
        "focus-visible:ring-cyan-400",
        "focus-visible:ring-offset-4",
      );
      expect(link).toHaveClass(
        inverse
          ? "focus-visible:ring-offset-[#073846]"
          : "focus-visible:ring-offset-[#f5fbfb]",
      );
      expect(mark).not.toBeNull();
      expect(decodeURIComponent(mark?.getAttribute("src") ?? "")).toContain(
        "/brand/clinicflow-mark.png",
      );
      expect(mark).toHaveAttribute("width", "34");
      expect(mark).toHaveAttribute("height", "30");
      expect(mark).toHaveClass("h-8", "w-auto", "shrink-0", "object-contain");
      expect(mark?.parentElement).toBe(link);
      expect(link.innerHTML).not.toMatch(/bg-\[#13c7d8\]|rounded-xl|shadow-\[inset_/);
    },
  );
});
