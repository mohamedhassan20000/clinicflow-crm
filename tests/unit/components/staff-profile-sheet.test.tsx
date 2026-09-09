import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StaffProfileSheet } from "@/components/settings/staff-profile-sheet";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  saveStaffDocuments: vi.fn(),
  updateStaffProfileSection: vi.fn(),
  upsertStaffSchedule: vi.fn(),
  listStaffFiles: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/actions/staff-files", () => ({
  listStaffFiles: mocks.listStaffFiles,
  saveStaffDocuments: mocks.saveStaffDocuments,
}));

vi.mock("@/actions/settings", () => ({
  getClinicWorkingHours: vi.fn(async () => []),
  getStaffSchedule: vi.fn(async () => Array.from({ length: 7 }, (_, day_of_week) => ({
    day_of_week,
    works: false,
    start_time: null,
    end_time: null,
    intervals: [],
  }))),
  getStaffShiftTemplates: vi.fn(async () => []),
  updateStaffProfileSection: mocks.updateStaffProfileSection,
  upsertStaffSchedule: mocks.upsertStaffSchedule,
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
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:staff-photo"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    mocks.listStaffFiles.mockResolvedValue({
      data: { photo: null, contract: null, certificates: [], other: [] },
    });
    mocks.saveStaffDocuments.mockResolvedValue({
      data: { photo: null, contract: null, certificates: [], other: [] },
    });
    mocks.updateStaffProfileSection.mockResolvedValue({ success: true });
    mocks.upsertStaffSchedule.mockResolvedValue({ success: true });
  });

  it("does not render profile avatar upload or last login details", () => {
    render(
      <StaffProfileSheet staff={staff} open onOpenChange={vi.fn()} />,
    );

    expect(screen.getAllByText("Sara Emad").length).toBeGreaterThan(0);
    expect(screen.getByText("Role")).toBeInTheDocument();
    expect(screen.getAllByText("Cardiology").length).toBeGreaterThan(0);
    expect(screen.getByText("Joined")).toBeInTheDocument();
    expect(screen.getByText("Account status")).toBeInTheDocument();
    expect(screen.queryByText("Profile avatar")).not.toBeInTheDocument();
    expect(screen.queryByText(/Loading profile avatar/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Last login")).not.toBeInTheDocument();
    expect(screen.queryByText("Never logged in")).not.toBeInTheDocument();
    expect(screen.queryByText(/11 May 2026/)).not.toBeInTheDocument();
  });

  it("places the Staff File action inside Documents instead of the identity header", async () => {
    const user = userEvent.setup();
    render(
      <StaffProfileSheet staff={staff} open onOpenChange={vi.fn()} />,
    );

    expect(screen.queryByRole("link", { name: /staff file document/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Documents" }));

    const link = await screen.findByRole("link", { name: /staff file document/i });
    expect(link).toHaveAttribute(
      "href",
      "/documents/roster-profile/staff-file?staffId=staff-1",
    );
    expect(screen.getByTestId("staff-documents-actions")).toContainElement(link);
  });

  it("stages a photo until Documents Save and submits only the opened staff document payload", async () => {
    const user = userEvent.setup();
    mocks.saveStaffDocuments.mockResolvedValue({
      data: {
        photo: {
          name: "photo.webp",
          path: "staff/clinic-1/staff-1/photo.webp",
          size: 5,
          createdAt: "2026-08-09T00:00:00Z",
          url: "https://signed.local/staff-1/photo.webp",
        },
        contract: null,
        certificates: [],
        other: [],
      },
    });
    render(<StaffProfileSheet staff={staff} open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole("tab", { name: "Documents" }));
    await screen.findByRole("button", { name: "Save documents" });

    fireEvent.change(screen.getByLabelText("Profile photo"), {
      target: { files: [new File(["photo"], "photo.webp", { type: "image/webp" })] },
    });
    expect(mocks.saveStaffDocuments).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save documents" }));
    await waitFor(() => expect(mocks.saveStaffDocuments).toHaveBeenCalledOnce());
    const [staffId, payload] = mocks.saveStaffDocuments.mock.calls[0] as [string, FormData];
    expect(staffId).toBe("staff-1");
    expect(payload.get("photo_action")).toBe("replace");
    expect(payload.get("photo")).toBeInstanceOf(File);
    expect(payload.get("professional_license_no")).toBeNull();
    expect(payload.get("schedule")).toBeNull();
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("saves only Profile fields for the opened staff member", async () => {
    render(<StaffProfileSheet staff={staff} open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Sara Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => expect(mocks.updateStaffProfileSection).toHaveBeenCalledWith(
      "staff-1",
      {
        full_name: "Sara Updated",
        phone: "+90 555 000 00 00",
        // The patient-facing display names travel with the profile section and
        // are null until somebody types one. `full_name` above is untouched.
        display_name_ar: null,
        display_name_en: null,
      },
    ));
  });

  it("shows Schedule for non-doctor staff", async () => {
    const user = userEvent.setup();
    const receptionist = { ...staffFixture, role: "receptionist" } as never;
    render(<StaffProfileSheet staff={receptionist} open onOpenChange={vi.fn()} isAdmin />);

    await user.click(screen.getByRole("tab", { name: "Schedule" }));
    expect(await screen.findByText(/set which days this staff member works/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save schedule" })).toBeInTheDocument();
  });
});
