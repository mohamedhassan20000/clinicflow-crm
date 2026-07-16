import { fireEvent, render, screen } from "@testing-library/react";
import * as Sentry from "@sentry/nextjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PublicError from "@/app/error";
import GlobalError from "@/app/global-error";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

describe("Phase 1 public error boundaries", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a localized public recovery boundary with only the safe digest", () => {
    const reset = vi.fn();
    const error = Object.assign(
      new Error("patientName=Private Patient; nationalId=SECRET"),
      { digest: "p1-safe-digest" },
    );

    render(<PublicError error={error} reset={reset} />);

    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
    expect(screen.getByText("Error ID: p1-safe-digest")).toBeInTheDocument();
    expect(screen.queryByText(/Private Patient|SECRET/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("renders the self-contained bilingual global recovery boundary", () => {
    const reset = vi.fn();
    const error = new Error("tenant=SECRET; stack=PRIVATE");

    render(<GlobalError error={error} reset={reset} />);

    expect(screen.getByRole("heading", { name: /Something went wrong.*حدث خطأ ما/ })).toBeInTheDocument();
    expect(screen.getByText(/تعذّر تحميل هذه الصفحة/)).toHaveAttribute("dir", "rtl");
    expect(screen.queryByText(/tenant=SECRET|stack=PRIVATE/)).not.toBeInTheDocument();
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    expect(Sentry.captureException).toHaveBeenCalledWith(error);

    fireEvent.click(screen.getByRole("button", { name: "Try again / حاول مرة أخرى" }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
