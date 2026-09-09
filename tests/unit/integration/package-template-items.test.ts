/**
 * A package's contents, proved against a live PostgreSQL.
 *
 * The migration contract test pins the *text* of
 * `20260918120000_bilingual_patient_names_and_package_service.sql`. This one
 * pins its behaviour, because a foreign key that carries `department_id` is
 * only worth having if a cross-department row is genuinely refused, and the
 * only thing that can demonstrate that is PostgreSQL.
 *
 * What is proved here:
 *
 *   * a package holds zero, one or many services;
 *   * an existing package with no lines keeps working, untouched;
 *   * a line naming another clinic's service is unrepresentable;
 *   * a line naming another *department's* service is unrepresentable, even
 *     within the same clinic;
 *   * deleting a service does not delete the package — the delete is refused;
 *   * soft-deleting a service, which is what the product actually does, leaves
 *     the package and its agreed prices completely intact;
 *   * a package's prices are its own: editing them never writes `services.price`
 *     and a catalogue price change never reprices a package;
 *   * `clinic_id` is never nulled by anything;
 *   * RLS is the authorization for the item writer, so a non-admin cannot
 *     write and another clinic cannot read.
 *
 * Run against the local stack (`supabase start`), never against Production.
 */

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

type Client = SupabaseClient<Database>;
const suffix = `pkg-items-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "PackageItems12345";

const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  physio: randomUUID(),
  derma: randomUUID(),
  clinicADept: randomUUID(),
  rehab: randomUUID(),
  posture: randomUUID(),
  acne: randomUUID(),
  otherClinicService: randomUUID(),
  basket: randomUUID(),
  legacy: randomUUID(),
};

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function sessionClient(): Client {
  return createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `${suffix}-${Math.random().toString(36).slice(2)}`,
    },
  });
}

const userIds: string[] = [];
async function createUser(label: string) {
  const email = `${suffix}-${label}@example.com`;
  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) throw created.error ?? new Error("No user");
  userIds.push(created.data.user.id);
  const client = sessionClient();
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { id: created.data.user.id, client };
}

function mustSucceed(result: { error: { message: string } | null }, label: string) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
}

let adminB: Awaited<ReturnType<typeof createUser>>;
let receptionistB: Awaited<ReturnType<typeof createUser>>;
let managerB: Awaited<ReturnType<typeof createUser>>;
let adminA: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  [adminA, adminB, receptionistB, managerB] = await Promise.all([
    createUser("admin-a"),
    createUser("admin-b"),
    createUser("reception-b"),
    createUser("manager-b"),
  ]);
  mustSucceed(
    await service.from("clinics").insert([
      { id: ids.clinicA, name: `Items A ${suffix}` },
      { id: ids.clinicB, name: `Items B ${suffix}` },
    ]),
    "clinics",
  );
  mustSucceed(
    await service.from("profiles").insert([
      { id: adminA.id, clinic_id: ids.clinicA, full_name: "Admin A", role: "admin" },
      { id: adminB.id, clinic_id: ids.clinicB, full_name: "Admin B", role: "admin" },
      {
        id: receptionistB.id,
        clinic_id: ids.clinicB,
        full_name: "Reception B",
        role: "receptionist",
      },
      { id: managerB.id, clinic_id: ids.clinicB, full_name: "Manager B", role: "manager" },
    ]),
    "profiles",
  );
  mustSucceed(
    await service.from("departments").insert([
      { id: ids.physio, clinic_id: ids.clinicB, name: `Physio ${suffix}`, color: "#0891b2" },
      { id: ids.derma, clinic_id: ids.clinicB, name: `Derma ${suffix}`, color: "#22d3ee" },
      { id: ids.clinicADept, clinic_id: ids.clinicA, name: `Other ${suffix}`, color: "#123456" },
    ]),
    "departments",
  );
  mustSucceed(
    await service.from("services").insert([
      { id: ids.rehab, clinic_id: ids.clinicB, department_id: ids.physio, name: "Rehabilitation Session", price: 1300 },
      { id: ids.posture, clinic_id: ids.clinicB, department_id: ids.physio, name: "Sports Injury Therapy", price: 1800 },
      { id: ids.acne, clinic_id: ids.clinicB, department_id: ids.derma, name: "Acne Treatment", price: 250 },
      { id: ids.otherClinicService, clinic_id: ids.clinicA, department_id: ids.clinicADept, name: "Other Clinic Service", price: 500 },
    ]),
    "services",
  );
  mustSucceed(
    await service.from("package_templates").insert([
      {
        id: ids.basket,
        clinic_id: ids.clinicB,
        department_id: ids.physio,
        name: `Rehabilitation package ${suffix}`,
        total_sessions: 1,
      },
      {
        // The legacy shape: a department-only package with no lines, priced by
        // hand. Every package that exists before the item table is this.
        id: ids.legacy,
        clinic_id: ids.clinicB,
        department_id: ids.derma,
        name: `Department-only package ${suffix}`,
        total_sessions: 6,
        price_per_session: 750,
        total_price: 4200,
      },
    ]),
    "templates",
  );
}, 60_000);

afterAll(async () => {
  await service.from("package_template_items").delete().in("clinic_id", [ids.clinicA, ids.clinicB]);
  await service.from("package_templates").delete().in("clinic_id", [ids.clinicA, ids.clinicB]);
  await service.from("services").delete().in("clinic_id", [ids.clinicA, ids.clinicB]);
  await service.from("departments").delete().in("clinic_id", [ids.clinicA, ids.clinicB]);
  await service.from("profiles").delete().in("clinic_id", [ids.clinicA, ids.clinicB]);
  await service.from("clinics").delete().in("id", [ids.clinicA, ids.clinicB]);
  for (const id of userIds) await service.auth.admin.deleteUser(id);
});

/** The lines on one package, in the clinic's own order. */
async function linesOf(templateId: string) {
  const read = await service
    .from("package_template_items")
    .select("service_id, sessions, price_per_session, sort_order, clinic_id, department_id")
    .eq("package_template_id", templateId)
    .order("sort_order");
  mustSucceed(read, "read lines");
  return read.data ?? [];
}

async function headerOf(templateId: string) {
  const read = await service
    .from("package_templates")
    .select("total_sessions, price_per_session, total_price, department_id, clinic_id")
    .eq("id", templateId)
    .single();
  mustSucceed(read, "read header");
  return read.data!;
}

describe("a package holds zero, one or many services", () => {
  it("stores several lines, each with its own sessions and its own price", async () => {
    const written = await adminB.client.rpc("set_package_template_items", {
      p_template_id: ids.basket,
      p_items: [
        { service_id: ids.rehab, sessions: 5, price_per_session: 1300 },
        { service_id: ids.posture, sessions: 3, price_per_session: 1800 },
      ],
    });
    mustSucceed(written, "write two lines");
    const lines = await linesOf(ids.basket);
    expect(lines).toHaveLength(2);
    expect(lines[0].service_id).toBe(ids.rehab);
    expect(lines[0].sessions).toBe(5);
    expect(Number(lines[0].price_per_session)).toBe(1300);
    expect(lines[1].service_id).toBe(ids.posture);
    expect(lines[1].sessions).toBe(3);
    expect(Number(lines[1].price_per_session)).toBe(1800);
    // Order is the clinic's, and it survives the round trip.
    expect(lines.map((line) => line.sort_order)).toEqual([0, 1]);
  });

  it("derives the header's roll-up from the lines and nothing else", async () => {
    const header = await headerOf(ids.basket);
    // 5 + 3 sessions; 5 × 1300 + 3 × 1800 = 11900.
    expect(header.total_sessions).toBe(8);
    expect(Number(header.total_price)).toBe(11900);
    // Several prices, so the header holds none of them rather than one chosen
    // arbitrarily.
    expect(header.price_per_session).toBeNull();
  });

  it("collapses to a single-service package, and back to none", async () => {
    mustSucceed(
      await adminB.client.rpc("set_package_template_items", {
        p_template_id: ids.basket,
        p_items: [{ service_id: ids.rehab, sessions: 4, price_per_session: 1250 }],
      }),
      "one line",
    );
    expect(await linesOf(ids.basket)).toHaveLength(1);
    let header = await headerOf(ids.basket);
    expect(header.total_sessions).toBe(4);
    expect(Number(header.total_price)).toBe(5000);
    // One line has one meaningful price per session, so the header shows it.
    expect(Number(header.price_per_session)).toBe(1250);

    mustSucceed(
      await adminB.client.rpc("set_package_template_items", {
        p_template_id: ids.basket,
        p_items: [],
      }),
      "no lines",
    );
    expect(await linesOf(ids.basket)).toHaveLength(0);
    // Emptying the lines leaves the header's last agreed numbers alone rather
    // than zeroing a package's price.
    header = await headerOf(ids.basket);
    expect(header.total_sessions).toBe(4);

    // Restore the basket for the tests below.
    mustSucceed(
      await adminB.client.rpc("set_package_template_items", {
        p_template_id: ids.basket,
        p_items: [
          { service_id: ids.rehab, sessions: 5, price_per_session: 1300 },
          { service_id: ids.posture, sessions: 3, price_per_session: 1800 },
        ],
      }),
      "restore",
    );
  });

  it("refuses the same service twice with a named error, not a constraint name", async () => {
    const written = await adminB.client.rpc("set_package_template_items", {
      p_template_id: ids.basket,
      p_items: [
        { service_id: ids.rehab, sessions: 5, price_per_session: 1300 },
        { service_id: ids.rehab, sessions: 2, price_per_session: 900 },
      ],
    });
    expect(written.error).not.toBeNull();
    // Refused by name, before the delete runs. The unique constraint would
    // catch it too, but as a `unique_violation` naming an index — which tells a
    // caller nothing about which field was wrong.
    expect(written.error?.message).toContain("PACKAGE_ITEM_DUPLICATE_SERVICE");
    expect(written.error?.message).not.toMatch(/unique|constraint|_idx|_key/i);
    // And the package it refused is unchanged: the delete never ran.
    expect(await linesOf(ids.basket)).toHaveLength(2);
  });
});

describe("a legacy package with no lines keeps working", () => {
  it("holds zero lines and its own hand-typed numbers", async () => {
    expect(await linesOf(ids.legacy)).toHaveLength(0);
    const header = await headerOf(ids.legacy);
    expect(header.total_sessions).toBe(6);
    expect(Number(header.price_per_session)).toBe(750);
    // A deliberate package price that is not 6 × 750 = 4500. Nothing
    // recalculates it, because it has no lines to recalculate it from.
    expect(Number(header.total_price)).toBe(4200);
  });

  it("is still readable and updatable without ever naming an item", async () => {
    mustSucceed(
      await adminB.client
        .from("package_templates")
        .update({ notes: "Unchanged shape" })
        .eq("id", ids.legacy),
      "update legacy",
    );
    const header = await headerOf(ids.legacy);
    expect(Number(header.total_price)).toBe(4200);
    expect(await linesOf(ids.legacy)).toHaveLength(0);
  });
});

describe("the database refuses a line it should never hold", () => {
  it("makes another clinic's service unrepresentable", async () => {
    // Straight at the table with the service role, past every application
    // check: the foreign key is the guarantee, not the mutation.
    const inserted = await service.from("package_template_items").insert({
      clinic_id: ids.clinicB,
      package_template_id: ids.basket,
      department_id: ids.physio,
      service_id: ids.otherClinicService,
      sessions: 1,
      price_per_session: 10,
    });
    expect(inserted.error).not.toBeNull();
    expect(inserted.error?.message).toMatch(/foreign key|violates/i);
  });

  it("makes another department's service unrepresentable, inside one clinic", async () => {
    // `acne` is this clinic's, and it is Dermatology's. The package is
    // Physiotherapy's. Same tenant, still refused.
    const inserted = await service.from("package_template_items").insert({
      clinic_id: ids.clinicB,
      package_template_id: ids.basket,
      department_id: ids.physio,
      service_id: ids.acne,
      sessions: 1,
      price_per_session: 10,
    });
    expect(inserted.error).not.toBeNull();
    expect(inserted.error?.message).toMatch(/foreign key|violates/i);
  });

  it("cannot be smuggled past by claiming the service's department", async () => {
    // Naming Dermatology to satisfy the service key breaks the package key,
    // because the package is filed under Physiotherapy. Both must agree.
    const inserted = await service.from("package_template_items").insert({
      clinic_id: ids.clinicB,
      package_template_id: ids.basket,
      department_id: ids.derma,
      service_id: ids.acne,
      sessions: 1,
      price_per_session: 10,
    });
    expect(inserted.error).not.toBeNull();
  });

  it("refuses a cross-department line through the write function too", async () => {
    const written = await adminB.client.rpc("set_package_template_items", {
      p_template_id: ids.basket,
      p_items: [{ service_id: ids.acne, sessions: 1, price_per_session: 10 }],
    });
    expect(written.error).not.toBeNull();
    expect(written.error?.message).toContain("PACKAGE_ITEM_SERVICE_INVALID");
    expect(await linesOf(ids.basket)).toHaveLength(2);
  });

  it("refuses a line naming a soft-deleted service", async () => {
    mustSucceed(
      await service.from("services").update({ is_active: false }).eq("id", ids.posture),
      "deactivate",
    );
    const written = await adminB.client.rpc("set_package_template_items", {
      p_template_id: ids.basket,
      p_items: [{ service_id: ids.posture, sessions: 1, price_per_session: 10 }],
    });
    expect(written.error).not.toBeNull();
    expect(written.error?.message).toContain("PACKAGE_ITEM_SERVICE_INVALID");
    mustSucceed(
      await service.from("services").update({ is_active: true }).eq("id", ids.posture),
      "reactivate",
    );
  });
});

describe("deleting a service never deletes a package", () => {
  it("refuses to hard-delete a service a package still contains", async () => {
    const deleted = await service.from("services").delete().eq("id", ids.rehab);
    expect(deleted.error).not.toBeNull();
    expect(deleted.error?.message).toMatch(/foreign key|violates|still referenced/i);
    // The package, its lines and its total are all exactly as they were.
    expect(await linesOf(ids.basket)).toHaveLength(2);
    const header = await headerOf(ids.basket);
    expect(Number(header.total_price)).toBe(11900);
  });

  it("leaves the package whole when a service is soft-deleted, which is what the product does", async () => {
    mustSucceed(
      await service
        .from("services")
        .update({ is_active: false, deleted_at: new Date().toISOString() })
        .eq("id", ids.posture),
      "soft delete",
    );
    const lines = await linesOf(ids.basket);
    expect(lines).toHaveLength(2);
    // The clinic's agreed price for that service inside this package is still
    // the clinic's agreed price. It was never a pointer at the catalogue.
    expect(Number(lines[1].price_per_session)).toBe(1800);
    const header = await headerOf(ids.basket);
    expect(Number(header.total_price)).toBe(11900);
    mustSucceed(
      await service
        .from("services")
        .update({ is_active: true, deleted_at: null })
        .eq("id", ids.posture),
      "restore service",
    );
  });

  it("takes a package's own lines with it when the package is deleted", async () => {
    const throwaway = randomUUID();
    mustSucceed(
      await service.from("package_templates").insert({
        id: throwaway,
        clinic_id: ids.clinicB,
        department_id: ids.physio,
        name: `Throwaway ${suffix}`,
        total_sessions: 1,
      }),
      "throwaway package",
    );
    mustSucceed(
      await adminB.client.rpc("set_package_template_items", {
        p_template_id: throwaway,
        p_items: [{ service_id: ids.rehab, sessions: 2, price_per_session: 100 }],
      }),
      "throwaway line",
    );
    mustSucceed(
      await service.from("package_templates").delete().eq("id", throwaway),
      "delete package",
    );
    expect(await linesOf(throwaway)).toHaveLength(0);
    // And the service the package pointed at is untouched.
    const stillThere = await service.from("services").select("id").eq("id", ids.rehab).single();
    mustSucceed(stillThere, "service survives");
  });
});

describe("clinic_id is never nulled", () => {
  it("keeps the tenant on every line through every operation above", async () => {
    const lines = await linesOf(ids.basket);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.clinic_id).toBe(ids.clinicB);
      expect(line.department_id).toBe(ids.physio);
    }
    const header = await headerOf(ids.basket);
    expect(header.clinic_id).toBe(ids.clinicB);
  });

  it("refuses a null tenant outright", async () => {
    const nulled = await service
      .from("package_template_items")
      // @ts-expect-error - proving the column rejects it, which is the point.
      .update({ clinic_id: null })
      .eq("package_template_id", ids.basket);
    expect(nulled.error).not.toBeNull();
  });
});

describe("a package price is the package's, and the catalogue's is the catalogue's", () => {
  it("does not touch services.price when a line's price is changed", async () => {
    const before = await service.from("services").select("price").eq("id", ids.rehab).single();
    mustSucceed(before, "catalogue price before");
    mustSucceed(
      await adminB.client.rpc("set_package_template_items", {
        p_template_id: ids.basket,
        p_items: [
          { service_id: ids.rehab, sessions: 5, price_per_session: 999 },
          { service_id: ids.posture, sessions: 3, price_per_session: 1800 },
        ],
      }),
      "reprice the line",
    );
    const after = await service.from("services").select("price").eq("id", ids.rehab).single();
    mustSucceed(after, "catalogue price after");
    expect(Number(after.data!.price)).toBe(Number(before.data!.price));
    expect(Number(after.data!.price)).toBe(1300);
  });

  it("does not reprice a package when the catalogue price changes", async () => {
    mustSucceed(
      await service.from("services").update({ price: 4000 }).eq("id", ids.rehab),
      "catalogue change",
    );
    const lines = await linesOf(ids.basket);
    // The clinic agreed 999 for this service inside this package on the day
    // they built it. A later catalogue change is not a repricing of that.
    expect(Number(lines[0].price_per_session)).toBe(999);
    const header = await headerOf(ids.basket);
    expect(Number(header.total_price)).toBe(5 * 999 + 3 * 1800);
    mustSucceed(
      await service.from("services").update({ price: 1300 }).eq("id", ids.rehab),
      "catalogue restore",
    );
  });
});

describe("a malformed line is refused by name, never by PostgreSQL", () => {
  it("refuses a service_id that is not a uuid without raising a type error", async () => {
    const written = await adminB.client.rpc("set_package_template_items", {
      p_template_id: ids.basket,
      p_items: [{ service_id: "not-a-uuid", sessions: 1, price_per_session: 10 }],
    });
    expect(written.error).not.toBeNull();
    expect(written.error?.message).toContain("PACKAGE_ITEM_INVALID");
    // Not `invalid input syntax for type uuid`: a raw cast error names a type
    // rather than a field, arrives unmapped, and is worded differently across
    // server versions.
    expect(written.error?.message).not.toMatch(/invalid input syntax|type uuid/i);
    expect(await linesOf(ids.basket)).toHaveLength(2);
  });

  it("refuses a well-formed uuid that is not a service of this clinic", async () => {
    // Past the shape check, refused by the ownership check — a different, and
    // also named, error.
    const written = await adminB.client.rpc("set_package_template_items", {
      p_template_id: ids.basket,
      p_items: [{ service_id: randomUUID(), sessions: 1, price_per_session: 10 }],
    });
    expect(written.error).not.toBeNull();
    expect(written.error?.message).toContain("PACKAGE_ITEM_SERVICE_INVALID");
  });

  it("refuses the other malformed shapes by the same named error", async () => {
    for (const item of [
      { service_id: ids.rehab, sessions: 0, price_per_session: 10 },
      { service_id: ids.rehab, sessions: "many", price_per_session: 10 },
      { service_id: ids.rehab, sessions: 1, price_per_session: -5 },
      { service_id: ids.rehab, sessions: 1, price_per_session: "free" },
      { sessions: 1, price_per_session: 10 },
    ]) {
      const written = await adminB.client.rpc("set_package_template_items", {
        p_template_id: ids.basket,
        p_items: [item],
      });
      expect(written.error, JSON.stringify(item)).not.toBeNull();
      expect(written.error?.message, JSON.stringify(item)).toContain("PACKAGE_ITEM_INVALID");
    }
    expect(await linesOf(ids.basket)).toHaveLength(2);
  });
});

describe("RLS is the authorization for the item writer", () => {
  it("lets an admin of the clinic write", async () => {
    const written = await adminB.client.rpc("set_package_template_items", {
      p_template_id: ids.basket,
      p_items: [{ service_id: ids.rehab, sessions: 5, price_per_session: 1300 }],
    });
    mustSucceed(written, "admin writes");
  });

  it("refuses a receptionist of the same clinic", async () => {
    const written = await receptionistB.client.rpc("set_package_template_items", {
      p_template_id: ids.basket,
      p_items: [{ service_id: ids.rehab, sessions: 1, price_per_session: 1 }],
    });
    expect(written.error).not.toBeNull();
    // Unchanged: the write was refused, not partially applied.
    const lines = await linesOf(ids.basket);
    expect(lines).toHaveLength(1);
    expect(lines[0].sessions).toBe(5);
  });

  it("refuses an admin of another clinic, and shows them nothing", async () => {
    const written = await adminA.client.rpc("set_package_template_items", {
      p_template_id: ids.basket,
      p_items: [],
    });
    expect(written.error).not.toBeNull();
    const read = await adminA.client
      .from("package_template_items")
      .select("id")
      .eq("package_template_id", ids.basket);
    expect(read.data ?? []).toHaveLength(0);
  });

  it("refuses a manager of the same clinic, because the policy is admin-only", async () => {
    const written = await managerB.client.rpc("set_package_template_items", {
      p_template_id: ids.basket,
      p_items: [{ service_id: ids.rehab, sessions: 2, price_per_session: 2 }],
    });
    expect(written.error).not.toBeNull();
    const lines = await linesOf(ids.basket);
    expect(lines).toHaveLength(1);
    expect(lines[0].sessions).toBe(5);
  });

  it("gives the service role no EXECUTE at all", async () => {
    // The function is SECURITY INVOKER, so RLS *is* its authorization — and
    // `service_role` bypasses RLS. Granting it EXECUTE would hand it a writer
    // with no check whatsoever, turning "RLS is the authorization" into "RLS is
    // the authorization unless you hold the service key". Nothing needs it: the
    // only caller is the Settings mutation on the signed-in admin's own
    // session client.
    const written = await service.rpc("set_package_template_items", {
      p_template_id: ids.basket,
      p_items: [{ service_id: ids.rehab, sessions: 9, price_per_session: 9 }],
    });
    expect(written.error).not.toBeNull();
    // `42501` specifically, so a PostgREST schema-cache miss can never make
    // this pass for the wrong reason: the privilege is what refused it.
    expect(written.error?.code).toBe("42501");
    expect(written.error?.message).toMatch(/permission denied for function/i);
    // Refused at the privilege, so the function never ran.
    const lines = await linesOf(ids.basket);
    expect(lines).toHaveLength(1);
    expect(lines[0].sessions).toBe(5);
  });

  it("gives anon no EXECUTE either", async () => {
    const anon = sessionClient();
    const written = await anon.rpc("set_package_template_items", {
      p_template_id: ids.basket,
      p_items: [],
    });
    expect(written.error).not.toBeNull();
    expect(written.error?.code).toBe("42501");
  });

  it("shows a clinic member of the owning clinic their own lines", async () => {
    const read = await receptionistB.client
      .from("package_template_items")
      .select("id, sessions")
      .eq("package_template_id", ids.basket);
    mustSucceed(read, "member read");
    expect(read.data ?? []).toHaveLength(1);
  });
});
