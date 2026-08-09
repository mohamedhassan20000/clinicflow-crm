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

const suffix = `p70-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P70Document12345!";
const clinicA = randomUUID();
const clinicB = randomUUID();
const userIds: string[] = [];
const storagePaths: string[] = [];
let adminA: Client;
let adminB: Client;
let managerA: Client;
let adminAId = "";

function anonClient(): Client {
  return createClient<Database>(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createUser(label: string) {
  const email = `${suffix}-${label}@example.com`;
  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw created.error ?? new Error("User creation returned no user");
  }
  userIds.push(created.data.user.id);
  const client = anonClient();
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { id: created.data.user.id, client };
}

async function cleanup() {
  if (storagePaths.length > 0) {
    await service.storage.from("clinic-documents").remove(storagePaths);
    storagePaths.length = 0;
  }
  await service.from("document_events").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("documents").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("document_settings").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("document_counters").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("activity_events").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("profiles").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("clinics").delete().in("id", [clinicA, clinicB]);
}

function reserveArgs(idempotencyKey: string) {
  return {
    p_clinic_id: clinicA,
    p_actor_id: adminAId,
    p_doc_type: "REVENUE_REPORT",
    p_idempotency_key: idempotencyKey,
    p_locale: "en",
    p_numbering_prefix: "REV",
    p_period_key: "2026",
    p_sequence_padding: 4,
    p_params: { from: "2026-01-01", to: "2026-12-31" },
    p_snapshot: { total: 100 },
    p_watermark_snapshot: null,
  };
}

beforeAll(async () => {
  const [a, b, manager] = await Promise.all([
    createUser("admin-a"),
    createUser("admin-b"),
    createUser("manager-a"),
  ]);
  adminA = a.client;
  adminB = b.client;
  managerA = manager.client;
  adminAId = a.id;

  await cleanup();
  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `P70 Clinic A ${suffix}` },
    { id: clinicB, name: `P70 Clinic B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;
  const profiles = await service.from("profiles").insert([
    { id: a.id, clinic_id: clinicA, full_name: "P70 Admin A", role: "admin" },
    { id: b.id, clinic_id: clinicB, full_name: "P70 Admin B", role: "admin" },
    { id: manager.id, clinic_id: clinicA, full_name: "P70 Manager A", role: "manager" },
  ]);
  if (profiles.error) throw profiles.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

describe("P7-0 document foundations", () => {
  it("allocates one number for concurrent duplicate issuance", async () => {
    const key = `${suffix}:concurrent`;
    const [first, second] = await Promise.all([
      service.rpc("reserve_document_issue", reserveArgs(key)),
      service.rpc("reserve_document_issue", reserveArgs(key)),
    ]);
    if (first.error) throw first.error;
    if (second.error) throw second.error;

    expect(first.data).toHaveLength(1);
    expect(second.data).toHaveLength(1);
    expect(first.data[0].document_id).toBe(second.data[0].document_id);
    expect(first.data[0].document_number).toBe(second.data[0].document_number);
    expect([first.data[0].reused, second.data[0].reused].sort()).toEqual([false, true]);

    const counter = await service
      .from("document_counters")
      .select("next_seq")
      .eq("clinic_id", clinicA)
      .eq("doc_type", "REVENUE_REPORT")
      .eq("period_key", "2026")
      .single();
    if (counter.error) throw counter.error;
    expect(counter.data.next_seq).toBe(2);
  });

  it("keeps a failed reservation hidden and retries its immutable number", async () => {
    const key = `${suffix}:render-failure`;
    const reserved = await service.rpc("reserve_document_issue", reserveArgs(key));
    if (reserved.error) throw reserved.error;
    const row = reserved.data[0];

    const failed = await service.rpc("fail_document_issue", {
      p_clinic_id: clinicA,
      p_actor_id: adminAId,
      p_document_id: row.document_id,
      p_failure_code: "DOCUMENT_RENDER_FAILED",
    });
    if (failed.error) throw failed.error;
    expect(failed.data).toBe(true);

    const hidden = await adminA
      .from("documents")
      .select("id")
      .eq("id", row.document_id);
    if (hidden.error) throw hidden.error;
    expect(hidden.data).toEqual([]);

    const retry = await service.rpc("reserve_document_issue", reserveArgs(key));
    if (retry.error) throw retry.error;
    expect(retry.data[0]).toMatchObject({
      document_id: row.document_id,
      document_number: row.document_number,
      issue_status: "failed",
      reused: true,
    });

    const storagePath = `documents/${clinicA}/REVENUE_REPORT/${row.document_id}.pdf`;
    const completed = await service.rpc("complete_document_issue", {
      p_clinic_id: clinicA,
      p_actor_id: adminAId,
      p_document_id: row.document_id,
      p_pdf_storage_path: storagePath,
      p_page_count: 1,
    });
    if (completed.error) throw completed.error;
    expect(completed.data[0].issue_status).toBe("issued");

    const own = await adminA
      .from("documents")
      .select("id, document_number, status, pdf_storage_path")
      .eq("id", row.document_id)
      .single();
    if (own.error) throw own.error;
    expect(own.data).toMatchObject({
      id: row.document_id,
      document_number: row.document_number,
      status: "issued",
      pdf_storage_path: storagePath,
    });

    const foreign = await adminB.from("documents").select("id").eq("id", row.document_id);
    if (foreign.error) throw foreign.error;
    expect(foreign.data).toEqual([]);

    const events = await adminA
      .from("document_events")
      .select("event")
      .eq("document_id", row.document_id)
      .order("occurred_at");
    if (events.error) throw events.error;
    expect(events.data.map((event) => event.event)).toEqual([
      "issuance_failed",
      "issued",
    ]);
  });

  it("allows only own-clinic reads of an issued canonical PDF", async () => {
    const reserved = await service.rpc(
      "reserve_document_issue",
      reserveArgs(`${suffix}:storage-read`),
    );
    if (reserved.error) throw reserved.error;
    const row = reserved.data[0];
    const storagePath =
      `documents/${clinicA}/REVENUE_REPORT/${row.document_id}.pdf`;
    storagePaths.push(storagePath);

    const uploaded = await service.storage
      .from("clinic-documents")
      .upload(storagePath, new TextEncoder().encode("%PDF-1.4\n%%EOF\n"), {
        contentType: "application/pdf",
      });
    if (uploaded.error) throw uploaded.error;

    const incompleteRead = await adminA.storage
      .from("clinic-documents")
      .download(storagePath);
    expect(incompleteRead.error).not.toBeNull();

    const completed = await service.rpc("complete_document_issue", {
      p_clinic_id: clinicA,
      p_actor_id: adminAId,
      p_document_id: row.document_id,
      p_pdf_storage_path: storagePath,
      p_page_count: 1,
    });
    if (completed.error) throw completed.error;
    expect(completed.data[0].reused).toBe(false);

    const [ownRead, crossClinicRead] = await Promise.all([
      adminA.storage.from("clinic-documents").download(storagePath),
      adminB.storage.from("clinic-documents").download(storagePath),
    ]);
    expect(ownRead.error).toBeNull();
    expect(ownRead.data).not.toBeNull();
    expect(crossClinicRead.error).not.toBeNull();

    const repeatedCompletion = await service.rpc("complete_document_issue", {
      p_clinic_id: clinicA,
      p_actor_id: adminAId,
      p_document_id: row.document_id,
      p_pdf_storage_path: storagePath,
      p_page_count: 1,
    });
    if (repeatedCompletion.error) throw repeatedCompletion.error;
    expect(repeatedCompletion.data[0].reused).toBe(true);
  });

  it("protects document branding from manager and cross-tenant writes", async () => {
    const managerWrite = await managerA
      .from("clinics")
      .update({ tax_id: "FORGED-TAX-ID" })
      .eq("id", clinicA);
    expect(managerWrite.error).not.toBeNull();

    const crossTenant = await adminB
      .from("clinics")
      .update({ license_no: "FORGED-LICENSE" })
      .eq("id", clinicA);
    expect(crossTenant.error).toBeNull();
    const clinic = await service
      .from("clinics")
      .select("tax_id, license_no")
      .eq("id", clinicA)
      .single();
    if (clinic.error) throw clinic.error;
    expect(clinic.data).toEqual({ tax_id: null, license_no: null });
  });
});
