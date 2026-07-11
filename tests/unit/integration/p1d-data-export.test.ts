import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.SUPABASE_SERVICE_ROLE_KEY = secretKey;

const service = createClient<Database>(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P1dExport123";
const BULK_PATIENTS = 1050;
const adminSession = createClient<Database>(url, publishableKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

let adminId: string;
let clinicId: string;
let otherClinicId: string;
let getExport: () => Promise<Response>;

beforeAll(async () => {
  const admin = await service.auth.admin.createUser({
    email: `p1d-export-${suffix}@example.com`,
    password,
    email_confirm: true,
  });
  if (admin.error || !admin.data.user) throw admin.error;
  adminId = admin.data.user.id;

  const clinics = await service
    .from("clinics")
    .insert([{ name: `Export Clinic ${suffix}` }, { name: `Other Clinic ${suffix}` }])
    .select("id");
  if (clinics.error) throw clinics.error;
  [clinicId, otherClinicId] = clinics.data.map((row) => row.id);

  const profile = await service.from("profiles").insert({
    id: adminId,
    clinic_id: clinicId,
    full_name: "Export Admin",
    role: "admin",
    must_change_password: false,
  });
  if (profile.error) throw profile.error;

  const patients = await service
    .from("patients")
    .insert([
      {
        clinic_id: clinicId,
        full_name: `Own "Quoted" Patient`,
        phone: `51${suffix.slice(0, 6)}`,
        date_of_birth: "1990-01-01",
        email: `p1d-export-${suffix}-own@example.com`,
        national_id: `${suffix}O`,
        file_number: `${suffix}-O`,
        created_by: adminId,
      },
      {
        // Spreadsheet formula payload: must come back neutralized in the CSV.
        clinic_id: clinicId,
        full_name: `=HYPERLINK("https://evil.example","open")`,
        phone: `53${suffix.slice(0, 6)}`,
        date_of_birth: "1992-01-01",
        email: `p1d-export-${suffix}-formula@example.com`,
        national_id: `${suffix}X`,
        file_number: `${suffix}-X`,
        created_by: adminId,
      },
      {
        clinic_id: otherClinicId,
        full_name: "Foreign Patient",
        phone: `52${suffix.slice(0, 6)}`,
        date_of_birth: "1991-01-01",
        email: `p1d-export-${suffix}-foreign@example.com`,
        national_id: `${suffix}F`,
        file_number: `${suffix}-F`,
        created_by: adminId,
      },
    ])
    .select("id, clinic_id");
  if (patients.error) throw patients.error;
  const ownPatient = patients.data.find((row) => row.clinic_id === clinicId)!;

  // >1,000 rows in one table proves the export paginates past PostgREST's
  // max_rows response cap instead of silently truncating.
  for (let start = 0; start < BULK_PATIENTS; start += 500) {
    const chunk = Array.from({ length: Math.min(500, BULK_PATIENTS - start) }, (_, i) => {
      const n = start + i;
      return {
        clinic_id: clinicId,
        full_name: `Bulk Patient ${n}`,
        phone: `9${String(n).padStart(7, "0")}`,
        date_of_birth: "1985-01-01",
        email: `p1d-export-${suffix}-bulk-${n}@example.com`,
        national_id: `${suffix}B${n}`,
        file_number: `${suffix}-B${n}`,
        created_by: adminId,
      };
    });
    const bulk = await service.from("patients").insert(chunk);
    if (bulk.error) throw bulk.error;
  }

  const deposit = await service.from("patient_deposits").insert({
    clinic_id: clinicId,
    patient_id: ownPatient.id,
    amount: 40,
    payment_method: "cash",
    created_by: adminId,
  });
  if (deposit.error) throw deposit.error;

  await adminSession.auth.signInWithPassword({ email: `p1d-export-${suffix}@example.com`, password });

  vi.doMock("@/lib/rbac", () => ({
    requireRole: vi.fn(async () => ({ id: adminId, clinicId, role: "admin" })),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => adminSession),
  }));
  ({ GET: getExport } = await import("@/app/(protected)/settings/export/route"));
}, 120_000);

afterAll(async () => {
  vi.doUnmock("@/lib/rbac");
  vi.doUnmock("@/lib/supabase/server");
  await service.from("patient_deposits").delete().eq("clinic_id", clinicId);
  await service.from("patients").delete().in("clinic_id", [clinicId, otherClinicId]);
  await service.from("profiles").delete().eq("id", adminId);
  await service.from("clinics").delete().in("id", [clinicId, otherClinicId]);
  await service.auth.admin.deleteUser(adminId);
}, 120_000);

describe("P1D per-clinic data export", () => {
  it("produces a complete, tenant-isolated ZIP through the admin's RLS session", async () => {
    const response = await getExport();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");

    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50); // ZIP local-header magic
    const text = bytes.toString("utf8");
    for (const name of [
      "patients.csv",
      "appointments.csv",
      "medical_notes_metadata.csv",
      "invoices.csv",
      "documents.csv",
    ]) {
      expect(text).toContain(name);
    }

    expect(text).toContain('"Own ""Quoted"" Patient"'); // own data, CSV-escaped
    expect(text).toContain("deposit"); // invoices.csv payload
    expect(text).not.toContain("Foreign Patient"); // tenant isolation via RLS

    // Completeness past PostgREST's 1,000-row cap: every bulk row is present.
    const bulkRows = text.match(new RegExp(`p1d-export-${suffix}-bulk-`, "g")) ?? [];
    expect(bulkRows.length).toBe(BULK_PATIENTS);

    // Formula injection: the leading '=' is neutralized and the cell quoted.
    expect(text).toContain(`"'=HYPERLINK(""https://evil.example"",""open"")"`);
    expect(text).not.toContain(`\n=HYPERLINK`);
  }, 120_000);
});
