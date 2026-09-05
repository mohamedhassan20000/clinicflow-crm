import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

/**
 * P11Q — the tenant and privilege boundaries around bulk send, proved against a
 * real database.
 *
 * Migration-text assertions can show that a policy was *written*. Only Postgres
 * can show that it *holds*. Everything here runs as a genuinely authenticated
 * clinic-A staff member against rows that belong to clinic B, and as that same
 * staff member attempting writes the design says only the service role may make.
 */

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = `p11q-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clinicA = randomUUID();
const clinicB = randomUUID();
const staffA = randomUUID();
const jobA = randomUUID();
const jobB = randomUUID();
const conversationA = randomUUID();
const conversationB = randomUUID();
const recipientA = randomUUID();
const recipientB = randomUUID();
const email = `${suffix}-admin@example.com`;
const password = "P11QIntegration123!";

/** A client carrying a real clinic-A staff session — not the service role. */
let staffClient: ReturnType<typeof createClient<Database>>;

async function cleanup() {
  const clinics = [clinicA, clinicB];
  await service.from("bulk_message_recipients").delete().in("clinic_id", clinics);
  await service.from("bulk_message_jobs").delete().in("clinic_id", clinics);
  await service.from("conversations").delete().in("clinic_id", clinics);
  await service.from("profiles").delete().in("clinic_id", clinics);
  await service.auth.admin.deleteUser(staffA).catch(() => undefined);
  await service.from("clinics").delete().in("id", clinics);
}

beforeAll(async () => {
  await cleanup();
  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `P11Q Clinic A ${suffix}`, country: "EG" },
    { id: clinicB, name: `P11Q Clinic B ${suffix}`, country: "EG" },
  ]);
  if (clinics.error) throw clinics.error;

  const authUser = await service.auth.admin.createUser({
    id: staffA,
    email,
    password,
    email_confirm: true,
  });
  if (authUser.error) throw authUser.error;
  const profile = await service.from("profiles").insert({
    id: staffA,
    clinic_id: clinicA,
    full_name: "P11Q Clinic Admin",
    role: "admin",
    must_change_password: false,
  });
  if (profile.error) throw profile.error;

  const conversations = await service.from("conversations").insert([
    { id: conversationA, clinic_id: clinicA, channel: "whatsapp", participant_address: `+2010${suffix.slice(-8)}` },
    { id: conversationB, clinic_id: clinicB, channel: "whatsapp", participant_address: `+2011${suffix.slice(-8)}` },
  ]);
  if (conversations.error) throw conversations.error;

  // Service role creates both clinics' jobs — which is itself the assertion
  // that the intended writer can write.
  const jobs = await service.from("bulk_message_jobs").insert([
    { id: jobA, clinic_id: clinicA, created_by: staffA, body: "Clinic A notice", total_recipients: 1 },
    { id: jobB, clinic_id: clinicB, created_by: staffA, body: "Clinic B notice", total_recipients: 1 },
  ]);
  // Clinic B's job intentionally reuses staffA as created_by only if the
  // composite FK allows it; if it does not, that is itself correct behaviour.
  if (jobs.error) {
    const jobAOnly = await service.from("bulk_message_jobs").insert([
      { id: jobA, clinic_id: clinicA, created_by: staffA, body: "Clinic A notice", total_recipients: 1 },
    ]);
    if (jobAOnly.error) throw jobAOnly.error;
    const staffB = randomUUID();
    await service.auth.admin.createUser({
      id: staffB,
      email: `${suffix}-b@example.com`,
      password,
      email_confirm: true,
    });
    await service.from("profiles").insert({
      id: staffB,
      clinic_id: clinicB,
      full_name: "P11Q Clinic B Admin",
      role: "admin",
      must_change_password: false,
    });
    const jobBOnly = await service.from("bulk_message_jobs").insert([
      { id: jobB, clinic_id: clinicB, created_by: staffB, body: "Clinic B notice", total_recipients: 1 },
    ]);
    if (jobBOnly.error) throw jobBOnly.error;
  }

  const recipients = await service.from("bulk_message_recipients").insert([
    { id: recipientA, clinic_id: clinicA, job_id: jobA, conversation_id: conversationA, status: "pending" },
    { id: recipientB, clinic_id: clinicB, job_id: jobB, conversation_id: conversationB, status: "pending" },
  ]);
  if (recipients.error) throw recipients.error;

  staffClient = createClient<Database>(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const session = await staffClient.auth.signInWithPassword({ email, password });
  if (session.error) throw session.error;
});

afterAll(cleanup);

describe("P11Q — tenant isolation", () => {
  it("lets clinic A staff read their own job", async () => {
    const result = await staffClient.from("bulk_message_jobs").select("id").eq("id", jobA);
    expect(result.error).toBeNull();
    expect(result.data?.map((row) => row.id)).toEqual([jobA]);
  });

  /** The one that matters: another clinic's job is not readable, at all. */
  it("does not let clinic A staff read clinic B's job", async () => {
    const result = await staffClient.from("bulk_message_jobs").select("id").eq("id", jobB);
    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
  });

  it("does not let clinic A staff read clinic B's recipients", async () => {
    const result = await staffClient
      .from("bulk_message_recipients")
      .select("id")
      .eq("id", recipientB);
    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
  });

  it("returns only clinic A rows on an unfiltered read", async () => {
    const jobs = await staffClient.from("bulk_message_jobs").select("id, clinic_id");
    expect(jobs.error).toBeNull();
    expect(jobs.data!.every((row) => row.clinic_id === clinicA)).toBe(true);
    const recipients = await staffClient.from("bulk_message_recipients").select("id, clinic_id");
    expect(recipients.error).toBeNull();
    expect(recipients.data!.every((row) => row.clinic_id === clinicA)).toBe(true);
  });
});

describe("P11Q — writes are service-role only", () => {
  it("refuses an authenticated insert of a job", async () => {
    const result = await staffClient.from("bulk_message_jobs").insert({
      clinic_id: clinicA,
      created_by: staffA,
      body: "Should not be insertable by a browser session",
      total_recipients: 1,
    });
    expect(result.error).not.toBeNull();
  });

  it("refuses an authenticated insert of a recipient", async () => {
    const result = await staffClient.from("bulk_message_recipients").insert({
      clinic_id: clinicA,
      job_id: jobA,
      conversation_id: conversationA,
      status: "pending",
    });
    expect(result.error).not.toBeNull();
  });

  /**
   * The most valuable negative: a staff session must not be able to walk a
   * recipient to 'sent' (or anywhere else) directly, because the status is the
   * record of what was actually sent to a patient.
   */
  it("cannot update a recipient's status directly", async () => {
    const result = await staffClient
      .from("bulk_message_recipients")
      .update({ status: "sent" })
      .eq("id", recipientA)
      .select("id");
    // Either an outright error, or an update that silently affects no rows.
    if (!result.error) expect(result.data ?? []).toEqual([]);
    const after = await service
      .from("bulk_message_recipients")
      .select("status")
      .eq("id", recipientA)
      .single();
    expect(after.data!.status).toBe("pending");
  });

  it("cannot delete a job", async () => {
    const result = await staffClient.from("bulk_message_jobs").delete().eq("id", jobA).select("id");
    if (!result.error) expect(result.data ?? []).toEqual([]);
    const after = await service.from("bulk_message_jobs").select("id").eq("id", jobA);
    expect(after.data).toHaveLength(1);
  });
});

describe("P11Q — the claim and recovery functions are service-role only", () => {
  it("refuses claim_bulk_message_recipient from an authenticated session", async () => {
    const result = await staffClient.rpc("claim_bulk_message_recipient", {
      p_clinic_id: clinicA,
      p_recipient_id: recipientA,
    });
    expect(result.error).not.toBeNull();
    const after = await service
      .from("bulk_message_recipients")
      .select("status")
      .eq("id", recipientA)
      .single();
    expect(after.data!.status).toBe("pending");
  });

  it("refuses flag_stalled_bulk_recipients from an authenticated session", async () => {
    const result = await staffClient.rpc("flag_stalled_bulk_recipients", {
      p_clinic_id: clinicA,
      p_job_id: jobA,
      p_stale_seconds: 300,
    });
    expect(result.error).not.toBeNull();
  });

  it("refuses release_bulk_recipient_for_retry from an authenticated session", async () => {
    const result = await staffClient.rpc("release_bulk_recipient_for_retry", {
      p_clinic_id: clinicA,
      p_recipient_id: recipientA,
    });
    expect(result.error).not.toBeNull();
  });

  it("allows the service role to claim, and only once", async () => {
    const first = await service.rpc("claim_bulk_message_recipient", {
      p_clinic_id: clinicA,
      p_recipient_id: recipientA,
    });
    expect(first.error).toBeNull();
    expect(first.data).toHaveLength(1);

    // Second claim finds the row in 'sending' and yields nothing. This is the
    // database itself enforcing no-double-send.
    const second = await service.rpc("claim_bulk_message_recipient", {
      p_clinic_id: clinicA,
      p_recipient_id: recipientA,
    });
    expect(second.error).toBeNull();
    expect(second.data).toHaveLength(0);
  });

  it("refuses a cross-tenant claim even for the service role", async () => {
    const result = await service.rpc("claim_bulk_message_recipient", {
      p_clinic_id: clinicA,
      p_recipient_id: recipientB,
    });
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(0);
  });
});

describe("P11Q.1 — interruption recovery against the real schema", () => {
  it("does not flag a send that has only just been claimed", async () => {
    // recipientA is in 'sending' from the claim above, claimed seconds ago.
    const result = await service.rpc("flag_stalled_bulk_recipients", {
      p_clinic_id: clinicA,
      p_job_id: jobA,
      p_stale_seconds: 300,
    });
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(0);
  });

  it("enforces a staleness floor, so a caller cannot flag live sends", async () => {
    // Even asking for zero seconds must not touch a fresh claim: the function
    // clamps to its own minimum.
    const result = await service.rpc("flag_stalled_bulk_recipients", {
      p_clinic_id: clinicA,
      p_job_id: jobA,
      p_stale_seconds: 0,
    });
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(0);
  });

  it("flags a genuinely stale claim and makes it unclaimable", async () => {
    await service
      .from("bulk_message_recipients")
      .update({ claimed_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
      .eq("id", recipientA);

    const flagged = await service.rpc("flag_stalled_bulk_recipients", {
      p_clinic_id: clinicA,
      p_job_id: jobA,
      p_stale_seconds: 300,
    });
    expect(flagged.error).toBeNull();
    expect(flagged.data).toHaveLength(1);

    const row = await service
      .from("bulk_message_recipients")
      .select("status, failure_code")
      .eq("id", recipientA)
      .single();
    expect(row.data!.status).toBe("review");
    expect(row.data!.failure_code).toBe("interrupted");

    // An ordinary run must not pick it back up: only an explicit decision can.
    const claim = await service.rpc("claim_bulk_message_recipient", {
      p_clinic_id: clinicA,
      p_recipient_id: recipientA,
    });
    expect(claim.data).toHaveLength(0);
  });

  it("releases a reviewed recipient back to pending, exactly once", async () => {
    const released = await service.rpc("release_bulk_recipient_for_retry", {
      p_clinic_id: clinicA,
      p_recipient_id: recipientA,
    });
    expect(released.error).toBeNull();
    expect(released.data).toHaveLength(1);

    // A second release finds nothing in review — two staff racing cannot both
    // send.
    const again = await service.rpc("release_bulk_recipient_for_retry", {
      p_clinic_id: clinicA,
      p_recipient_id: recipientA,
    });
    expect(again.data).toHaveLength(0);

    const claim = await service.rpc("claim_bulk_message_recipient", {
      p_clinic_id: clinicA,
      p_recipient_id: recipientA,
    });
    expect(claim.data).toHaveLength(1);
  });
});

describe("P11Q — schema guarantees", () => {
  it("refuses a duplicate recipient for the same job", async () => {
    const result = await service.from("bulk_message_recipients").insert({
      clinic_id: clinicA,
      job_id: jobA,
      conversation_id: conversationA,
      status: "pending",
    });
    expect(result.error).not.toBeNull();
  });

  it("refuses a sent recipient with no outbound message", async () => {
    const result = await service
      .from("bulk_message_recipients")
      .update({ status: "sent", outbound_message_id: null })
      .eq("id", recipientA)
      .select("id");
    expect(result.error).not.toBeNull();
  });

  it("refuses a skipped or review recipient with no reason", async () => {
    const skipped = await service
      .from("bulk_message_recipients")
      .update({ status: "skipped", failure_code: null })
      .eq("id", recipientA)
      .select("id");
    expect(skipped.error).not.toBeNull();
    const review = await service
      .from("bulk_message_recipients")
      .update({ status: "review", failure_code: null })
      .eq("id", recipientA)
      .select("id");
    expect(review.error).not.toBeNull();
  });
});
