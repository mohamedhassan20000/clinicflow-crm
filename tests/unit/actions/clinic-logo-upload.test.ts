import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  getPublicUrl: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  revalidatePath: vi.fn(),
  requireMutationRole: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
  revalidateTag: vi.fn(),
}));

vi.mock("@/lib/rbac", () => ({
  requireMutationRole: mocks.requireMutationRole,
  requireRole: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    storage: {
      from: vi.fn(() => ({
        upload: mocks.upload,
        getPublicUrl: mocks.getPublicUrl,
      })),
    },
    from: vi.fn(() => ({
      update: mocks.update,
    })),
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: vi.fn(),
}));

vi.mock("@/actions/page-permissions", () => ({
  ensureDefaultPagePermissions: vi.fn(),
}));

import { uploadClinicLogo } from "@/actions/settings";

describe("uploadClinicLogo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireMutationRole.mockResolvedValue({
      id: "admin-1",
      clinicId: "clinic-1",
      role: "admin",
    });
    mocks.upload.mockResolvedValue({
      data: { path: "logo-clean-v1.png" },
      error: null,
    });
    mocks.getPublicUrl.mockReturnValue({
      data: {
        publicUrl:
          "https://assets.example/clinics/clinic-1/logo-clean-v1.png",
      },
    });
    mocks.update.mockReturnValue({ eq: mocks.eq });
    mocks.eq.mockResolvedValue({ error: null });
  });

  it("stores the cleaned logo once as the clinic-wide PNG asset", async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect x="50" y="30" width="100" height="60" fill="#1264a3" /></svg>',
    );
    const formData = new FormData();
    formData.set(
      "logo",
      new File([source], "clinic-logo.svg", { type: "image/svg+xml" }),
    );

    const result = await uploadClinicLogo(formData);

    expect(result.success).toBe(true);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    const [path, uploadedBytes, options] = mocks.upload.mock.calls[0];
    expect(path).toBe("clinics/clinic-1/logo-clean-v1.png");
    expect(options).toEqual({ upsert: true, contentType: "image/png" });

    const metadata = await sharp(uploadedBytes).metadata();
    expect(metadata).toMatchObject({ format: "png", width: 108, height: 64 });
    expect(mocks.update).toHaveBeenCalledWith({
      logo_url: expect.stringMatching(
        /^https:\/\/assets\.example\/clinics\/clinic-1\/logo-clean-v1\.png\?t=\d+$/,
      ),
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings/clinic");
  });

  it("does not store an image whose pixels cannot be decoded", async () => {
    const formData = new FormData();
    formData.set(
      "logo",
      new File(["not an image"], "broken.png", { type: "image/png" }),
    );

    const result = await uploadClinicLogo(formData);

    expect(result.error).toBeTruthy();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not report success when the cleaned logo URL cannot be saved", async () => {
    mocks.eq.mockResolvedValue({ error: { message: "database unavailable" } });
    const formData = new FormData();
    formData.set(
      "logo",
      new File(
        [
          '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8" fill="#1264a3" /></svg>',
        ],
        "clinic-logo.svg",
        { type: "image/svg+xml" },
      ),
    );

    const result = await uploadClinicLogo(formData);

    expect(result.success).not.toBe(true);
    expect(result.error).toBeTruthy();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
