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
const anon = createClient<Database>(url, publishableKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = `p73-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clinicId = randomUUID();
const password = "P73Document12345!";
let userId = "";
let admin: SupabaseClient<Database>;
let documentId = "";
let documentNumber = "";
let verificationToken = "";

async function cleanup() {
  await service.from("document_events").delete().eq("clinic_id", clinicId);
  await service.from("documents").delete().eq("clinic_id", clinicId);
  await service.from("document_counters").delete().eq("clinic_id", clinicId);
  await service.from("profiles").delete().eq("clinic_id", clinicId);
  await service.from("clinics").delete().eq("id", clinicId);
}

beforeAll(async () => {
  const created = await service.auth.admin.createUser({
    email: `${suffix}@example.com`,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) throw created.error ?? new Error("User was not created");
  userId = created.data.user.id;
  const loginClient = createClient<Database>(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signedIn = await loginClient.auth.signInWithPassword({
    email: `${suffix}@example.com`,
    password,
  });
  if (signedIn.error) throw signedIn.error;
  admin = createClient<Database>(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await admin.auth.setSession({
    access_token: signedIn.data.session!.access_token,
    refresh_token: signedIn.data.session!.refresh_token,
  });

  await cleanup();
  const clinic = await service.from("clinics").insert({
    id: clinicId,
    name: `P73 Clinic ${suffix}`,
  });
  if (clinic.error) throw clinic.error;
  const profile = await service.from("profiles").insert({
    id: userId,
    clinic_id: clinicId,
    full_name: "P73 Admin",
    role: "admin",
  });
  if (profile.error) throw profile.error;

  const reserved = await service.rpc("reserve_document_issue", {
    p_clinic_id: clinicId,
    p_actor_id: userId,
    p_doc_type: "REVENUE_REPORT",
    p_idempotency_key: `${suffix}:issued`,
    p_locale: "en",
    p_numbering_prefix: "REV",
    p_period_key: "2026",
    p_sequence_padding: 4,
    p_params: { from: "2026-07-01", to: "2026-07-31" },
    p_snapshot: { version: 1, grossTotal: 100 },
    p_watermark_snapshot: null,
  });
  if (reserved.error) throw reserved.error;
  const row = reserved.data[0];
  documentId = row.document_id;
  documentNumber = row.document_number;
  verificationToken = row.verification_token;
  const completed = await service.rpc("complete_document_issue", {
    p_clinic_id: clinicId,
    p_actor_id: userId,
    p_document_id: documentId,
    p_pdf_storage_path: `documents/${clinicId}/REVENUE_REPORT/${documentId}.pdf`,
    p_page_count: 1,
  });
  if (completed.error) throw completed.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  if (userId) await service.auth.admin.deleteUser(userId);
});

describe("P7-3 Revenue Report database lifecycle", () => {
  it("verifies by opaque token with exactly the approved public projection", async () => {
    const result = await anon.rpc("verify_document_token", { p_token: verificationToken });
    if (result.error) throw result.error;
    expect(result.data).toEqual([{
      verification_status: "valid",
      document_number: documentNumber,
      document_type: "REVENUE_REPORT",
      issue_date: expect.any(String),
      clinic_name: `P73 Clinic ${suffix}`,
    }]);

    const miss = await anon.rpc("verify_document_token", {
      p_token: "00000000000000000000000000000000",
    });
    if (miss.error) throw miss.error;
    expect(miss.data).toEqual([]);
  });

  it("reprints the immutable canonical path and appends history", async () => {
    const result = await admin.rpc("record_revenue_document_reprint", {
      p_document_id: documentId,
    });
    if (result.error) throw result.error;
    expect(result.data[0]).toEqual({
      pdf_storage_path: `documents/${clinicId}/REVENUE_REPORT/${documentId}.pdf`,
      document_number: documentNumber,
      print_count: 1,
    });

    const [document, events] = await Promise.all([
      service.from("documents").select("print_count, snapshot").eq("id", documentId).single(),
      service.from("document_events").select("event").eq("document_id", documentId).order("occurred_at"),
    ]);
    if (document.error) throw document.error;
    if (events.error) throw events.error;
    expect(document.data.print_count).toBe(1);
    expect(document.data.snapshot).toEqual({ version: 1, grossTotal: 100 });
    expect(events.data.map((event) => event.event)).toEqual(["issued", "reprinted"]);
  });
});
