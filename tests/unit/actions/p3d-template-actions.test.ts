import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMutationRole: vi.fn(),
  requireRole: vi.fn(),
  revalidatePath: vi.fn(),
  getEntitlements: vi.fn(),
  hasFeature: vi.fn(),
  decryptChannelCredentials: vi.fn(),
  submitDialog360Template: vi.fn(),
  deleteDialog360Template: vi.fn(),
  state: {
    // Per-table, per-operation results. Key form: "<table>" (read),
    // "<table>.update", "<table>.delete", "<table>.insert".
    results: {} as Record<string, { data: unknown; error: unknown }>,
    inserts: [] as Array<{ table: string; payload: unknown }>,
    updates: [] as Array<{ table: string; payload: unknown; filters: unknown[] }>,
    deletes: [] as Array<{ table: string; filters: unknown[] }>,
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/i18n/action-errors", () => ({
  actionError: (key: string) => Promise.resolve(key),
}));
vi.mock("@/lib/rbac", () => ({
  requireMutationRole: mocks.requireMutationRole,
  requireRole: mocks.requireRole,
}));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: mocks.getEntitlements,
  hasFeature: mocks.hasFeature,
}));
vi.mock("@/lib/messaging/channel-management", () => ({
  connectDialog360Channel: vi.fn(),
  getWhatsAppChannelStatus: vi.fn(),
}));
vi.mock("@/lib/messaging/crypto", () => ({
  decryptChannelCredentials: mocks.decryptChannelCredentials,
}));
vi.mock("@/lib/messaging/whatsapp-dialog360", () => ({
  submitDialog360Template: mocks.submitDialog360Template,
  deleteDialog360Template: mocks.deleteDialog360Template,
}));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  setInboxConversationPatient: vi.fn(),
  createClinicScopedAdminClient: () => ({
    from: (table: string) => {
      const filters: unknown[] = [];
      let operation: "select" | "update" | "delete" | "insert" = "select";
      const resultFor = () =>
        operation === "select"
          ? mocks.state.results[table] ?? { data: null, error: null }
          : mocks.state.results[`${table}.${operation}`] ?? { data: null, error: null };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (...args: unknown[]) => {
          filters.push(["eq", ...args]);
          return chain;
        },
        neq: (...args: unknown[]) => {
          filters.push(["neq", ...args]);
          return chain;
        },
        in: (...args: unknown[]) => {
          filters.push(["in", ...args]);
          return chain;
        },
        is: (...args: unknown[]) => {
          filters.push(["is", ...args]);
          return chain;
        },
        maybeSingle: () => Promise.resolve(resultFor()),
        insert: (payload: unknown) => {
          operation = "insert";
          mocks.state.inserts.push({ table, payload });
          return Promise.resolve(resultFor());
        },
        update: (payload: unknown) => {
          operation = "update";
          mocks.state.updates.push({ table, payload, filters });
          return chain;
        },
        delete: () => {
          operation = "delete";
          mocks.state.deletes.push({ table, filters });
          return chain;
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(resultFor()).then(resolve),
      };
      return chain;
    },
  }),
}));

import {
  deleteMessageTemplate,
  saveMessageTemplate,
  submitWhatsAppTemplate,
} from "@/actions/messaging";

const templateId = "55555555-5555-4555-8555-555555555555";

function templateForm(overrides: Record<string, string | string[]> = {}) {
  const formData = new FormData();
  const base: Record<string, string | string[]> = {
    channel: "whatsapp",
    name: "appointment_reminder",
    language: "ar",
    body: "مرحباً {{patient_name}}، موعدكم {{appointment_date}}",
    variables: ["patient_name", "appointment_date"],
    ...overrides,
  };
  for (const [key, value] of Object.entries(base)) {
    if (Array.isArray(value)) value.forEach((item) => formData.append(key, item));
    else if (value) formData.set(key, value);
  }
  return formData;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.results = {};
  mocks.state.inserts = [];
  mocks.state.updates = [];
  mocks.state.deletes = [];
  mocks.requireMutationRole.mockResolvedValue({
    id: "user-1",
    clinicId: "clinic-1",
    role: "admin",
  });
  mocks.hasFeature.mockReturnValue(true);
  mocks.getEntitlements.mockResolvedValue({ features: { whatsapp: true } });
});

describe("saveMessageTemplate", () => {
  it("creates a draft template scoped to the caller's clinic", async () => {
    const result = await saveMessageTemplate(null, templateForm());
    expect(result).toEqual({ success: true });
    expect(mocks.requireMutationRole).toHaveBeenCalledWith(["admin", "manager"]);
    expect(mocks.state.inserts[0]).toMatchObject({
      table: "message_templates",
      payload: expect.objectContaining({
        clinic_id: "clinic-1",
        approval_status: "draft",
        name: "appointment_reminder",
        variables: ["patient_name", "appointment_date"],
      }),
    });
  });

  it("rejects a WhatsApp template name outside the provider contract", async () => {
    const result = await saveMessageTemplate(null, templateForm({ name: "Bad Name!" }));
    expect(result.error).toBe("messaging.invalidTemplateDetails");
    expect(mocks.state.inserts).toHaveLength(0);
  });

  it("rejects body placeholders that are not declared variables", async () => {
    const result = await saveMessageTemplate(
      null,
      templateForm({ body: "Hello {{unknown_var}}", variables: ["patient_name"] }),
    );
    expect(result.error).toBe("messaging.invalidTemplateDetails");
  });

  it("rejects variables outside the allowed §7.4 set", async () => {
    const result = await saveMessageTemplate(
      null,
      templateForm({ body: "Hello", variables: ["diagnosis"] }),
    );
    expect(result.error).toBe("messaging.invalidTemplateDetails");
  });

  it("rejects a body carrying Unicode bidi control characters (P3-L1)", async () => {
    const result = await saveMessageTemplate(
      null,
      templateForm({ body: "Hello ‮evil‬", variables: [] }),
    );
    expect(result.error).toBe("messaging.invalidTemplateDetails");
    expect(mocks.state.inserts).toHaveLength(0);
  });

  it("accepts a normal Arabic body (no false positive on RTL script)", async () => {
    const result = await saveMessageTemplate(null, templateForm());
    expect(result).toEqual({ success: true });
  });

  it("refuses to edit a submitted or approved template via the guarded write", async () => {
    // The conditional UPDATE matches nothing (locked); the existence probe
    // confirms the row is present, so the error is 'locked' not 'not found'.
    mocks.state.results["message_templates.update"] = { data: null, error: null };
    mocks.state.results.message_templates = { data: { id: templateId }, error: null };
    const result = await saveMessageTemplate(null, templateForm({ id: templateId }));
    expect(result.error).toBe("messaging.templateIsLocked");
    // The guard is the write itself, filtered on approval_status IN draft/rejected.
    const editUpdate = mocks.state.updates.find((u) => u.table === "message_templates");
    expect(JSON.stringify(editUpdate?.filters)).toContain("draft");
    expect(JSON.stringify(editUpdate?.filters)).toContain("rejected");
  });

  it("editing a draft/rejected template returns it to draft and detaches the provider id", async () => {
    mocks.state.results["message_templates.update"] = {
      data: { id: templateId },
      error: null,
    };
    const result = await saveMessageTemplate(null, templateForm({ id: templateId }));
    expect(result).toEqual({ success: true });
    expect(mocks.state.updates[0].payload).toMatchObject({
      approval_status: "draft",
      provider_template_id: null,
    });
  });

  it("reports not-found when the id matches no row at all", async () => {
    mocks.state.results["message_templates.update"] = { data: null, error: null };
    mocks.state.results.message_templates = { data: null, error: null };
    const result = await saveMessageTemplate(null, templateForm({ id: templateId }));
    expect(result.error).toBe("messaging.templateNotFound");
  });
});

describe("submitWhatsAppTemplate", () => {
  beforeEach(() => {
    mocks.decryptChannelCredentials.mockReturnValue({ apiKey: "k" });
  });

  it("claims the submission via a guarded transition and persists the provider id", async () => {
    mocks.state.results.clinic_channels = {
      data: { credentials_encrypted: "enc" },
      error: null,
    };
    // The claim UPDATE (draft/rejected → submitted) returns the claimed row.
    mocks.state.results["message_templates.update"] = {
      data: { id: templateId, name: "appointment_reminder", language: "ar", body: "hi" },
      error: null,
    };
    mocks.submitDialog360Template.mockResolvedValue({
      ok: true,
      providerTemplateId: "prov-1",
      status: "submitted",
    });
    const result = await submitWhatsAppTemplate(templateId, "UTILITY");
    expect(result).toMatchObject({ success: true, providerTemplateId: "prov-1" });
    // First update claims (→submitted), second persists the provider id.
    const claim = mocks.state.updates[0];
    expect(claim.payload).toMatchObject({ approval_status: "submitted" });
    expect(JSON.stringify(claim.filters)).toContain("draft");
  });

  it("refuses to resubmit a template not in draft/rejected (guarded claim)", async () => {
    mocks.state.results.clinic_channels = {
      data: { credentials_encrypted: "enc" },
      error: null,
    };
    mocks.state.results["message_templates.update"] = { data: null, error: null };
    const result = await submitWhatsAppTemplate(templateId, "UTILITY");
    expect(result.error).toBe("messaging.whatsAppTemplateOrChannelNotFound");
    expect(mocks.submitDialog360Template).not.toHaveBeenCalled();
  });

  it("reverts the claim to draft when the provider submission fails", async () => {
    mocks.state.results.clinic_channels = {
      data: { credentials_encrypted: "enc" },
      error: null,
    };
    mocks.state.results["message_templates.update"] = {
      data: { id: templateId, name: "appointment_reminder", language: "ar", body: "hi" },
      error: null,
    };
    mocks.submitDialog360Template.mockResolvedValue({ ok: false, error: "boom" });
    const result = await submitWhatsAppTemplate(templateId, "UTILITY");
    expect(result.error).toBe("messaging.couldNotSubmitWhatsAppTemplate");
    // Second update is the revert back to draft.
    const revert = mocks.state.updates[1];
    expect(revert.payload).toMatchObject({ approval_status: "draft", provider_template_id: null });
  });
});

describe("deleteMessageTemplate", () => {
  it("deletes a draft template with no provider registration", async () => {
    mocks.state.results.message_templates = {
      data: {
        id: templateId,
        name: "appointment_reminder",
        channel: "whatsapp",
        approval_status: "draft",
        provider_template_id: null,
      },
      error: null,
    };
    mocks.state.results["message_templates.delete"] = { data: { id: templateId }, error: null };
    const result = await deleteMessageTemplate(templateId);
    expect(result).toEqual({ success: true });
    expect(mocks.state.deletes).toHaveLength(1);
    expect(mocks.deleteDialog360Template).not.toHaveBeenCalled();
  });

  it("deletes the provider template first for an approved WhatsApp template", async () => {
    mocks.state.results.message_templates = {
      data: {
        id: templateId,
        name: "appointment_reminder",
        channel: "whatsapp",
        approval_status: "approved",
        provider_template_id: "prov-1",
      },
      error: null,
    };
    mocks.state.results.clinic_channels = {
      data: { credentials_encrypted: "enc" },
      error: null,
    };
    mocks.state.results["message_templates.delete"] = { data: { id: templateId }, error: null };
    mocks.decryptChannelCredentials.mockReturnValue({ apiKey: "k" });
    mocks.deleteDialog360Template.mockResolvedValue({ ok: true });
    const result = await deleteMessageTemplate(templateId);
    expect(result).toEqual({ success: true });
    expect(mocks.deleteDialog360Template).toHaveBeenCalledWith("appointment_reminder", { apiKey: "k" });
  });

  it("does not delete locally when the provider deletion fails", async () => {
    mocks.state.results.message_templates = {
      data: {
        id: templateId,
        name: "appointment_reminder",
        channel: "whatsapp",
        approval_status: "approved",
        provider_template_id: "prov-1",
      },
      error: null,
    };
    mocks.state.results.clinic_channels = {
      data: { credentials_encrypted: "enc" },
      error: null,
    };
    mocks.decryptChannelCredentials.mockReturnValue({ apiKey: "k" });
    mocks.deleteDialog360Template.mockResolvedValue({ ok: false, error: "boom" });
    const result = await deleteMessageTemplate(templateId);
    expect(result.error).toBe("messaging.couldNotDeleteTemplate");
    expect(mocks.state.deletes).toHaveLength(0);
  });

  it("refuses to delete a template while it is under review", async () => {
    mocks.state.results.message_templates = {
      data: {
        id: templateId,
        name: "appointment_reminder",
        channel: "whatsapp",
        approval_status: "submitted",
        provider_template_id: null,
      },
      error: null,
    };
    const result = await deleteMessageTemplate(templateId);
    expect(result.error).toBe("messaging.templateCannotBeDeletedWhileSubmitted");
    expect(mocks.state.deletes).toHaveLength(0);
  });
});
