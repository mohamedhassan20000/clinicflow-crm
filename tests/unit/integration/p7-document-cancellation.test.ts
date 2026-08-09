import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
type Client = SupabaseClient<Database>;

const suffix = `p7-cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P7CancelDocument12345!";
const clinicId = randomUUID();
let admin: Client;
let adminId = "";

async function cleanup() {
  await service.from("document_events").delete().eq("clinic_id", clinicId);
  await service.from("documents").delete().eq("clinic_id", clinicId);
  await service.from("document_counters").delete().eq("clinic_id", clinicId);
  await service.from("activity_events").delete().eq("clinic_id", clinicId);
  await service.from("profiles").delete().eq("clinic_id", clinicId);
  await service.from("clinics").delete().eq("id", clinicId);
}

beforeAll(async () => {
  const email = `${suffix}@example.com`;
  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw created.error ?? new Error("User creation returned no user");
  }
  adminId = created.data.user.id;

  await cleanup();
  const clinic = await service.from("clinics").insert({
    id: clinicId,
    name: `P7 Cancel Clinic ${suffix}`,
  });
  if (clinic.error) throw clinic.error;
  const profile = await service.from("profiles").insert({
    id: adminId,
    clinic_id: clinicId,
    full_name: "P7 Cancel Admin",
    role: "admin",
  });
  if (profile.error) throw profile.error;

  admin = createClient<Database>(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const login = await admin.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  if (adminId) await service.auth.admin.deleteUser(adminId);
});

describe("P7 issued document cancellation RPC", () => {
  it("transitions Issued → Cancelled atomically while preserving the issued artifact", async () => {
    const reserved = await service.rpc("reserve_document_issue", {
      p_clinic_id: clinicId,
      p_actor_id: adminId,
      p_doc_type: "PRESCRIPTION",
      p_idempotency_key: `${suffix}:issued-document`,
      p_locale: "en",
      p_numbering_prefix: "RX",
      p_period_key: "2026",
      p_sequence_padding: 4,
      p_params: { recordId: randomUUID() },
      p_snapshot: { patientName: "Immutable Patient", medication: "Immutable Rx" },
      p_watermark_snapshot: "Clinic Copy",
    });
    if (reserved.error) throw reserved.error;
    const documentId = reserved.data[0].document_id;
    const storagePath = `documents/${clinicId}/PRESCRIPTION/${documentId}.pdf`;

    const completed = await service.rpc("complete_document_issue", {
      p_clinic_id: clinicId,
      p_actor_id: adminId,
      p_document_id: documentId,
      p_pdf_storage_path: storagePath,
      p_page_count: 2,
    });
    if (completed.error) throw completed.error;

    const before = await service
      .from("documents")
      .select(
        "document_number, snapshot, pdf_storage_path, verification_token, issued_at, status",
      )
      .eq("id", documentId)
      .single();
    if (before.error) throw before.error;
    expect(before.data.status).toBe("issued");

    const cancelled = await admin.rpc("cancel_issued_document", {
      p_document_id: documentId,
    });
    if (cancelled.error) throw cancelled.error;
    expect(cancelled.data).toEqual([
      expect.objectContaining({
        document_id: documentId,
        document_status: "cancelled",
        cancelled_at: expect.any(String),
      }),
    ]);

    const after = await service
      .from("documents")
      .select(
        "document_number, snapshot, pdf_storage_path, verification_token, issued_at, status, voided_by, voided_at",
      )
      .eq("id", documentId)
      .single();
    if (after.error) throw after.error;
    expect(after.data).toMatchObject({
      document_number: before.data.document_number,
      snapshot: before.data.snapshot,
      pdf_storage_path: before.data.pdf_storage_path,
      verification_token: before.data.verification_token,
      issued_at: before.data.issued_at,
      status: "cancelled",
      voided_by: adminId,
      voided_at: expect.any(String),
    });

    const verification = await service.rpc("verify_document_token", {
      p_token: before.data.verification_token,
    });
    if (verification.error) throw verification.error;
    expect(verification.data).toEqual([
      expect.objectContaining({
        verification_status: "cancelled",
        document_number: before.data.document_number,
      }),
    ]);

    const history = await admin
      .from("document_events")
      .select("event, actor_id, metadata")
      .eq("document_id", documentId)
      .order("occurred_at");
    if (history.error) throw history.error;
    expect(history.data.map((event) => event.event)).toEqual([
      "issued",
      "cancelled",
    ]);
    expect(history.data[1]).toMatchObject({
      actor_id: adminId,
      metadata: { previous_status: "issued" },
    });

    const audit = await service
      .from("activity_events")
      .select("action, actor_id, previous_state, new_state")
      .eq("entity_id", documentId)
      .eq("action", "document.cancelled")
      .single();
    if (audit.error) throw audit.error;
    expect(audit.data).toMatchObject({
      action: "document.cancelled",
      actor_id: adminId,
      previous_state: { status: "issued" },
      new_state: { status: "cancelled" },
    });

    // Cancelled rows remain readable, and retrying the RPC is idempotent.
    const visible = await admin
      .from("documents")
      .select("id, status")
      .eq("id", documentId)
      .single();
    if (visible.error) throw visible.error;
    expect(visible.data).toEqual({ id: documentId, status: "cancelled" });
    const retry = await admin.rpc("cancel_issued_document", {
      p_document_id: documentId,
    });
    if (retry.error) throw retry.error;
    expect(retry.data[0]).toMatchObject({
      document_id: documentId,
      document_status: "cancelled",
    });
    const cancellationEvents = await service
      .from("document_events")
      .select("id", { count: "exact" })
      .eq("document_id", documentId)
      .eq("event", "cancelled");
    if (cancellationEvents.error) throw cancellationEvents.error;
    expect(cancellationEvents.count).toBe(1);
  });
});
