import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PatientAvatarPreview } from "@/components/patients/patient-avatar-preview";

describe("PatientAvatarPreview", () => {
  it("opens a large preview dialog when the patient avatar is clicked", async () => {
    const user = userEvent.setup();
    render(
      <PatientAvatarPreview
        avatarUrl="https://signed.local/avatar.webp"
        fullName="Sara Patient"
        initials="SP"
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /preview sara patient avatar/i }),
    );

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /sara patient full-size avatar/i }),
    ).toHaveAttribute("src", "https://signed.local/avatar.webp");
  });

  it("renders a non-clickable fallback when no avatar URL is available", () => {
    render(
      <PatientAvatarPreview
        avatarUrl={null}
        fullName="No Photo"
        initials="NP"
      />,
    );

    expect(screen.getByText("NP")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
