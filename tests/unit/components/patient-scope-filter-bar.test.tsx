import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PatientScopeFilterBar } from "@/components/shared/patient-scope-filter-bar";

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  params: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () => navigation.params,
}));

describe("PatientScopeFilterBar file number filter", () => {
  beforeEach(() => {
    navigation.push.mockReset();
    navigation.params = new URLSearchParams();
  });

  it("shows a fixed CF- prefix and applies a normalized file number", async () => {
    const user = userEvent.setup();
    render(
      <PatientScopeFilterBar
        basePath="/patients"
        doctors={[]}
        departments={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /file #/i }));

    expect(await screen.findByText("CF-")).toBeInTheDocument();

    const input = screen.getByPlaceholderText("0001");
    await user.type(input, "12");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(navigation.push).toHaveBeenCalledWith("/patients?file=CF-0012");
  });

  it("clears an active file filter", async () => {
    const user = userEvent.setup();
    navigation.params = new URLSearchParams("file=CF-0012&page=2");

    render(
      <PatientScopeFilterBar
        basePath="/patients"
        doctors={[]}
        departments={[]}
        resetParamsOnApply={["page"]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /file #/i }));
    await user.click(await screen.findByRole("button", { name: "Clear" }));

    expect(navigation.push).toHaveBeenCalledWith("/patients?");
  });
});
