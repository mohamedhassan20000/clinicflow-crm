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
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
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

  it("rejects unsupported staff document types before storage upload", async () => {
    const { uploadStaffOtherDoc, mocks } = await loadStaffFileActions();

    const result = await uploadStaffOtherDoc(
      STAFF_ID,
      fileForm(new File(["hello"], "notes.txt", { type: "text/plain" })),
    );

    expect(result).toEqual({ error: "Document must be PDF, Word, JPEG, or PNG." });
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });
});
