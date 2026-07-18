import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

// P3D suite: notifications are recipient-private (same clinic is not enough),
// followup_sequences is server-code-only, the reminder claim RPC is
// idempotent and service-role-only, and the new clinics/appointments columns
// carry their documented defaults and constraints.

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `p3d-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P3dTest12345";
const clinicA = randomUUID();
const clinicB = randomUUID();
const clinicC = randomUUID();
const patientA = randomUUID();
const patientC = randomUUID();
const appointmentA = randomUUID();
const eligibleAppointmentC = randomUUID();
const notificationForAdminA = randomUUID();
const notificationForReceptionistA = randomUUID();
const notificationForAdminB = randomUUID();
const sequenceA = randomUUID();

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userIds: string[] = [];
let adminA: Client;
let adminAId: string;
let receptionistA: Client;
let adminB: Client;
let anon: Client;
let doctorCId: string;

function client() {
  return createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `p3d-${Math.random().toString(36).slice(2)}`,
    },
  });
}

async function createUser(label: string) {
  const email = `${suffix}-${label}@example.com`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(error?.message ?? `create ${label}`);
  userIds.push(data.user.id);
  const signedIn = client();
  const login = await signedIn.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { id: data.user.id, client: signedIn };
}

const allClinics = [clinicA, clinicB, clinicC];

async function cleanup() {
  await service.from("notifications").delete().in("clinic_id", allClinics);
  await service.from("message_dispatches").delete().in("clinic_id", allClinics);
  await service.from("followup_sequences").delete().in("clinic_id", allClinics);
  await service.from("appointments").delete().in("clinic_id", allClinics);
  await service.from("patients").delete().in("clinic_id", allClinics);
  await service.from("profiles").delete().in("id", userIds);
  await service.from("clinics").delete().in("id", allClinics);
  for (const id of userIds) {
    await service.auth.admin.deleteUser(id);
  }
}

beforeAll(async () => {
  const [a, receptionist, b, doctor, doctorC] = await Promise.all([
    createUser("admin-a"),
    createUser("receptionist-a"),
    createUser("admin-b"),
    createUser("doctor-a"),
    createUser("doctor-c"),
  ]);
  adminA = a.client;
  adminAId = a.id;
  receptionistA = receptionist.client;
  adminB = b.client;
  anon = client();
  doctorCId = doctorC.id;

  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `P3D Clinic A ${suffix}` },
    { id: clinicB, name: `P3D Clinic B ${suffix}` },
    { id: clinicC, name: `P3D Clinic C ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;
  const profiles = await service.from("profiles").insert([
    { id: a.id, clinic_id: clinicA, full_name: "Admin A", role: "admin" },
    { id: receptionist.id, clinic_id: clinicA, full_name: "Receptionist A", role: "receptionist" },
    { id: b.id, clinic_id: clinicB, full_name: "Admin B", role: "admin" },
    { id: doctor.id, clinic_id: clinicA, full_name: "Doctor A", role: "doctor" },
    { id: doctorC.id, clinic_id: clinicC, full_name: "Doctor C", role: "doctor" },
  ]);
  if (profiles.error) throw profiles.error;

  const patientCRow = await service.from("patients").insert({
    id: patientC,
    clinic_id: clinicC,
    full_name: "Patient C",
    phone: "+96550000009",
    email: `${suffix}-patient-c@example.com`,
    date_of_birth: "1990-01-01",
    national_id: `nid-c-${suffix}`,
    file_number: `f-c-${suffix}`,
    created_by: doctorC.id,
  });
  if (patientCRow.error) throw patientCRow.error;

  const patient = await service.from("patients").insert({
    id: patientA,
    clinic_id: clinicA,
    full_name: "Patient A",
    phone: "+96550000001",
    email: `${suffix}-patient@example.com`,
    date_of_birth: "1990-01-01",
    national_id: `nid-${suffix}`,
    file_number: `f-${suffix}`,
    created_by: a.id,
  });
  if (patient.error) throw patient.error;

  const appointment = await service.from("appointments").insert({
    id: appointmentA,
    clinic_id: clinicA,
    patient_id: patientA,
    doctor_id: doctor.id,
    created_by: a.id,
    scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
    status: "confirmed",
  });
  if (appointment.error) throw appointment.error;

  const notifications = await service.from("notifications").insert([
    {
      id: notificationForAdminA,
      clinic_id: clinicA,
      recipient_id: a.id,
      type: "inbox_message",
      link: "/inbox",
    },
    {
      id: notificationForReceptionistA,
      clinic_id: clinicA,
      recipient_id: receptionist.id,
      type: "inbox_message",
      link: "/inbox",
    },
    {
      id: notificationForAdminB,
      clinic_id: clinicB,
      recipient_id: b.id,
      type: "reminder_failed",
      link: "/appointments",
    },
  ]);
  if (notifications.error) throw notifications.error;

  const sequence = await service.from("followup_sequences").insert({
    id: sequenceA,
    clinic_id: clinicA,
    appointment_id: appointmentA,
    next_run_at: new Date().toISOString(),
  });
  if (sequence.error) throw sequence.error;
}, 120_000);

afterAll(async () => {
  await cleanup();
});

describe("notifications RLS", () => {
  it("recipients read exactly their own rows — same clinic is not enough", async () => {
    const own = await adminA.from("notifications").select("id");
    expect(own.error).toBeNull();
    expect(own.data?.map((row) => row.id)).toEqual([notificationForAdminA]);

    const colleague = await receptionistA.from("notifications").select("id");
    expect(colleague.data?.map((row) => row.id)).toEqual([notificationForReceptionistA]);
  });

  it("denies cross-clinic reads", async () => {
    const rows = await adminB
      .from("notifications")
      .select("id")
      .eq("clinic_id", clinicA);
    expect(rows.error).toBeNull();
    expect(rows.data).toHaveLength(0);
  });

  it("denies anonymous reads", async () => {
    const rows = await anon.from("notifications").select("id");
    expect(rows.data ?? []).toHaveLength(0);
  });

  it("denies authenticated writes, including mark-as-read on own rows", async () => {
    const insert = await adminA.from("notifications").insert({
      clinic_id: clinicA,
      recipient_id: adminAId,
      type: "inbox_message",
    });
    expect(insert.error).not.toBeNull();

    const update = await adminA
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", notificationForAdminA)
      .select("id");
    expect(update.data ?? []).toHaveLength(0);
    const check = await service
      .from("notifications")
      .select("read_at")
      .eq("id", notificationForAdminA)
      .single();
    expect(check.data?.read_at).toBeNull();
  });
});

describe("followup_sequences RLS", () => {
  it("is invisible to every authenticated session, including the owning clinic", async () => {
    const own = await adminA.from("followup_sequences").select("id");
    expect(own.data ?? []).toHaveLength(0);
    const foreign = await adminB.from("followup_sequences").select("id");
    expect(foreign.data ?? []).toHaveLength(0);
  });

  it("denies authenticated writes", async () => {
    const insert = await adminA.from("followup_sequences").insert({
      clinic_id: clinicA,
      appointment_id: appointmentA,
    });
    expect(insert.error).not.toBeNull();
  });
});

describe("reminder claim → finalize → release lease (P3-H3)", () => {
  it("claims an offset exactly once as a lease, without stamping the legacy sent time", async () => {
    const first = await service.rpc("claim_appointment_reminder", {
      p_clinic_id: clinicA,
      p_appointment_id: appointmentA,
      p_offset_hours: 24,
      p_claimed_at: new Date().toISOString(),
    });
    expect(first.error).toBeNull();
    expect(first.data).toBe(true);

    const second = await service.rpc("claim_appointment_reminder", {
      p_clinic_id: clinicA,
      p_appointment_id: appointmentA,
      p_offset_hours: 24,
      p_claimed_at: new Date().toISOString(),
    });
    expect(second.data).toBe(false);

    const row = await service
      .from("appointments")
      .select("reminders_sent, reminder_sent_at")
      .eq("id", appointmentA)
      .single();
    // A claim is a lease, not a send: state is "claimed" and the legacy
    // reminder_sent_at stays null until a real dispatch finalizes it.
    expect((row.data?.reminders_sent as Record<string, { state: string }>)["24"].state).toBe(
      "claimed",
    );
    expect(row.data?.reminder_sent_at).toBeNull();
  });

  it("finalize promotes the lease to sent, stamps the legacy time, and blocks reclaim", async () => {
    const finalized = await service.rpc("finalize_appointment_reminder", {
      p_clinic_id: clinicA,
      p_appointment_id: appointmentA,
      p_offset_hours: 24,
      p_sent_at: new Date().toISOString(),
    });
    expect(finalized.data).toBe(true);

    const row = await service
      .from("appointments")
      .select("reminders_sent, reminder_sent_at")
      .eq("id", appointmentA)
      .single();
    expect((row.data?.reminders_sent as Record<string, { state: string }>)["24"].state).toBe(
      "sent",
    );
    expect(row.data?.reminder_sent_at).not.toBeNull();

    // A sent offset can never be reclaimed or released.
    const reclaim = await service.rpc("claim_appointment_reminder", {
      p_clinic_id: clinicA,
      p_appointment_id: appointmentA,
      p_offset_hours: 24,
      p_claimed_at: new Date().toISOString(),
    });
    expect(reclaim.data).toBe(false);
    const release = await service.rpc("release_appointment_reminder", {
      p_clinic_id: clinicA,
      p_appointment_id: appointmentA,
      p_offset_hours: 24,
    });
    expect(release.data).toBe(false);
  });

  it("release frees a claimed offset so a later run reclaims it", async () => {
    const claim = await service.rpc("claim_appointment_reminder", {
      p_clinic_id: clinicA,
      p_appointment_id: appointmentA,
      p_offset_hours: 3,
      p_claimed_at: new Date().toISOString(),
    });
    expect(claim.data).toBe(true);

    const release = await service.rpc("release_appointment_reminder", {
      p_clinic_id: clinicA,
      p_appointment_id: appointmentA,
      p_offset_hours: 3,
    });
    expect(release.data).toBe(true);

    const row = await service
      .from("appointments")
      .select("reminders_sent")
      .eq("id", appointmentA)
      .single();
    expect(row.data?.reminders_sent).not.toHaveProperty("3");

    const reclaim = await service.rpc("claim_appointment_reminder", {
      p_clinic_id: clinicA,
      p_appointment_id: appointmentA,
      p_offset_hours: 3,
      p_claimed_at: new Date().toISOString(),
    });
    expect(reclaim.data).toBe(true);
  });

  it("recovers a stale claim left by a crashed run (past the lease window)", async () => {
    // Simulate a crash: offset 3 is claimed 20 minutes ago and never finalized.
    const staleAt = new Date(Date.now() - 20 * 60_000).toISOString();
    await service
      .from("appointments")
      .update({ reminders_sent: { "3": { state: "claimed", at: staleAt } } })
      .eq("id", appointmentA);

    // The lease has expired, so the offset is re-claimable — no permanent loss.
    const reclaim = await service.rpc("claim_appointment_reminder", {
      p_clinic_id: clinicA,
      p_appointment_id: appointmentA,
      p_offset_hours: 3,
      p_claimed_at: new Date().toISOString(),
    });
    expect(reclaim.data).toBe(true);

    // A fresh claim now blocks a concurrent second attempt.
    const concurrent = await service.rpc("claim_appointment_reminder", {
      p_clinic_id: clinicA,
      p_appointment_id: appointmentA,
      p_offset_hours: 3,
      p_claimed_at: new Date().toISOString(),
    });
    expect(concurrent.data).toBe(false);
  });

  it("refuses a cross-clinic claim and an authenticated caller", async () => {
    const wrongClinic = await service.rpc("claim_appointment_reminder", {
      p_clinic_id: clinicB,
      p_appointment_id: appointmentA,
      p_offset_hours: 1,
      p_claimed_at: new Date().toISOString(),
    });
    expect(wrongClinic.data).toBe(false);

    const authenticated = await adminA.rpc("claim_appointment_reminder", {
      p_clinic_id: clinicA,
      p_appointment_id: appointmentA,
      p_offset_hours: 1,
      p_claimed_at: new Date().toISOString(),
    });
    expect(authenticated.error).not.toBeNull();
  });
});

describe("message_dispatches per-channel idempotency (2026-07-19 flow revision)", () => {
  const key = `invoice:${appointmentA}`;
  async function clearDispatch() {
    await service
      .from("message_dispatches")
      .delete()
      .eq("clinic_id", clinicA)
      .eq("dedupe_key", key);
  }

  it("claims a channel once, blocks a concurrent claim, and finalizes to sent", async () => {
    await clearDispatch();
    const first = await service.rpc("claim_message_dispatch", {
      p_clinic_id: clinicA,
      p_dedupe_key: key,
      p_channel: "email",
      p_now: new Date().toISOString(),
    });
    expect(first.error).toBeNull();
    expect(first.data).toBe(true);

    const concurrent = await service.rpc("claim_message_dispatch", {
      p_clinic_id: clinicA,
      p_dedupe_key: key,
      p_channel: "email",
      p_now: new Date().toISOString(),
    });
    expect(concurrent.data).toBe(false);

    const finalized = await service.rpc("finalize_message_dispatch", {
      p_clinic_id: clinicA,
      p_dedupe_key: key,
      p_channel: "email",
      p_sent_at: new Date().toISOString(),
      // RPC accepts NULL; the generated type over-narrows to string.
      p_outbound_message_id: null as unknown as string,
    });
    expect(finalized.data).toBe(true);

    // A sent channel can never be reclaimed → no duplicate.
    const reclaim = await service.rpc("claim_message_dispatch", {
      p_clinic_id: clinicA,
      p_dedupe_key: key,
      p_channel: "email",
      p_now: new Date().toISOString(),
    });
    expect(reclaim.data).toBe(false);
  });

  it("treats Email and WhatsApp as independent channels for the same message", async () => {
    await clearDispatch();
    const email = await service.rpc("claim_message_dispatch", {
      p_clinic_id: clinicA,
      p_dedupe_key: key,
      p_channel: "email",
      p_now: new Date().toISOString(),
    });
    expect(email.data).toBe(true);
    // WhatsApp is a separate ledger row — one channel never blocks the other.
    const whatsapp = await service.rpc("claim_message_dispatch", {
      p_clinic_id: clinicA,
      p_dedupe_key: key,
      p_channel: "whatsapp",
      p_now: new Date().toISOString(),
    });
    expect(whatsapp.data).toBe(true);
  });

  it("released (failed) channel is reclaimable, so only the failed channel retries", async () => {
    await clearDispatch();
    await service.rpc("claim_message_dispatch", {
      p_clinic_id: clinicA,
      p_dedupe_key: key,
      p_channel: "whatsapp",
      p_now: new Date().toISOString(),
    });
    const released = await service.rpc("release_message_dispatch", {
      p_clinic_id: clinicA,
      p_dedupe_key: key,
      p_channel: "whatsapp",
    });
    expect(released.data).toBe(true);
    const reclaim = await service.rpc("claim_message_dispatch", {
      p_clinic_id: clinicA,
      p_dedupe_key: key,
      p_channel: "whatsapp",
      p_now: new Date().toISOString(),
    });
    expect(reclaim.data).toBe(true);
  });

  it("refuses an authenticated caller (service-role only)", async () => {
    const authenticated = await adminA.rpc("claim_message_dispatch", {
      p_clinic_id: clinicA,
      p_dedupe_key: key,
      p_channel: "email",
      p_now: new Date().toISOString(),
    });
    expect(authenticated.error).not.toBeNull();
  });
});

describe("daily reminder candidate selection", () => {
  it("excludes a reminders-disabled clinic from candidates", async () => {
    try {
      const disabled = await service
        .from("clinics")
        .update({ reminders_enabled: false })
        .eq("id", clinicA);
      expect(disabled.error).toBeNull();

      const candidates = await service.rpc("list_daily_reminder_candidates", {
        p_now: new Date().toISOString(),
        p_horizon: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      });
      expect(candidates.error).toBeNull();
      expect(
        (candidates.data ?? []).some((row) => row.id === appointmentA),
      ).toBe(false);
    } finally {
      await service.from("clinics").update({ reminders_enabled: true }).eq("id", clinicA);
    }
  });

  it("includes a confirmed today/tomorrow appointment for an enabled clinic", async () => {
    const candidates = await service.rpc("list_daily_reminder_candidates", {
      p_now: new Date().toISOString(),
      p_horizon: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    });
    expect(candidates.error).toBeNull();
    expect((candidates.data ?? []).some((row) => row.id === appointmentA)).toBe(true);
  });
});

describe("P3D schema defaults and constraints", () => {
  it("clinics default to the documented {24,3} reminder offsets", async () => {
    const row = await service
      .from("clinics")
      .select("reminder_offsets")
      .eq("id", clinicA)
      .single();
    expect(row.data?.reminder_offsets).toEqual([24, 3]);
  });

  it("clinics default to reminders enabled", async () => {
    const row = await service
      .from("clinics")
      .select("reminders_enabled")
      .eq("id", clinicB)
      .single();
    expect(row.data?.reminders_enabled).toBe(true);
  });

  it("rejects out-of-range reminder offsets", async () => {
    const update = await service
      .from("clinics")
      .update({ reminder_offsets: [500] })
      .eq("id", clinicA);
    expect(update.error).not.toBeNull();
  });

  it("rejects a stopped sequence without a reason", async () => {
    const update = await service
      .from("followup_sequences")
      .update({ status: "stopped" })
      .eq("id", sequenceA);
    expect(update.error).not.toBeNull();
  });
});

describe("list_reminder_candidates starvation guard (P3-H2)", () => {
  it("does not let a large set of fully-reminded rows crowd out a later eligible one", async () => {
    const now = Date.now();
    // 1,000 already-reminded appointments, all due and all earlier than the
    // eligible one — under the old earliest-1,000 query these would fill the
    // entire window and starve the eligible appointment forever.
    const reminded = Array.from({ length: 1000 }, (_, index) => ({
      id: randomUUID(),
      clinic_id: clinicC,
      patient_id: patientC,
      doctor_id: doctorCId,
      created_by: doctorCId,
      // 2 hours out: both the {24,3} offsets are due.
      scheduled_at: new Date(now + 2 * 3_600_000 + index * 1000).toISOString(),
      status: "confirmed" as const,
      reminders_sent: {
        "24": { state: "sent", at: new Date(now).toISOString() },
        "3": { state: "sent", at: new Date(now).toISOString() },
      },
    }));
    // Insert in chunks to stay within statement limits.
    for (let i = 0; i < reminded.length; i += 200) {
      const chunk = reminded.slice(i, i + 200);
      const inserted = await service.from("appointments").insert(chunk);
      expect(inserted.error).toBeNull();
    }

    // One eligible appointment, scheduled LATER than every reminded row.
    const eligible = await service.from("appointments").insert({
      id: eligibleAppointmentC,
      clinic_id: clinicC,
      patient_id: patientC,
      doctor_id: doctorCId,
      created_by: doctorCId,
      scheduled_at: new Date(now + 4 * 3_600_000).toISOString(),
      status: "confirmed",
      reminders_sent: {},
    });
    expect(eligible.error).toBeNull();

    const candidates = await service.rpc("list_reminder_candidates", {
      p_now: new Date(now).toISOString(),
      p_horizon: new Date(now + 168 * 3_600_000).toISOString(),
    });
    expect(candidates.error).toBeNull();
    const ids = (candidates.data ?? []).map((row) => row.id);
    // Fully-reminded rows are excluded in SQL, so the eligible appointment
    // surfaces despite being the 1,001st by schedule time.
    expect(ids).toContain(eligibleAppointmentC);
    expect(ids.some((id) => reminded.some((r) => r.id === id))).toBe(false);
  }, 60_000);
});

describe("emit_clinic_notifications atomic dedupe (P3-M2)", () => {
  const dedupeKey = `reminder_failed|/appointments|appointmentId=${appointmentA}`;

  it("inserts at most one unread row per (recipient, dedupe_key) under concurrency", async () => {
    const emit = () =>
      service.rpc("emit_clinic_notifications", {
        p_clinic_id: clinicA,
        p_recipient_ids: [adminAId],
        p_type: "reminder_failed",
        p_link: "/appointments",
        p_data: { appointmentId: appointmentA },
        p_dedupe_key: dedupeKey,
      });

    // Fire concurrently: the partial unique index + ON CONFLICT DO NOTHING
    // must collapse them to a single unread row.
    const results = await Promise.all([emit(), emit(), emit()]);
    for (const result of results) expect(result.error).toBeNull();
    const inserts = results.reduce((total, r) => total + (r.data ?? 0), 0);
    expect(inserts).toBe(1);

    const unread = await service
      .from("notifications")
      .select("id")
      .eq("recipient_id", adminAId)
      .eq("dedupe_key", dedupeKey)
      .is("read_at", null);
    expect(unread.data).toHaveLength(1);
  });

  it("allows a fresh notification once the previous one is read", async () => {
    await service
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("recipient_id", adminAId)
      .eq("dedupe_key", dedupeKey);

    const again = await service.rpc("emit_clinic_notifications", {
      p_clinic_id: clinicA,
      p_recipient_ids: [adminAId],
      p_type: "reminder_failed",
      p_link: "/appointments",
      p_data: { appointmentId: appointmentA },
      p_dedupe_key: dedupeKey,
    });
    expect(again.data).toBe(1);
  });

  it("rejects a recipient outside the target clinic (tenant isolation)", async () => {
    const foreign = await service.rpc("emit_clinic_notifications", {
      p_clinic_id: clinicA,
      p_recipient_ids: [doctorCId],
      p_type: "reminder_failed",
      p_link: "/appointments",
      p_data: {},
      p_dedupe_key: `x-${randomUUID()}`,
    });
    // The composite (recipient_id, clinic_id) FK refuses the cross-clinic row.
    expect(foreign.error).not.toBeNull();
  });
});
