import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

const STAFF_ID = "55555555-5555-4555-8555-555555555555";

function fileForm(file: File) {
  const fd = new FormData();
  fd.set("file", file);
  return fd;
}

async function loadStaffFileActions() {
  vi.resetModules();
  const mocks = createServerActionMocks();

  vi.doMock("@/lib/rbac", () => ({
    requireRole: mocks.state.requireRole,
    requireMutationRole: mocks.state.requireRole,
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  vi.doMock("next/cache", () => ({
    revalidatePath: mocks.state.revalidatePath,
    revalidateTag: vi.fn(),
  }));

  const actions = await import("@/actions/staff-files");
  return { ...actions, mocks };
}

describe("staff file uploads", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts staff PDF documents under the staff storage path", async () => {
    const { uploadStaffContract, mocks } = await loadStaffFileActions();
    mocks.state.authedUser.role = "manager";
    mocks.state.tableResults["profiles.select"] = {
      data: { id: STAFF_ID },
      error: null,
    };

    const result = await uploadStaffContract(
      STAFF_ID,
      fileForm(new File(["%PDF-1.4"], "contract.pdf", { type: "application/pdf" })),
    );

    expect(result.error).toBeUndefined();
    expect(mocks.state.storageLog).toContainEqual(
      expect.objectContaining({
        bucket: "clinic-assets",
        operation: "upload",
        args: [
          `staff/clinic-1/${STAFF_ID}/contract.pdf`,
          expect.any(File),
          expect.objectContaining({ contentType: "application/pdf" }),
        ],
      }),
    );
  });

  it("keeps existing staff image document uploads accepted", async () => {
    const { uploadStaffCertificate, mocks } = await loadStaffFileActions();
    mocks.state.tableResults["profiles.select"] = {
      data: { id: STAFF_ID },
      error: null,
    };

    const result = await uploadStaffCertificate(
      STAFF_ID,
      fileForm(new File(["png"], "certificate.png", { type: "image/png" })),
    );

    expect(result.error).toBeUndefined();
    expect(mocks.state.storageLog).toContainEqual(
      expect.objectContaining({
        bucket: "clinic-assets",
        operation: "upload",
        args: [
          expect.stringMatching(new RegExp(`^staff/clinic-1/${STAFF_ID}/certificates/`)),
          expect.any(File),
          expect.objectContaining({ contentType: "image/png" }),
        ],
      }),
    );
  });

  it.each([1, 6])("accepts a %d MB staff photo", async (sizeMb) => {
    const { uploadStaffPhoto, mocks } = await loadStaffFileActions();
    mocks.state.tableResults["profiles.select"] = {
      data: { id: STAFF_ID },
      error: null,
    };

    const result = await uploadStaffPhoto(
      STAFF_ID,
      fileForm(new File([new Uint8Array(sizeMb * 1024 * 1024)], "photo.webp", {
        type: "image/webp",
      })),
    );

    expect(result.error).toBeUndefined();
    expect(mocks.state.storageUpload).toHaveBeenCalledOnce();
  });

  it("rejects a staff photo larger than 6 MB with a clear message", async () => {
    const { uploadStaffPhoto, mocks } = await loadStaffFileActions();

    const result = await uploadStaffPhoto(
      STAFF_ID,
      fileForm(new File([new Uint8Array(6 * 1024 * 1024 + 1)], "photo.webp", {
        type: "image/webp",
      })),
    );

    expect(result).toEqual({ error: "Staff photo must be 6 MB or smaller." });
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("continues to reject unsupported staff photo types", async () => {
    const { uploadStaffPhoto, mocks } = await loadStaffFileActions();

    const result = await uploadStaffPhoto(
      STAFF_ID,
      fileForm(new File(["gif"], "photo.gif", { type: "image/gif" })),
    );

    expect(result).toEqual({ error: "Photo must be JPEG, PNG, or WebP." });
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("rejects unsupported staff document types before storage upload", async () => {
    const { uploadStaffOtherDoc, mocks } = await loadStaffFileActions();

    const result = await uploadStaffOtherDoc(
      STAFF_ID,
      fileForm(new File(["hello"], "notes.txt", { type: "text/plain" })),
    );

    expect(result).toEqual({ error: "Document must be PDF, Word, JPEG, or PNG." });
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("batches signed URL generation when listing staff files", async () => {
    const { listStaffFiles, mocks } = await loadStaffFileActions();
    mocks.state.tableResults["profiles.select"] = {
      data: { id: STAFF_ID },
      error: null,
    };
    mocks.state.storageList
      .mockResolvedValueOnce({
        data: [
          {
            name: "photo.webp",
            metadata: { size: 123 },
            created_at: "2026-05-01T00:00:00Z",
          },
          {
            name: "contract.pdf",
            metadata: { size: 456 },
            created_at: "2026-05-02T00:00:00Z",
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            name: "license.pdf",
            metadata: { size: 789 },
            created_at: "2026-05-03T00:00:00Z",
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: [], error: null });

    const result = await listStaffFiles(STAFF_ID);

    expect(result.error).toBeUndefined();
    expect(mocks.state.storageCreateSignedUrl).not.toHaveBeenCalled();
    expect(mocks.state.storageLog).toContainEqual(
      expect.objectContaining({
        bucket: "clinic-assets",
        operation: "createSignedUrls",
        args: [
          [
            `staff/clinic-1/${STAFF_ID}/photo.webp`,
            `staff/clinic-1/${STAFF_ID}/contract.pdf`,
            `staff/clinic-1/${STAFF_ID}/certificates/license.pdf`,
          ],
          3600,
        ],
      }),
    );
    expect(result.data?.photo?.url).toBe(
      `https://signed.local/staff/clinic-1/${STAFF_ID}/photo.webp`,
    );
    expect(result.data?.contract?.url).toBe(
      `https://signed.local/staff/clinic-1/${STAFF_ID}/contract.pdf`,
    );
    expect(result.data?.certificates[0]?.url).toBe(
      `https://signed.local/staff/clinic-1/${STAFF_ID}/certificates/license.pdf`,
    );
  });

  it("saves the Documents section for only the targeted staff member and persists its avatar", async () => {
    const { saveStaffDocuments, mocks } = await loadStaffFileActions();
    mocks.state.authedUser.role = "admin";
    mocks.state.tableResults["profiles.select"] = [
      { data: { id: STAFF_ID, role: "doctor" }, error: null },
      { data: { id: STAFF_ID }, error: null },
    ];
    mocks.state.storageList
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({
        data: [{
          name: "photo.webp",
          metadata: { size: 5 },
          created_at: "2026-08-09T00:00:00Z",
        }],
        error: null,
      })
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    const fd = new FormData();
    fd.set("photo_action", "replace");
    fd.set("contract_action", "keep");
    fd.set("remove_paths", "[]");
    fd.set("photo", new File(["photo"], "photo.webp", { type: "image/webp" }));

    const result = await saveStaffDocuments(STAFF_ID, fd);

    expect(result.error).toBeUndefined();
    expect(result.data?.photo?.path).toBe(`staff/clinic-1/${STAFF_ID}/photo.webp`);
    expect(mocks.state.storageLog).toContainEqual(expect.objectContaining({
      operation: "upload",
      args: [
        `staff/clinic-1/${STAFF_ID}/photo.webp`,
        expect.any(File),
        expect.objectContaining({ upsert: true }),
      ],
    }));

    const profileUpdate = mocks.state.queryLog.find((entry) =>
      entry.table === "profiles" && entry.operation === "update");
    expect(profileUpdate?.args[0]).toEqual({
      avatar_url: `https://signed.local/staff/clinic-1/${STAFF_ID}/photo.webp`,
    });
    expect(profileUpdate?.args[0]).not.toHaveProperty("professional_license_no");
    expect(profileUpdate?.args[0]).not.toHaveProperty("role");
    expect(mocks.state.queryLog).toContainEqual(expect.objectContaining({
      table: "profiles",
      args: ["eq", "id", STAFF_ID],
    }));
  });

  it("rejects document removals outside the opened staff member's file area", async () => {
    const { saveStaffDocuments, mocks } = await loadStaffFileActions();
    mocks.state.authedUser.role = "admin";
    mocks.state.tableResults["profiles.select"] = {
      data: { id: STAFF_ID, role: "doctor" },
      error: null,
    };
    const fd = new FormData();
    fd.set("photo_action", "keep");
    fd.set("contract_action", "keep");
    fd.set("remove_paths", JSON.stringify(["staff/clinic-1/another-staff/photo.webp"]));

    await expect(saveStaffDocuments(STAFF_ID, fd)).resolves.toEqual({
      error: "Unauthorized.",
    });
    expect(mocks.state.storageUpload).not.toHaveBeenCalled();
    expect(mocks.state.storageRemove).not.toHaveBeenCalled();
  });
});
