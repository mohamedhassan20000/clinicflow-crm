import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const CLINIC_ID = "clinic-1";

async function loadPatientPage() {
  vi.resetModules();
  const mocks = createServerActionMocks();
  const listPatientDocuments = vi.fn(async () => ({
    data: { nationalId: null, insurance: null, other: [] },
  }));

  vi.doMock("@/lib/rbac", () => ({
    requireUser: vi.fn(async () => mocks.state.authedUser),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  vi.doMock("next/navigation", () => ({
    notFound: vi.fn(() => {
      throw new Error("not found");
    }),
    useRouter: () => ({
      refresh: vi.fn(),
      push: vi.fn(),
      replace: vi.fn(),
    }),
  }));
  vi.doMock("@/actions/patient-documents", () => ({
    listPatientDocuments,
  }));
  vi.doMock("@/components/patients/patient-documents-section", () => ({
    PatientDocumentsSection: () => <section>Documents section</section>,
  }));

  const page = await import("@/app/(protected)/patients/[id]/page");
  return { page, mocks, listPatientDocuments };
}

function seedPatientPageData(mocks: ReturnType<typeof createServerActionMocks>) {
  mocks.state.tableResults["patients.select"] = {
    data: {
      id: PATIENT_ID,
      clinic_id: CLINIC_ID,
      full_name: "Document Patient",
      file_number: "CF-0001",
      date_of_birth: "1990-01-01",
      blood_type: null,
      assigned_doctor_id: null,
      department_id: null,
      is_deleted: false,
      avatar_path: null,
      departments: null,
      assigned_doctor: null,
      insurance_providers: null,
      national_id: "ABC123",
      phone: "0555 123 45 67",
      email: "patient@example.com",
      created_at: "2026-01-01T00:00:00Z",
    },
    error: null,
  };
  mocks.state.tableResults["medical_notes.select"] = {
    data: [],
    error: null,
  };
  mocks.state.tableResults["appointments.select"] = {
    data: [],
    error: null,
  };
  mocks.state.tableResults["follow_ups.select"] = {
    data: [],
    error: null,
  };
  mocks.state.tableResults["outstanding_settlements.select"] = {
    data: [],
    error: null,
  };
  mocks.state.tableResults["patient_deposits.select"] = {
    data: [],
    error: null,
  };
}

describe("patient documents page gating", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders documents for receptionists", async () => {
    const { page, mocks, listPatientDocuments } = await loadPatientPage();
    mocks.state.authedUser.role = "receptionist";
    seedPatientPageData(mocks);

    const jsx = await page.default({
      params: Promise.resolve({ id: PATIENT_ID }),
    });
    render(jsx);

    expect(screen.getByText("Documents section")).toBeInTheDocument();
    expect(listPatientDocuments).toHaveBeenCalledWith(PATIENT_ID);
  });

  it("does not render or load documents for managers", async () => {
    const { page, mocks, listPatientDocuments } = await loadPatientPage();
    mocks.state.authedUser.role = "manager";
    seedPatientPageData(mocks);

    const jsx = await page.default({
      params: Promise.resolve({ id: PATIENT_ID }),
    });
    render(jsx);

    expect(screen.queryByText("Documents section")).not.toBeInTheDocument();
    expect(listPatientDocuments).not.toHaveBeenCalled();
  });

  it("does not render or load documents for doctors", async () => {
    const { page, mocks, listPatientDocuments } = await loadPatientPage();
    mocks.state.authedUser = {
      id: "doctor-1",
      clinicId: CLINIC_ID,
      role: "doctor",
      departmentId: null,
    };
    seedPatientPageData(mocks);
    mocks.state.tableResults["patients.select"] = {
      data: {
        ...(mocks.state.tableResults["patients.select"] as { data: object }).data,
        assigned_doctor_id: "doctor-1",
      },
      error: null,
    };

    const jsx = await page.default({
      params: Promise.resolve({ id: PATIENT_ID }),
    });
    render(jsx);

    expect(screen.queryByText("Documents section")).not.toBeInTheDocument();
    expect(listPatientDocuments).not.toHaveBeenCalled();
  });
});
