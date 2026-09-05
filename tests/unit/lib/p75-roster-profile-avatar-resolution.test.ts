import { beforeEach, describe, expect, it, vi } from "vitest";

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const STAFF_ID = "55555555-5555-4555-8555-555555555555";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  download: vi.fn(),
  inlineClinicLogo: vi.fn(),
  storageFrom: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/documents/assets", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/documents/assets")>(),
  inlineClinicLogo: mocks.inlineClinicLogo,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import { resolveRosterProfileDocumentSnapshot } from "@/lib/documents/resolvers/roster-profile";

function query(result: { data: unknown; error: null }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "or", "order", "limit", "is", "in", "ilike"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.single = vi.fn(async () => result);
  builder.then = (
    resolve: (value: { data: unknown; error: null }) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

const clinic = {
  name: "ClinicFlow", logo_url: null, address: null, phone: null, email: null,
  website: null, license_no: null, tax_id: null, document_footer: null,
  timezone: "Europe/Istanbul", time_format: "24h",
};

function clientWith(results: Record<string, { data: unknown; error: null }>) {
  return {
    from: vi.fn((table: string) => query(results[table])),
    storage: { from: mocks.storageFrom },
  };
}

const user = {
  id: "user-1", clinicId: "clinic-1", role: "admin" as const, departmentId: null,
  email: "admin@clinic.test", fullName: "Clinic Admin", avatarUrl: null,
  mustChangePassword: false,
};

function commonResults() {
  return {
    clinics: { data: clinic, error: null },
    document_settings: { data: [], error: null },
  };
}

describe("roster/profile document avatar resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inlineClinicLogo.mockResolvedValue(null);
    mocks.download.mockResolvedValue({
      data: { size: PNG_BYTES.byteLength, type: "image/png", arrayBuffer: async () =>
        PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength) },
      error: null,
    });
    mocks.storageFrom.mockImplementation(() => ({ download: mocks.download }));
  });

  it("never reads a patient photo for Patient List preview or issuance snapshots", async () => {
    const avatarPath = `avatars/clinic-1/${PATIENT_ID}/avatar.png`;
    mocks.createClient.mockResolvedValue(clientWith({
      ...commonResults(),
      patients: { data: [{
        id: PATIENT_ID, file_number: "CF-0013", full_name: "Ada Lovelace",
        national_id: "123456789", phone: "+90 555 000 0000", blood_type: "A+",
        department_id: null, avatar_path: avatarPath, departments: null, assigned_doctor: null,
      }], error: null },
    }));

    const params = { documentType: "PATIENT_LIST_REPORT" as const };
    const preview = await resolveRosterProfileDocumentSnapshot(user, params);
    const issuance = await resolveRosterProfileDocumentSnapshot(user, params);

    // A roster listing carries names only, so no photo reaches the snapshot and
    // no avatar bytes are downloaded on the preview or the issuance path.
    for (const snapshot of [preview, issuance]) {
      expect(snapshot.data).toMatchObject({ kind: "patient-list", rows: [{ fullName: "Ada Lovelace" }] });
      const [row] = (snapshot.data as { rows: Record<string, unknown>[] }).rows;
      expect(row).not.toHaveProperty("imageSrc");
      expect(row).not.toHaveProperty("doctorImageSrc");
    }
    expect(mocks.storageFrom).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(avatarPath).toBeTruthy();
  });

  it("never reads staff photos for the System Members roster", async () => {
    const secondStaffId = "66666666-6666-4666-8666-666666666666";
    mocks.createClient.mockResolvedValue(clientWith({
      ...commonResults(),
      profiles: { data: [
        { id: STAFF_ID, full_name: "Dr. Sara Emad", department_id: null, role: "doctor",
          is_active: true, created_at: "2025-01-10T08:00:00.000Z", departments: null,
          avatar_url: `https://project.supabase.co/storage/v1/object/sign/clinic-assets/staff/clinic-1/${STAFF_ID}/photo.webp?token=x` },
        { id: secondStaffId, full_name: "Mina Ali", department_id: null, role: "manager",
          is_active: true, created_at: "2025-01-11T08:00:00.000Z", departments: null,
          avatar_url: `https://project.supabase.co/storage/v1/object/public/avatars/${secondStaffId}/avatar-1.png` },
      ], error: null },
    }));

    const snapshot = await resolveRosterProfileDocumentSnapshot(
      user,
      { documentType: "SYSTEM_MEMBERS_REPORT" },
    );

    expect(snapshot.data).toMatchObject({ kind: "system-members", rows: [
      { fullName: "Dr. Sara Emad" },
      { fullName: "Mina Ali" },
    ] });
    for (const row of (snapshot.data as { rows: Record<string, unknown>[] }).rows) {
      expect(row).not.toHaveProperty("imageSrc");
    }
    expect(mocks.storageFrom).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "managed staff photo",
      url: `https://project.supabase.co/storage/v1/object/sign/clinic-assets/staff/clinic-1/${STAFF_ID}/photo.webp?token=x`,
      bucket: "clinic-assets",
      path: `staff/clinic-1/${STAFF_ID}/photo.webp`,
    },
    {
      label: "self-service profile avatar",
      url: `https://project.supabase.co/storage/v1/object/public/avatars/${STAFF_ID}/avatar-1.png`,
      bucket: "avatars",
      path: `${STAFF_ID}/avatar-1.png`,
    },
  ])("inlines the $label into Staff File preview and issuance", async ({ url, bucket, path }) => {
    mocks.createClient.mockResolvedValue(clientWith({
      ...commonResults(),
      profiles: { data: {
        id: STAFF_ID, full_name: "Dr. Sara Emad", phone: "+90 555 000 0001",
        role: "doctor", is_active: true, created_at: "2025-01-10T08:00:00.000Z",
        avatar_url: url, departments: { name: "Dermatology" },
      }, error: null },
      doctor_schedules: { data: [], error: null },
    }));
    const params = { documentType: "STAFF_FILE" as const, staffId: STAFF_ID };

    const preview = await resolveRosterProfileDocumentSnapshot(user, params);
    const issuance = await resolveRosterProfileDocumentSnapshot(user, params);

    expect(preview.data).toMatchObject({ kind: "staff-file", imageSrc: expect.stringMatching(/^data:image\/png;base64,/) });
    expect(issuance.data).toMatchObject({ kind: "staff-file", imageSrc: expect.stringMatching(/^data:image\/png;base64,/) });
    expect(mocks.storageFrom).toHaveBeenCalledWith(bucket);
    expect(mocks.download).toHaveBeenCalledWith(path);
  });
});
