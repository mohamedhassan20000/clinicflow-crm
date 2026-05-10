import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PATIENT_ID = "33333333-3333-4333-8333-333333333333";
const CLINIC_ID = "clinic-1";
const AVATAR_PATH = `avatars/${CLINIC_ID}/${PATIENT_ID}/avatar.webp`;

async function loadPatientPages() {
  vi.resetModules();
  const mocks = createServerActionMocks();

  vi.doMock("@/lib/rbac", () => ({
    requireUser: vi.fn(async () => mocks.state.authedUser),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));

  const listPage = await import("@/app/(protected)/patients/page");
  const detailPage = await import("@/app/(protected)/patients/[id]/page");
  return { listPage, detailPage, mocks };
}

describe("patient avatar signed URL loading", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("generates signed avatar URLs only for visible patient list rows with avatar paths", async () => {
    const { listPage, mocks } = await loadPatientPages();
    mocks.state.tableResults["patients.select"] = {
      data: [
        {
          id: PATIENT_ID,
          file_number: "CF-0001",
          full_name: "Avatar Patient",
          national_id: "ABC123",
          phone: "0555 123 45 67",
          blood_type: null,
          department_id: null,
          assigned_doctor_id: null,
          avatar_path: AVATAR_PATH,
          departments: null,
          assigned_doctor: null,
        },
        {
          id: OTHER_PATIENT_ID,
          file_number: "CF-0002",
          full_name: "No Avatar Patient",
          national_id: "DEF456",
          phone: "0555 765 43 21",
          blood_type: null,
          department_id: null,
          assigned_doctor_id: null,
          avatar_path: null,
          departments: null,
          assigned_doctor: null,
        },
      ],
      count: 2,
      error: null,
    };
    mocks.state.tableResults["departments.select"] = {
      data: [],
      error: null,
    };
    mocks.state.tableResults["profiles.select"] = {
      data: [],
      error: null,
    };
    mocks.state.tableResults["appointments.select"] = {
      data: [],
      error: null,
    };

    await listPage.default({
      searchParams: Promise.resolve({}),
    });

    expect(mocks.state.storageLog).toEqual([
      {
        bucket: "patient-assets",
        operation: "createSignedUrl",
        args: [AVATAR_PATH, 60 * 60],
      },
    ]);
  });

  it("generates a signed avatar URL for the current patient detail only", async () => {
    const { detailPage, mocks } = await loadPatientPages();
    mocks.state.authedUser = {
      id: "doctor-1",
      clinicId: CLINIC_ID,
      role: "doctor",
      departmentId: null,
    };
    mocks.state.tableResults["patients.select"] = {
      data: {
        id: PATIENT_ID,
        clinic_id: CLINIC_ID,
        full_name: "Avatar Patient",
        file_number: "CF-0001",
        date_of_birth: "1990-01-01",
        blood_type: null,
        assigned_doctor_id: "doctor-1",
        department_id: null,
        is_deleted: false,
        avatar_path: AVATAR_PATH,
        departments: null,
        assigned_doctor: { full_name: "Doctor One" },
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

    await detailPage.default({
      params: Promise.resolve({ id: PATIENT_ID }),
    });

    expect(mocks.state.storageLog).toEqual([
      {
        bucket: "patient-assets",
        operation: "createSignedUrl",
        args: [AVATAR_PATH, 60 * 60],
      },
    ]);
  });
});
