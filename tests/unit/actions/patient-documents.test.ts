import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";
const CLINIC_ID = "clinic-1";
const DOCUMENT_PATH = `documents/${CLINIC_ID}/${PATIENT_ID}/national_id/${DOCUMENT_ID}.pdf`;
const NATIONAL_ID_PATH_PATTERN = new RegExp(
  `^documents/${CLINIC_ID}/${PATIENT_ID}/national_id/[0-9a-f-]{36}\\.pdf$`,
);

function documentForm(fileType = "application/pdf", name = "national id.pdf") {
  const form = new FormData();
  form.set("file", new File(["document"], name, { type: fileType }));
  return form;
}

function oversizedDocumentForm() {
  const form = new FormData();
  form.set(
    "file",
    new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.pdf", {
      type: "application/pdf",
    }),
  );
  return form;
}

function patientRow() {
  return { id: PATIENT_ID };
}

function documentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DOCUMENT_ID,
    clinic_id: CLINIC_ID,
    patient_id: PATIENT_ID,
    category: "national_id",
    label: null,
    file_name: "national id.pdf",
    mime_type: "application/pdf",
    size_bytes: 8,
    storage_path: DOCUMENT_PATH,
    uploaded_by: "user-1",
    deleted_at: null,
    created_at: "2026-05-10T00:00:00.000Z",
    updated_at: "2026-05-10T00:00:00.000Z",
    uploaded_by_profile: { full_name: "Reception One" },
    ...overrides,
  };
}

async function loadPatientDocumentActions() {
  vi.resetModules();
  const mocks = createServerActionMocks();

  vi.doMock("node:crypto", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:crypto")>()),
    randomUUID: vi.fn(() => DOCUMENT_ID),
  }));
  vi.doMock("next/cache", () => ({
    revalidatePath: mocks.state.revalidatePath,
  }));
  vi.doMock("@/lib/rbac", () => ({
    requireRole: mocks.state.requireRole,
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));

  const actions = await import("@/actions/patient-documents");
  return { ...actions, mocks };
}

describe("patient document actions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists grouped patient document metadata without signed URLs", async () => {
    const { listPatientDocuments, mocks } = await loadPatientDocumentActions();
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };
    mocks.state.tableResults["patient_documents.select"] = {
      data: [documentRow()],
      error: null,
    };

    const result = await listPatientDocuments(PATIENT_ID);

    expect(result).toEqual({
      data: {
        nationalId: {
          id: DOCUMENT_ID,
          category: "national_id",
          label: null,
          fileName: "national id.pdf",
          mimeType: "application/pdf",
          sizeBytes: 8,
          createdAt: "2026-05-10T00:00:00.000Z",
          uploadedByName: "Reception One",
        },
        insurance: null,
        other: [],
      },
    });
    expect(mocks.state.requireRole).toHaveBeenCalledWith([
      "admin",
      "receptionist",
    ]);
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("creates a DB row before storage upload and never uses the filename in the storage path", async () => {
    const { uploadPatientDocument, mocks } = await loadPatientDocumentActions();
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };
    mocks.state.tableResults["patient_documents.insert"] = {
      data: null,
      error: null,
    };
    mocks.state.tableResults["patient_documents.update"] = {
      data: null,
      error: null,
    };
    mocks.state.tableResults["patient_documents.select"] = {
      data: [documentRow()],
      error: null,
    };

    const result = await uploadPatientDocument(
      PATIENT_ID,
      "national_id",
      documentForm("application/pdf", "../private national id.pdf"),
    );

    expect(result.ok).toBe(true);
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patient_documents",
        operation: "insert",
        args: [
          expect.objectContaining({
            id: expect.stringMatching(/^[0-9a-f-]{36}$/),
            clinic_id: CLINIC_ID,
            patient_id: PATIENT_ID,
            category: "national_id",
            storage_path: expect.stringMatching(NATIONAL_ID_PATH_PATTERN),
            file_name: ".._private national id.pdf",
            uploaded_by: "user-1",
          }),
        ],
      }),
    );
    expect(mocks.state.storageLog).toContainEqual(
      expect.objectContaining({
        bucket: "patient-assets",
        operation: "upload",
        args: [
          expect.stringMatching(NATIONAL_ID_PATH_PATTERN),
          expect.any(Uint8Array),
          expect.objectContaining({
            contentType: "application/pdf",
            upsert: false,
          }),
        ],
      }),
    );
    expect(DOCUMENT_PATH).not.toContain("private national id");
  });

  it("uses the MIME-derived extension instead of the original filename extension", async () => {
    const { uploadPatientDocument, mocks } = await loadPatientDocumentActions();
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };
    mocks.state.tableResults["patient_documents.insert"] = {
      data: null,
      error: null,
    };
    mocks.state.tableResults["patient_documents.select"] = [
      { data: null, error: { message: "not found" } },
      { data: [], error: null },
    ];

    const result = await uploadPatientDocument(
      PATIENT_ID,
      "other",
      documentForm("application/pdf", "scan.jpg"),
    );

    expect(result.ok).toBe(true);
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patient_documents",
        operation: "insert",
        args: [
          expect.objectContaining({
            file_name: "scan.jpg",
            mime_type: "application/pdf",
            storage_path: expect.stringMatching(
              new RegExp(`^documents/${CLINIC_ID}/${PATIENT_ID}/other/[0-9a-f-]{36}\\.pdf$`),
            ),
          }),
        ],
      }),
    );
  });

  it("soft-deletes the inserted row if storage upload fails", async () => {
    const { uploadPatientDocument, mocks } = await loadPatientDocumentActions();
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };
    mocks.state.tableResults["patient_documents.insert"] = {
      data: null,
      error: null,
    };
    mocks.state.tableResults["patient_documents.update"] = {
      data: null,
      error: null,
    };
    mocks.state.storageUpload.mockResolvedValue({
      data: null,
      error: { message: "storage failed" },
    });

    const result = await uploadPatientDocument(
      PATIENT_ID,
      "national_id",
      documentForm(),
    );

    expect(result).toEqual({ error: "storage failed" });
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patient_documents",
        operation: "update",
        args: [expect.objectContaining({ deleted_at: expect.any(String) })],
      }),
    );
  });

  it("handles duplicate single-slot documents before storage upload", async () => {
    const { uploadPatientDocument, mocks } = await loadPatientDocumentActions();
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };
    mocks.state.tableResults["patient_documents.insert"] = {
      data: null,
      error: { code: "23505", message: "duplicate key" },
    };

    const result = await uploadPatientDocument(
      PATIENT_ID,
      "insurance",
      documentForm("image/png", "insurance.png"),
    );

    expect(result).toEqual({
      error:
        "An insurance document already exists. Delete it before uploading a replacement.",
    });
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("blocks unauthorized upload before DB or storage access", async () => {
    const { uploadPatientDocument, mocks } = await loadPatientDocumentActions();
    mocks.state.requireRole.mockRejectedValue(new Error("redirected"));

    await expect(
      uploadPatientDocument(PATIENT_ID, "national_id", documentForm()),
    ).rejects.toThrow("redirected");

    expect(mocks.state.from).not.toHaveBeenCalled();
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("rejects invalid categories before patient, DB, or storage access", async () => {
    const { uploadPatientDocument, mocks } = await loadPatientDocumentActions();

    const result = await uploadPatientDocument(
      PATIENT_ID,
      "passport" as never,
      documentForm(),
    );

    expect(result).toEqual({ error: "Select a valid document category." });
    expect(mocks.state.from).not.toHaveBeenCalled();
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("rejects missing files before document DB or storage writes", async () => {
    const { uploadPatientDocument, mocks } = await loadPatientDocumentActions();
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };

    const result = await uploadPatientDocument(
      PATIENT_ID,
      "other",
      new FormData(),
    );

    expect(result).toEqual({ error: "Pick a document to upload." });
    expect(
      mocks.state.queryLog.some(
        (entry) =>
          entry.table === "patient_documents" && entry.operation === "insert",
      ),
    ).toBe(false);
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("rejects oversized files before document DB or storage writes", async () => {
    const { uploadPatientDocument, mocks } = await loadPatientDocumentActions();
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };

    const result = await uploadPatientDocument(
      PATIENT_ID,
      "other",
      oversizedDocumentForm(),
    );

    expect(result).toEqual({ error: "Document must be under 10 MB." });
    expect(
      mocks.state.queryLog.some(
        (entry) =>
          entry.table === "patient_documents" && entry.operation === "insert",
      ),
    ).toBe(false);
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("returns patient not found before document DB or storage writes", async () => {
    const { uploadPatientDocument, mocks } = await loadPatientDocumentActions();
    mocks.state.tableResults["patients.select"] = {
      data: null,
      error: { message: "not found" },
    };

    const result = await uploadPatientDocument(
      PATIENT_ID,
      "other",
      documentForm(),
    );

    expect(result).toEqual({ error: "Patient not found." });
    expect(
      mocks.state.queryLog.some(
        (entry) =>
          entry.table === "patient_documents" && entry.operation === "insert",
      ),
    ).toBe(false);
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("rejects Office documents before DB or storage writes", async () => {
    const { uploadPatientDocument, mocks } = await loadPatientDocumentActions();
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };

    const result = await uploadPatientDocument(
      PATIENT_ID,
      "other",
      documentForm(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "letter.docx",
      ),
    );

    expect(result).toEqual({
      error: "Document must be a PDF, JPEG, PNG, or WebP file.",
    });
    expect(
      mocks.state.queryLog.some(
        (entry) =>
          entry.table === "patient_documents" && entry.operation === "insert",
      ),
    ).toBe(false);
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("refuses delete when the stored path does not match the patient document namespace", async () => {
    const { deletePatientDocument, mocks } = await loadPatientDocumentActions();
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };
    mocks.state.tableResults["patient_documents.select"] = {
      data: documentRow({ storage_path: `avatars/${CLINIC_ID}/${PATIENT_ID}/avatar.webp` }),
      error: null,
    };

    const result = await deletePatientDocument(PATIENT_ID, DOCUMENT_ID);

    expect(result).toEqual({
      error: "Stored document path is not valid for this patient.",
    });
    expect(mocks.state.storageRemove).not.toHaveBeenCalled();
  });

  it("soft-deletes the document row without removing private storage on delete", async () => {
    const { deletePatientDocument, mocks } = await loadPatientDocumentActions();
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };
    mocks.state.tableResults["patient_documents.select"] = [
      {
        data: documentRow(),
        error: null,
      },
      {
        data: [],
        error: null,
      },
    ];
    mocks.state.rpcResults.soft_delete_patient_document = {
      data: null,
      error: null,
    };

    const result = await deletePatientDocument(PATIENT_ID, DOCUMENT_ID);

    expect(result.ok).toBe(true);
    expect(mocks.state.storageLog).toEqual([]);
    expect(mocks.state.rpc).toHaveBeenCalledWith(
      "soft_delete_patient_document",
      {
        p_document_id: DOCUMENT_ID,
        p_patient_id: PATIENT_ID,
      },
    );
  });

  it("blocks unauthorized delete before DB or storage access", async () => {
    const { deletePatientDocument, mocks } = await loadPatientDocumentActions();
    mocks.state.requireRole.mockRejectedValue(new Error("redirected"));

    await expect(deletePatientDocument(PATIENT_ID, DOCUMENT_ID)).rejects.toThrow(
      "redirected",
    );

    expect(mocks.state.from).not.toHaveBeenCalled();
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("treats repeated delete for missing or already-deleted documents as idempotent", async () => {
    const { deletePatientDocument, mocks } = await loadPatientDocumentActions();
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };
    mocks.state.tableResults["patient_documents.select"] = [
      { data: null, error: { message: "not found" } },
      { data: [], error: null },
    ];

    const result = await deletePatientDocument(PATIENT_ID, DOCUMENT_ID);

    expect(result).toEqual({
      ok: true,
      data: {
        nationalId: null,
        insurance: null,
        other: [],
      },
    });
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("soft-deletes the document row even if the storage object is already missing", async () => {
    const { deletePatientDocument, mocks } = await loadPatientDocumentActions();
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };
    mocks.state.tableResults["patient_documents.select"] = [
      {
        data: documentRow(),
        error: null,
      },
      {
        data: [],
        error: null,
      },
    ];
    mocks.state.rpcResults.soft_delete_patient_document = {
      data: null,
      error: null,
    };
    const result = await deletePatientDocument(PATIENT_ID, DOCUMENT_ID);

    expect(result.ok).toBe(true);
    expect(mocks.state.rpc).toHaveBeenCalledWith(
      "soft_delete_patient_document",
      {
        p_document_id: DOCUMENT_ID,
        p_patient_id: PATIENT_ID,
      },
    );
    expect(mocks.state.storageRemove).not.toHaveBeenCalled();
  });

  it("keeps view state intact and logs diagnostics when DB soft-delete RPC fails", async () => {
    const { deletePatientDocument, mocks } = await loadPatientDocumentActions();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };
    mocks.state.tableResults["patient_documents.select"] = {
      data: documentRow(),
      error: null,
    };
    mocks.state.rpcResults.soft_delete_patient_document = {
      data: null,
      error: {
        code: "42501",
        message: "update failed",
        details: "rls rejected",
        hint: "check policy",
      },
    };

    const result = await deletePatientDocument(PATIENT_ID, DOCUMENT_ID);

    expect(result).toEqual({ error: "Failed to delete document record." });
    expect(mocks.state.storageRemove).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "patient_document_delete_failed",
      expect.objectContaining({
        code: "42501",
        message: "update failed",
        details: "rls rejected",
        hint: "check policy",
        patientId: PATIENT_ID,
        documentId: DOCUMENT_ID,
      }),
    );
  });

  it("returns a record error before storage is removed when DB soft-delete fails", async () => {
    const { deletePatientDocument, mocks } = await loadPatientDocumentActions();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };
    mocks.state.tableResults["patient_documents.select"] = {
      data: documentRow(),
      error: null,
    };
    mocks.state.rpcResults.soft_delete_patient_document = {
      data: null,
      error: { message: "update failed" },
    };

    const result = await deletePatientDocument(PATIENT_ID, DOCUMENT_ID);

    expect(result).toEqual({ error: "Failed to delete document record." });
    expect(mocks.state.storageRemove).not.toHaveBeenCalled();
  });

  it("restores a soft-deleted document during the undo window", async () => {
    const { restorePatientDocument, mocks } = await loadPatientDocumentActions();
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };
    mocks.state.tableResults["patient_documents.update"] = {
      data: null,
      error: null,
    };
    mocks.state.tableResults["patient_documents.select"] = {
      data: [documentRow()],
      error: null,
    };

    const result = await restorePatientDocument(PATIENT_ID, DOCUMENT_ID);

    expect(result.ok).toBe(true);
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patient_documents",
        operation: "update",
        args: [expect.objectContaining({ deleted_at: null })],
      }),
    );
    expect(mocks.state.storageLog).toEqual([]);
  });

  it("generates short-lived signed URLs only after document ownership validation", async () => {
    const { getPatientDocumentSignedUrl, mocks } =
      await loadPatientDocumentActions();
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };
    mocks.state.tableResults["patient_documents.select"] = {
      data: documentRow(),
      error: null,
    };

    const result = await getPatientDocumentSignedUrl(PATIENT_ID, DOCUMENT_ID);

    expect(result).toEqual({
      data: { url: `https://signed.local/${DOCUMENT_PATH}` },
    });
    expect(mocks.state.storageLog).toEqual([
      {
        bucket: "patient-assets",
        operation: "createSignedUrl",
        args: [DOCUMENT_PATH, 10 * 60],
      },
    ]);
  });

  it("blocks unauthorized signed URL generation before DB or storage access", async () => {
    const { getPatientDocumentSignedUrl, mocks } =
      await loadPatientDocumentActions();
    mocks.state.requireRole.mockRejectedValue(new Error("redirected"));

    await expect(
      getPatientDocumentSignedUrl(PATIENT_ID, DOCUMENT_ID),
    ).rejects.toThrow("redirected");

    expect(mocks.state.from).not.toHaveBeenCalled();
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("does not sign missing or deleted documents", async () => {
    const { getPatientDocumentSignedUrl, mocks } =
      await loadPatientDocumentActions();
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };
    mocks.state.tableResults["patient_documents.select"] = {
      data: null,
      error: { message: "not found" },
    };

    const result = await getPatientDocumentSignedUrl(PATIENT_ID, DOCUMENT_ID);

    expect(result).toEqual({ error: "Document not found." });
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("does not sign malformed document paths", async () => {
    const { getPatientDocumentSignedUrl, mocks } =
      await loadPatientDocumentActions();
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };
    mocks.state.tableResults["patient_documents.select"] = {
      data: documentRow({
        storage_path: `documents/${CLINIC_ID}/${PATIENT_ID}/other/not-a-uuid.pdf`,
      }),
      error: null,
    };

    const result = await getPatientDocumentSignedUrl(PATIENT_ID, DOCUMENT_ID);

    expect(result).toEqual({
      error: "Stored document path is not valid for this patient.",
    });
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("returns a clear unavailable-file message and logs diagnostics when storage signing fails", async () => {
    const { getPatientDocumentSignedUrl, mocks } =
      await loadPatientDocumentActions();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.state.tableResults["patients.select"] = {
      data: patientRow(),
      error: null,
    };
    mocks.state.tableResults["patient_documents.select"] = {
      data: documentRow(),
      error: null,
    };
    mocks.state.storageCreateSignedUrl.mockResolvedValue({
      data: null,
      error: {
        code: "404",
        message: "Object not found",
        details: "missing storage object",
        hint: "verify storage_path",
      },
    });

    const result = await getPatientDocumentSignedUrl(PATIENT_ID, DOCUMENT_ID);

    expect(result).toEqual({
      error: "Document file is missing or unavailable.",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "patient_document_signed_url_failed",
      expect.objectContaining({
        code: "404",
        message: "Object not found",
        details: "missing storage object",
        hint: "verify storage_path",
        storagePath: DOCUMENT_PATH,
      }),
    );
  });
});
