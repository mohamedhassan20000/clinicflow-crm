import { beforeEach, describe, expect, it, vi } from "vitest";

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const AVATAR_PATH = `avatars/clinic-1/${PATIENT_ID}/avatar.png`;

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  download: vi.fn(),
  inlineClinicLogo: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/documents/assets", () => ({
  inlineClinicLogo: mocks.inlineClinicLogo,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

import { resolveRosterProfileDocumentSnapshot } from "@/lib/documents/resolvers/roster-profile";

function query(result: { data: unknown; error: null }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "or", "order", "limit", "is", "in"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.single = vi.fn(async () => result);
  builder.then = (
    resolve: (value: { data: unknown; error: null }) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

function clientForPatient(avatarPath: string | null) {
  const rows: Record<string, { data: unknown; error: null }> = {
    clinics: { data: {
      name: "ClinicFlow", logo_url: null, address: null, phone: null, email: null,
      website: null, license_no: null, tax_id: null, document_footer: null,
      timezone: "Europe/Istanbul", time_format: "24h",
    }, error: null },
    document_settings: { data: [], error: null },
    patients: { data: {
      id: PATIENT_ID, full_name: "Ada Lovelace", file_number: "CF-0013",
      national_id: "123456789", phone: "+90 555 000 0000", email: "ada@example.com",
      date_of_birth: "1990-02-12", blood_type: "A+", created_at: "2025-02-12T08:00:00.000Z",
      avatar_path: avatarPath, is_deleted: false, departments: { name: "Dermatology" },
      assigned_doctor: { full_name: "Dr. Sara Emad" }, insurance_providers: { name: "Private" },
    }, error: null },
  };
  return {
    from: vi.fn((table: string) => query(rows[table])),
    storage: { from: vi.fn(() => ({ download: mocks.download })) },
  };
}

const user = {
  id: "user-1",
  clinicId: "clinic-1",
  role: "admin" as const,
  departmentId: null,
  email: "admin@clinic.test",
  fullName: "Clinic Admin",
  avatarUrl: null,
  mustChangePassword: false,
};

describe("Patient File profile photo resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inlineClinicLogo.mockResolvedValue(null);
  });

  it("inlines the stored patient photo for both preview and issuance snapshots", async () => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const imageSrc = `data:image/png;base64,${bytes.toString("base64")}`;
    mocks.download.mockResolvedValue({
      data: {
        size: 6 * 1024 * 1024,
        type: "image/png",
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      },
      error: null,
    });
    mocks.createClient.mockResolvedValue(clientForPatient(AVATAR_PATH));
    const params = { documentType: "PATIENT_FILE" as const, patientId: PATIENT_ID };

    const preview = await resolveRosterProfileDocumentSnapshot(user, params);
    const issuance = await resolveRosterProfileDocumentSnapshot(user, params, { inlineAssets: true });

    expect(preview.data).toMatchObject({
      kind: "patient-file", imageSrc,
      imageBackgroundSrc: expect.stringMatching(/^data:image\/webp;base64,/),
    });
    expect(issuance.data).toMatchObject({
      kind: "patient-file", imageSrc,
      imageBackgroundSrc: expect.stringMatching(/^data:image\/webp;base64,/),
    });
    expect(mocks.download).toHaveBeenCalledTimes(2);
    expect(mocks.download).toHaveBeenCalledWith(AVATAR_PATH);
  });

  it("keeps a null image source when the patient has no stored photo", async () => {
    mocks.createClient.mockResolvedValue(clientForPatient(null));

    const snapshot = await resolveRosterProfileDocumentSnapshot(
      user,
      { documentType: "PATIENT_FILE", patientId: PATIENT_ID },
    );

    expect(snapshot.data).toMatchObject({
      kind: "patient-file", imageSrc: null, imageBackgroundSrc: null,
    });
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
