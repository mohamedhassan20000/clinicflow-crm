import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

/**
 * `fold_national_id` is reachable from an authenticated session only as the
 * expression of `patients_clinic_folded_national_id_idx`, and Postgres
 * evaluates an expression index as the writing role. When the grant is missing
 * the index turns every authenticated patient write into 42501 — proven live
 * in Production — so the property under test is a *write* property, asserted
 * through the real mutations rather than by reading a catalogue.
 *
 * Four things are pinned here. The first two are the regression; the last two
 * are the blast radius of the fix, which must stay exactly one role wide.
 */

const domainClients = vi.hoisted(() => ({
  session: null as SupabaseClient<Database> | null,
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!domainClients.session) throw new Error("No integration session client");
    return domainClients.session;
  },
}));

import {
  createPatientMutation,
  updatePatientMutation,
} from "@/lib/patients/mutations";
import type { AuthedUser } from "@/lib/rbac";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.SUPABASE_SERVICE_ROLE_KEY = secretKey;

const suffix = `foldgrant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const password = "FoldGrantTest12345";
const clinicId = randomUUID();
const userIds: string[] = [];

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = createClient<Database>(url, publishableKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    storageKey: `${suffix}-anon`,
  },
});

let admin: { id: string; client: SupabaseClient<Database> };
/** The id the first test creates, reused by the update test. */
let createdPatientId = "";

/** A digits-only national id, unique per run so reruns never collide. */
function nationalId(prefix: string) {
  return `${prefix}${String(Date.now()).slice(-9)}`;
}

async function createAdmin() {
  const email = `${suffix}-admin@example.com`;
  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw created.error ?? new Error("admin not created");
  }
  userIds.push(created.data.user.id);
  const client = createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `${suffix}-admin`,
    },
  });
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { id: created.data.user.id, client };
}

function adminUser(): AuthedUser {
  return {
    id: admin.id,
    clinicId,
    email: `${suffix}-admin@example.com`,
    fullName: "Fold Grant Admin",
    role: "admin",
    avatarUrl: null,
    departmentId: null,
    mustChangePassword: false,
  };
}

async function cleanup() {
  await service.from("patients").delete().eq("clinic_id", clinicId);
  await service.from("profiles").delete().in("id", userIds);
  await service.from("clinics").delete().eq("id", clinicId);
}

beforeAll(async () => {
  await cleanup();
  admin = await createAdmin();
  const clinic = await service
    .from("clinics")
    .insert({ id: clinicId, name: `Fold Grant ${suffix}`, country: "EG" });
  if (clinic.error) throw clinic.error;
  const profile = await service.from("profiles").insert({
    id: admin.id,
    clinic_id: clinicId,
    full_name: "Fold Grant Admin",
    role: "admin",
    must_change_password: false,
  });
  if (profile.error) throw profile.error;
  domainClients.session = admin.client;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(
    userIds.map((id) => service.auth.admin.deleteUser(id).catch(() => null)),
  );
  await admin?.client.auth.signOut();
}, 60_000);

describe("fold_national_id · the expression index must not block authenticated writes", () => {
  it("creates a patient through the real mutation without a permission error", async () => {
    const created = await createPatientMutation(adminUser(), {
      full_name: "Fold Grant Patient",
      national_id: nationalId("29001"),
      date_of_birth: "1990-01-01",
      phone: "+201000000001",
      email: `${suffix}-patient@example.com`,
      blood_type: "O+",
      department_id: null,
      assigned_doctor_id: null,
      insurance_provider_id: null,
    });

    // Before the grant this failed as 42501 on the index expression, surfaced
    // by the mutation as `failedToCreatePatient…`. The message is asserted so a
    // future failure names the real cause instead of "ok was false".
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error("patient not created");
    createdPatientId = created.data.patient_id;
    expect(createdPatientId).toMatch(/^[0-9a-f-]{36}$/i);

    // The row is really there, and really carries the id that had to be folded.
    const stored = await service
      .from("patients")
      .select("id, clinic_id")
      .eq("id", createdPatientId)
      .single();
    expect(stored.error).toBeNull();
    expect(stored.data?.clinic_id).toBe(clinicId);
  });

  it("updates national_id — the column the index expression reads", async () => {
    expect(createdPatientId).toBeTruthy();
    const changed = nationalId("29002");

    // Changing `national_id` forces a new index entry, so this is the update
    // that always evaluated the function. A non-indexed column would pass even
    // without the grant whenever a HOT update applies, and would not be a test.
    const updated = await updatePatientMutation(adminUser(), {
      patient_id: createdPatientId,
      full_name: "Fold Grant Patient Renamed",
      national_id: changed,
      date_of_birth: "1990-01-01",
      phone: "+201000000001",
      email: `${suffix}-patient@example.com`,
      blood_type: "O+",
      department_id: null,
      assigned_doctor_id: null,
      insurance_provider_id: null,
    });
    expect(updated.ok, JSON.stringify(updated)).toBe(true);

    const stored = await service
      .from("patients")
      .select("national_id")
      .eq("id", createdPatientId)
      .single();
    expect(stored.error).toBeNull();
    expect(stored.data?.national_id).toBe(changed);
  });

  it("still refuses the function to anon", async () => {
    const attempt = await anon.rpc("fold_national_id", { p_value: "AB-12/34" });
    expect(attempt.error).not.toBeNull();
    expect(attempt.error?.code).toBe("42501");
    expect(attempt.data).toBeNull();
  });

  it("still allows the function to service_role, unchanged", async () => {
    const allowed = await service.rpc("fold_national_id", {
      p_value: "AB-12/34",
    });
    expect(allowed.error).toBeNull();
    expect(allowed.data).toBe("ab1234");
  });

  it("returns only a normalization of the caller's own text, never a lookup", async () => {
    // The privacy argument for the grant, asserted rather than asserted-in-prose:
    // the function is a pure map over its argument. A national id that exists in
    // this clinic and one that exists nowhere fold identically, so an
    // authenticated caller learns nothing about who is on file.
    const real = await service
      .from("patients")
      .select("national_id")
      .eq("id", createdPatientId)
      .single();
    expect(real.error).toBeNull();
    const onFile = real.data!.national_id;
    const notOnFile = nationalId("39999");

    const [foldedReal, foldedFake] = await Promise.all([
      admin.client.rpc("fold_national_id", { p_value: `${onFile}` }),
      admin.client.rpc("fold_national_id", { p_value: `${notOnFile}` }),
    ]);
    expect(foldedReal.error).toBeNull();
    expect(foldedFake.error).toBeNull();
    // Each answer is exactly its own input, lowercased and stripped — the
    // existence of a matching row changes nothing about either result.
    expect(foldedReal.data).toBe(onFile.toLowerCase());
    expect(foldedFake.data).toBe(notOnFile.toLowerCase());
  });
});
