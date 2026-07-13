import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams("name=Ada&page=2&dept=cardiology"),
}));

import { PatientTable } from "@/components/patients/patient-table";

describe("patient detail return navigation", () => {
  beforeEach(() => push.mockClear());

  it("carries the filtered patient-list URL into detail navigation by keyboard", async () => {
    const user = userEvent.setup();
    render(
      <PatientTable
        data={[{
          id: "patient-1",
          file_number: "P-001",
          full_name: "Ada Lovelace",
          national_id: null,
          phone: "+90 555 000 0000",
          blood_type: "O+",
          department_id: null,
          assigned_doctor_id: null,
        }]}
        total={1}
        page={2}
        pageSize={20}
        canCreate
      />,
    );

    const rowLink = screen.getByRole("link", { name: /Ada Lovelace/ });
    rowLink.focus();
    await user.keyboard("{Enter}");

    expect(push).toHaveBeenCalledOnce();
    const destination = new URL(push.mock.calls[0][0], "https://clinicflow.local");
    expect(destination.pathname).toBe("/patients/patient-1");
    expect(destination.searchParams.get("returnTo")).toBe("/patients?name=Ada&page=2&dept=cardiology");
  });

  it("carries the same list state into the new-patient flow", () => {
    render(<PatientTable data={[]} total={0} page={2} pageSize={20} canCreate />);

    const href = screen.getByRole("link", { name: "New patient" }).getAttribute("href");
    const destination = new URL(href ?? "", "https://clinicflow.local");
    expect(destination.pathname).toBe("/patients/new");
    expect(destination.searchParams.get("returnTo")).toBe("/patients?name=Ada&page=2&dept=cardiology");
  });
});
