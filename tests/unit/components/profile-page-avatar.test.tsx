import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProfilePage } from "@/components/profile/profile-page";
import { removeAvatar } from "@/actions/profile";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/actions/profile", () => ({
  uploadAvatar: vi.fn(async () => ({ ok: true })),
  removeAvatar: vi.fn(async () => ({ ok: true })),
  updateProfile: vi.fn(async () => ({ ok: true })),
  changeMyPassword: vi.fn(async () => ({ ok: true })),
}));

const profile = {
  id: "user-1",
  full_name: "Maya Hassan",
  phone: "+90 555 000 00 00",
  avatar_url: "https://signed.local/avatar.webp",
  role: "doctor",
  email: "maya@example.com",
  created_at: "2026-01-01T08:00:00.000Z",
  department: { name: "Cardiology", color: "#0891b2" },
};

describe("ProfilePage avatar controls", () => {
  it("removes the current avatar from the profile card", async () => {
    const user = userEvent.setup();
    const { container } = render(<ProfilePage profile={profile} />);

    expect(container.querySelector('[data-slot="avatar-image-background"]')).toHaveStyle({
      backgroundImage: 'url("https://signed.local/avatar.webp")',
    });

    await user.click(screen.getByRole("button", { name: /remove photo/i }));

    await waitFor(() => {
      expect(removeAvatar).toHaveBeenCalled();
      expect(container.querySelector('[data-slot="avatar-image-background"]')).not.toBeInTheDocument();
    });
    expect(screen.getByText("MH")).toBeInTheDocument();
  });
});
