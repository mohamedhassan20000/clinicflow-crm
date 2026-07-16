import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import ar from "@/messages/ar.json";

const localeState = vi.hoisted(() => ({ current: "en" as "en" | "ar" }));

vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  return {
    ...actual,
    useLocale: () => localeState.current,
    useTranslations: (namespace?: string) =>
      actual.createTranslator({
        locale: localeState.current,
        messages: localeState.current === "en" ? en : ar,
        namespace: namespace as never,
      }),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/actions/auth", () => ({ signIn: vi.fn() }));

import { LoginForm } from "@/components/auth/login-form";

describe("Phase 3 login validation localization", () => {
  beforeEach(() => {
    localeState.current = "en";
  });

  it("renders localized English required and invalid-email messages", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.click(screen.getByRole("button", { name: en.auth.signIn }));
    expect(await screen.findAllByText(en.validation.required)).toHaveLength(2);

    await user.type(screen.getByLabelText(en.auth.emailAddress), "invalid");
    await user.click(screen.getByRole("button", { name: en.auth.signIn }));
    expect(await screen.findByText(en.validation.invalidEmail)).toBeInTheDocument();
  });

  it("renders localized Arabic required messages", async () => {
    localeState.current = "ar";
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.click(screen.getByRole("button", { name: ar.auth.signIn }));
    expect(await screen.findAllByText(ar.validation.required)).toHaveLength(2);
  });
});
