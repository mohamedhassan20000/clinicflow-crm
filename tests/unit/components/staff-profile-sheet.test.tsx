import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StaffProfileSheet } from "@/components/settings/staff-profile-sheet";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/actions/staff-files", () => ({
  listStaffFiles: vi.fn(async () => ({
    data: { photo: null, contract: null, certificates: [], other: [] },
  })),
  deleteStaffFile: vi.fn(),
  uploadStaffCertificate: vi.fn(),
  uploadStaffContract: vi.fn(),
  uploadStaffOtherDoc: vi.fn(),
}));

const staffFixture = {
  id: "staff-1",
  full_name: "Sara Emad",
  avatar_url: "https://signed.local/staff-photo.webp",
  role: "doctor",
  departments: { name: "Cardiology", color: "#0891b2" },
  phone: "+90 555 000 00 00",
  created_at: "2026-01-01T08:00:00.000Z",
  last_login_at: "2026-05-11T09:15:00.000Z",
  is_active: true,
  must_change_password: false,
};

const staff = staffFixture as never;

describe("StaffProfileSheet", () => {
  it("does not render the profile avatar upload section and shows last login", async () => {
    render(
      <StaffProfileSheet staff={staff} open onOpenChange={vi.fn()} />,
    );

    expect(screen.getAllByText("Sara Emad").length).toBeGreaterThan(0);
    expect(screen.queryByText("Profile avatar")).not.toBeInTheDocument();
    expect(screen.queryByText(/Loading profile avatar/i)).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/11 May 2026/)).toBeInTheDocument();
    });
  });

  it("shows a clear fallback when staff has never logged in", async () => {
    render(
      <StaffProfileSheet
        staff={{ ...staffFixture, last_login_at: null } as never}
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Never logged in")).toBeInTheDocument();
  });
});
