import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  getReplacementDoctorOptions: vi.fn(),
  getReplacementAvailability: vi.fn(),
  replaceAppointment: vi.fn(),
}));

vi.mock("@/actions/appointments", () => ({
  getReplacementDoctorOptions: mocks.getReplacementDoctorOptions,
  getReplacementAvailability: mocks.getReplacementAvailability,
  replaceAppointment: mocks.replaceAppointment,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { ReplaceAppointmentDialog } from "@/components/appointments/replace-appointment-dialog";

describe("Replace appointment picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getReplacementDoctorOptions.mockResolvedValue({
      data: [{ id: "doctor-1", fullName: "Dr. Ada" }],
    });
    mocks.getReplacementAvailability.mockResolvedValue({
      data: {
        reason: "available",
        dateIso: "2030-07-15",
        dayOfWeek: 1,
        doctorName: "Dr. Ada",
        workingHours: [{ start: "09:00", end: "12:00" }],
        slots: [
          { time: "10:00", disabled: false },
          { time: "10:15", disabled: true, disabledReason: "booked" },
          { time: "10:30", disabled: false },
        ],
      },
    });
    mocks.replaceAppointment.mockResolvedValue({ success: true, appointmentId: "replacement-1" });
  });

  it("renders availability as slots and submits the unchanged local datetime contract", async () => {
    const user = userEvent.setup();
    render(
      <ReplaceAppointmentDialog
        open
        onOpenChange={() => {}}
        appointmentId="appointment-1"
        doctorId="doctor-1"
        defaultScheduledAt="2030-07-15T09:00:00.000Z"
        defaultDurationMinutes={30}
      />,
    );

    expect(document.querySelector('input[type="datetime-local"]')).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "10:00" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "10:15, Booked" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "10:15, Booked" })).toHaveAttribute("title", "Booked");

    await user.click(screen.getByRole("button", { name: "10:30" }));
    await user.click(screen.getByRole("button", { name: "Create replacement" }));

    await waitFor(() => expect(mocks.replaceAppointment).toHaveBeenCalledTimes(1));
    expect(mocks.replaceAppointment).toHaveBeenCalledWith({
      original_id: "appointment-1",
      doctor_id: "doctor-1",
      scheduled_at: new Date("2030-07-15T10:30").toISOString(),
      duration_minutes: 30,
    });
  });
});
