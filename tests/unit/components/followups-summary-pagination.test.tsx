import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  FollowupsView,
  type DoneRow,
  type PendingRow,
} from "@/components/followups/followups-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("completedPage=2"),
}));

const department = {
  id: "dept-1",
  name: "Cardiology",
  color: "#0891b2",
};

const pending: PendingRow[] = [
  {
    id: "appt-1",
    scheduled_at: "2026-05-10T09:00:00.000Z",
    paid_at: "2026-05-10T10:00:00.000Z",
    patient_id: "patient-1",
    department_id: "dept-1",
    doctor_id: "doctor-1",
    total_amount: 100,
    payment_note: null,
    patients: {
      id: "patient-1",
      full_name: "Awaiting Patient",
      phone: "+90 555 000 00 00",
      file_number: "CF-001",
      national_id: "12345678901",
      department_id: "dept-1",
    },
    profiles: { full_name: "Dr Sara Emad" },
    departments: department,
  },
];

const done: DoneRow[] = [
  {
    id: "followup-1",
    recorded_at: "2026-05-11T10:00:00.000Z",
    outcome: "has_problem",
    notes: "Needs callback",
    patient_id: "patient-2",
    appointment_id: "appt-2",
    patients: {
      id: "patient-2",
      full_name: "Completed Patient",
      phone: "+90 555 111 11 11",
      file_number: "CF-002",
      national_id: "10987654321",
      department_id: "dept-1",
    },
    recorded_by: { full_name: "Reception User" },
    appointment: {
      id: "appt-2",
      scheduled_at: "2026-05-10T09:00:00.000Z",
      department_id: "dept-1",
      doctor_id: "doctor-1",
      profiles: { full_name: "Dr Sara Emad" },
      departments: department,
    },
  },
];

function renderView() {
  return render(
    <FollowupsView
      pending={pending}
      done={done}
      summary={{
        pendingCount: 251,
        completedCount: 75,
        allFineCount: 10,
        hasProblemCount: 5,
        noResponseCount: 3,
      }}
      pendingPreviewLimit={250}
      completedPage={2}
      completedPageSize={50}
      departments={[department]}
      doctors={[{ id: "doctor-1", full_name: "Dr Sara Emad" }]}
      scope="day"
      dateInput="2026-05-11"
      activeDept={null}
      activeOutcome={null}
      activeQuery=""
      range={{
        start: "2026-05-11T00:00:00.000Z",
        end: "2026-05-11T23:59:59.999Z",
      }}
      readOnly
    />,
  );
}

describe("FollowupsView server summary and pagination", () => {
  it("renders full summary counts instead of only loaded rows", () => {
    const { container } = renderView();

    expect(screen.getByText("Awaiting Patient")).toBeInTheDocument();
    expect(screen.getByText("Completed Patient")).toBeInTheDocument();
    expect(container.textContent).toContain("251");
    expect(container.textContent).toContain("75 records");
    expect(container.textContent).toContain("Showing 51–75 of 75 completed follow-ups");
  });

  it("shows a bounded awaiting-list notice when the server returns a preview", () => {
    const { container } = renderView();

    expect(container.textContent).toContain("Showing the first 250 awaiting follow-ups");
    expect(container.textContent).toContain("remaining 250 patients");
  });
});
