import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

const CLINIC_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const NOTE_ID = "33333333-3333-4333-8333-333333333333";
const ATTACHMENT_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "55555555-5555-4555-8555-555555555555";
const STORAGE_PATH = `medical-notes/${CLINIC_ID}/${PATIENT_ID}/${NOTE_ID}/${ATTACHMENT_ID}.pdf`;

function attachmentFile(type = "application/pdf", name = "scan.pdf") {
  return new File(["attachment"], name, { type });
}

function attachmentForm(file = attachmentFile()) {
  const form = new FormData();
  form.set("file", file);
  return form;
}

function noteRow() {
  return {
    id: NOTE_ID,
    patient_id: PATIENT_ID,
    doctor_id: USER_ID,
    created_by: USER_ID,
  };
}

function attachmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ATTACHMENT_ID,
    clinic_id: CLINIC_ID,
    patient_id: PATIENT_ID,
    note_id: NOTE_ID,
    file_name: "scan.pdf",
    mime_type: "application/pdf",
    size_bytes: 10,
    storage_path: STORAGE_PATH,
    uploaded_by: USER_ID,
    deleted_at: null,
    created_at: "2026-05-11T00:00:00Z",
    updated_at: "2026-05-11T00:00:00Z",
    uploaded_by_profile: { full_name: "Dr. User" },
    ...overrides,
  };
}

async function loadAttachmentActions() {
  vi.resetModules();
  const mocks = createServerActionMocks();
  mocks.state.authedUser = {
    id: USER_ID,
    clinicId: CLINIC_ID,
    role: "doctor",
    departmentId: null,
  };

  vi.doMock("next/cache", () => ({
    revalidatePath: mocks.state.revalidatePath,
  }));
  vi.doMock("@/lib/rbac", () => ({
    requireRole: mocks.state.requireRole,
    requireMutationRole: mocks.state.requireRole,
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));

  const actions = await import("@/actions/medical-note-attachments");
  return { ...actions, mocks };
}

describe("medical note attachment actions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads an authorized attachment into a private note-scoped path", async () => {
    const { uploadMedicalNoteAttachment, mocks } = await loadAttachmentActions();
    mocks.state.tableResults["medical_notes.select"] = [
      { data: noteRow(), error: null },
      { data: noteRow(), error: null },
    ];
    mocks.state.tableResults["medical_note_attachments.insert"] = {
      data: null,
      error: null,
    };
    mocks.state.tableResults["medical_note_attachments.select"] = {
      data: [attachmentRow()],
      error: null,
    };

    const result = await uploadMedicalNoteAttachment(
      PATIENT_ID,
      NOTE_ID,
      attachmentForm(),
    );

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual([
      expect.objectContaining({
        id: ATTACHMENT_ID,
        fileName: "scan.pdf",
        uploadedById: USER_ID,
      }),
    ]);
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "medical_note_attachments",
        operation: "insert",
        args: [
          expect.objectContaining({
            clinic_id: CLINIC_ID,
            patient_id: PATIENT_ID,
            note_id: NOTE_ID,
            uploaded_by: USER_ID,
            storage_path: expect.stringMatching(
              new RegExp(
                `^medical-notes/${CLINIC_ID}/${PATIENT_ID}/${NOTE_ID}/[0-9a-f-]+\\.pdf$`,
                "i",
              ),
            ),
          }),
        ],
      }),
    );
    expect(mocks.state.storageLog).toContainEqual(
      expect.objectContaining({
        bucket: "patient-assets",
        operation: "upload",
      }),
    );
  });

  it("rejects invalid file types before storage upload", async () => {
    const { uploadMedicalNoteAttachment, mocks } = await loadAttachmentActions();
    mocks.state.tableResults["medical_notes.select"] = {
      data: noteRow(),
      error: null,
    };

    const result = await uploadMedicalNoteAttachment(
      PATIENT_ID,
      NOTE_ID,
      attachmentForm(attachmentFile("text/plain", "note.txt")),
    );

    expect(result).toEqual({
      error: "Attachment must be a PDF, JPEG, PNG, or WebP file.",
    });
    expect(mocks.state.storageLog).toEqual([]);
  });

  it("denies upload for cross-clinic or unauthorized doctor note access", async () => {
    const { uploadMedicalNoteAttachment, mocks } = await loadAttachmentActions();
    mocks.state.tableResults["medical_notes.select"] = {
      data: null,
      error: null,
    };

    const result = await uploadMedicalNoteAttachment(
      PATIENT_ID,
      NOTE_ID,
      attachmentForm(),
    );

    expect(result).toEqual({ error: "Medical note not found." });
    expect(
      mocks.state.queryLog.some(
        (entry) => entry.table === "medical_note_attachments",
      ),
    ).toBe(false);
  });

  it("creates signed URLs only after note and path validation", async () => {
    const { getMedicalNoteAttachmentSignedUrl, mocks } =
      await loadAttachmentActions();
    mocks.state.tableResults["medical_notes.select"] = {
      data: noteRow(),
      error: null,
    };
    mocks.state.tableResults["medical_note_attachments.select"] = {
      data: attachmentRow(),
      error: null,
    };

    const result = await getMedicalNoteAttachmentSignedUrl(
      PATIENT_ID,
      NOTE_ID,
      ATTACHMENT_ID,
    );

    expect(result.data?.url).toBe(`https://signed.local/${STORAGE_PATH}`);
    expect(mocks.state.storageLog).toEqual([
      {
        bucket: "patient-assets",
        operation: "createSignedUrl",
        args: [STORAGE_PATH, 10 * 60],
      },
    ]);
  });

  it("rejects signed URLs when the stored path is outside the note scope", async () => {
    const { getMedicalNoteAttachmentSignedUrl, mocks } =
      await loadAttachmentActions();
    mocks.state.tableResults["medical_notes.select"] = {
      data: noteRow(),
      error: null,
    };
    mocks.state.tableResults["medical_note_attachments.select"] = {
      data: attachmentRow({ storage_path: "medical-notes/other/path.pdf" }),
      error: null,
    };

    const result = await getMedicalNoteAttachmentSignedUrl(
      PATIENT_ID,
      NOTE_ID,
      ATTACHMENT_ID,
    );

    expect(result).toEqual({
      error: "Stored attachment path is not valid for this note.",
    });
    expect(mocks.state.storageLog).toEqual([]);
  });

  it("soft-deletes the DB row without removing private storage on delete", async () => {
    const { deleteMedicalNoteAttachment, mocks } = await loadAttachmentActions();
    mocks.state.tableResults["medical_notes.select"] = [
      { data: noteRow(), error: null },
      { data: noteRow(), error: null },
    ];
    mocks.state.tableResults["medical_note_attachments.select"] = [
      { data: attachmentRow(), error: null },
      { data: [], error: null },
    ];
    mocks.state.rpcResults.soft_delete_medical_note_attachment = {
      data: null,
      error: null,
    };

    const result = await deleteMedicalNoteAttachment(
      PATIENT_ID,
      NOTE_ID,
      ATTACHMENT_ID,
    );

    expect(result.error).toBeUndefined();
    expect(mocks.state.rpc).toHaveBeenCalledWith(
      "soft_delete_medical_note_attachment",
      {
        p_attachment_id: ATTACHMENT_ID,
        p_note_id: NOTE_ID,
        p_patient_id: PATIENT_ID,
      },
    );
    expect(mocks.state.storageLog).toEqual([]);
  });

  it("still completes delete when storage object is already missing", async () => {
    const { deleteMedicalNoteAttachment, mocks } = await loadAttachmentActions();
    mocks.state.tableResults["medical_notes.select"] = [
      { data: noteRow(), error: null },
      { data: noteRow(), error: null },
    ];
    mocks.state.tableResults["medical_note_attachments.select"] = [
      { data: attachmentRow(), error: null },
      { data: [], error: null },
    ];
    mocks.state.rpcResults.soft_delete_medical_note_attachment = {
      data: null,
      error: null,
    };
    const result = await deleteMedicalNoteAttachment(
      PATIENT_ID,
      NOTE_ID,
      ATTACHMENT_ID,
    );

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual([]);
    expect(mocks.state.rpc).toHaveBeenCalledWith(
      "soft_delete_medical_note_attachment",
      {
        p_attachment_id: ATTACHMENT_ID,
        p_note_id: NOTE_ID,
        p_patient_id: PATIENT_ID,
      },
    );
    expect(mocks.state.storageLog).toEqual([]);
  });

  it("does not remove storage and logs diagnostics if the DB soft-delete RPC fails", async () => {
    const { deleteMedicalNoteAttachment, mocks } = await loadAttachmentActions();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.state.tableResults["medical_notes.select"] = {
      data: noteRow(),
      error: null,
    };
    mocks.state.tableResults["medical_note_attachments.select"] = {
      data: attachmentRow(),
      error: null,
    };
    mocks.state.rpcResults.soft_delete_medical_note_attachment = {
      data: null,
      error: {
        code: "42501",
        message: "update failed",
        details: "rls rejected",
        hint: "check note ownership",
      },
    };

    const result = await deleteMedicalNoteAttachment(
      PATIENT_ID,
      NOTE_ID,
      ATTACHMENT_ID,
    );

    expect(result).toEqual({ error: "Failed to delete attachment record." });
    expect(mocks.state.storageLog).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      "medical_note_attachment_delete_failed",
      expect.objectContaining({
        code: "42501",
        message: "update failed",
        details: "rls rejected",
        hint: "check note ownership",
        patientId: PATIENT_ID,
        noteId: NOTE_ID,
        attachmentId: ATTACHMENT_ID,
      }),
    );
  });

  it("treats repeated attachment delete attempts as idempotent", async () => {
    const { deleteMedicalNoteAttachment, mocks } = await loadAttachmentActions();
    mocks.state.tableResults["medical_notes.select"] = [
      { data: noteRow(), error: null },
      { data: noteRow(), error: null },
    ];
    mocks.state.tableResults["medical_note_attachments.select"] = [
      { data: null, error: { message: "not found" } },
      { data: [], error: null },
    ];

    const result = await deleteMedicalNoteAttachment(
      PATIENT_ID,
      NOTE_ID,
      ATTACHMENT_ID,
    );

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual([]);
    expect(mocks.state.storageLog).toEqual([]);
  });

  it("restores a soft-deleted attachment during the undo window", async () => {
    const { restoreMedicalNoteAttachment, mocks } = await loadAttachmentActions();
    mocks.state.tableResults["medical_notes.select"] = [
      { data: noteRow(), error: null },
      { data: noteRow(), error: null },
    ];
    mocks.state.rpcResults.restore_medical_note_attachment = {
      data: null,
      error: null,
    };
    mocks.state.tableResults["medical_note_attachments.select"] = {
      data: [attachmentRow()],
      error: null,
    };

    const result = await restoreMedicalNoteAttachment(
      PATIENT_ID,
      NOTE_ID,
      ATTACHMENT_ID,
    );

    expect(result.error).toBeUndefined();
    expect(mocks.state.rpc).toHaveBeenCalledWith(
      "restore_medical_note_attachment",
      {
        p_attachment_id: ATTACHMENT_ID,
        p_note_id: NOTE_ID,
        p_patient_id: PATIENT_ID,
      },
    );
  });

  it("treats repeated attachment undo restore as idempotent through the restore RPC", async () => {
    const { restoreMedicalNoteAttachment, mocks } = await loadAttachmentActions();
    mocks.state.tableResults["medical_notes.select"] = [
      { data: noteRow(), error: null },
      { data: noteRow(), error: null },
    ];
    mocks.state.rpcResults.restore_medical_note_attachment = {
      data: true,
      error: null,
    };
    mocks.state.tableResults["medical_note_attachments.select"] = {
      data: [attachmentRow()],
      error: null,
    };

    const result = await restoreMedicalNoteAttachment(
      PATIENT_ID,
      NOTE_ID,
      ATTACHMENT_ID,
    );

    expect(result.error).toBeUndefined();
    expect(result.data?.[0]?.id).toBe(ATTACHMENT_ID);
    expect(mocks.state.storageLog).toEqual([]);
  });

  it("returns a clear unavailable-file message and logs diagnostics when attachment signing fails", async () => {
    const { getMedicalNoteAttachmentSignedUrl, mocks } =
      await loadAttachmentActions();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.state.tableResults["medical_notes.select"] = {
      data: noteRow(),
      error: null,
    };
    mocks.state.tableResults["medical_note_attachments.select"] = {
      data: attachmentRow(),
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

    const result = await getMedicalNoteAttachmentSignedUrl(
      PATIENT_ID,
      NOTE_ID,
      ATTACHMENT_ID,
    );

    expect(result).toEqual({
      error: "Attachment file is missing or unavailable.",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "medical_note_attachment_signed_url_failed",
      expect.objectContaining({
        code: "404",
        message: "Object not found",
        details: "missing storage object",
        hint: "verify storage_path",
        storagePath: STORAGE_PATH,
      }),
    );
  });
});
