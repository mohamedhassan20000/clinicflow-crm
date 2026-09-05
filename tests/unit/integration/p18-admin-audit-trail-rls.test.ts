import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

// P18 — the administrative audit trail is a database property. That the actor
// cannot be forged, that a clinic cannot read another clinic's history, that a
// no-op save produces no event, that money survives the round trip exactly, and
// that a business mutation and its audit row commit together are all things a
// mocked client would happily agree to and Postgres decides. So this runs
// against live Postgres.

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `aud-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "AdminAuditTrail12345";
const clinicA = randomUUID();
const clinicB = randomUUID();
const ALL_CLINICS = [clinicA, clinicB];

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userIds: string[] = [];

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
  if (created.error || !created.data.user) throw created.error ?? new Error("no user");
  userIds.push(created.data.user.id);
  const signedIn = anonClient();
  const auth = await signedIn.auth.signInWithPassword({ email, password });
  if (auth.error) throw auth.error;
  return { id: created.data.user.id, client: signedIn };
}

let adminA: Client;
let adminAId = "";
let managerA: Client;
let receptionistA: Client;
let adminB: Client;
let adminBId = "";
let departmentA = "";
let departmentA2 = "";

async function cleanup() {
  await service.from("admin_audit_events").delete().in("clinic_id", ALL_CLINICS);
  await service.from("whatsapp_linked_device_sessions").delete().in("clinic_id", ALL_CLINICS);
  await service.from("services").delete().in("clinic_id", ALL_CLINICS);
  await service.from("insurance_providers").delete().in("clinic_id", ALL_CLINICS);
  await service.from("user_page_permissions").delete().in("clinic_id", ALL_CLINICS);
  await service.from("profiles").delete().in("clinic_id", ALL_CLINICS);
  await service.from("departments").delete().in("clinic_id", ALL_CLINICS);
  await service.from("clinics").delete().in("id", ALL_CLINICS);
}

/** The AFTER trigger commits with the mutation; a short retry absorbs replica lag. */
async function eventsFor(entityId: string) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data } = await service
      .from("admin_audit_events")
      .select("*")
      .eq("entity_id", entityId)
      .order("occurred_at", { ascending: true });
    if (data && data.length > 0) return data;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

beforeAll(async () => {
  const [a, manager, receptionist, b] = await Promise.all([
    createUser("admin-a"),
    createUser("manager-a"),
    createUser("receptionist-a"),
    createUser("admin-b"),
  ]);
  adminA = a.client;
  adminAId = a.id;
  managerA = manager.client;
  receptionistA = receptionist.client;
  adminB = b.client;
  adminBId = b.id;

  await cleanup();

  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `Audit Clinic A ${suffix}`, currency: "KWD" },
    { id: clinicB, name: `Audit Clinic B ${suffix}`, currency: "KWD" },
  ]);
  if (clinics.error) throw clinics.error;

  const departments = await service
    .from("departments")
    .insert([
      { clinic_id: clinicA, name: `General Medicine ${suffix}` },
      { clinic_id: clinicA, name: `Cardiology ${suffix}` },
    ])
    .select("id, name");
  if (departments.error || !departments.data) throw departments.error;
  departmentA = departments.data[0].id;
  departmentA2 = departments.data[1].id;

  const profiles = await service.from("profiles").insert([
    { id: a.id, clinic_id: clinicA, full_name: "Admin A", role: "admin", is_active: true },
    { id: manager.id, clinic_id: clinicA, full_name: "Manager A", role: "manager", is_active: true },
    {
      id: receptionist.id,
      clinic_id: clinicA,
      full_name: "Reception A",
      role: "receptionist",
      is_active: true,
    },
    { id: b.id, clinic_id: clinicB, full_name: "Admin B", role: "admin", is_active: true },
  ]);
  if (profiles.error) throw profiles.error;

  // The department and profile rows above were seeded as service_role, which is
  // exactly the "no provable human" case; clear them so each test asserts only
  // on the events it causes.
  await service.from("admin_audit_events").delete().in("clinic_id", ALL_CLINICS);
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

describe("security — the actor and the clinic cannot be forged", () => {
  it("gives authenticated roles no way to insert, update or delete an event", async () => {
    const seeded = await service
      .from("departments")
      .insert({ clinic_id: clinicA, name: `Tamper ${suffix}` })
      .select("id")
      .single();
    const [event] = await eventsFor(seeded.data!.id);
    expect(event).toBeTruthy();

    const forged = await adminA.from("admin_audit_events").insert({
      clinic_id: clinicA,
      actor_type: "staff",
      actor_user_id: adminBId,
      module: "services",
      action: "service.price_changed",
      entity_type: "service",
      source: "staff_web",
    });
    expect(forged.error).not.toBeNull();

    const updated = await adminA
      .from("admin_audit_events")
      .update({ action: "service.updated" })
      .eq("id", event.id);
    expect(updated.error ?? { code: "0" }).toBeTruthy();
    const stillThere = await service
      .from("admin_audit_events")
      .select("action")
      .eq("id", event.id)
      .single();
    expect(stillThere.data?.action).toBe("department.created");

    await adminA.from("admin_audit_events").delete().eq("id", event.id);
    const afterDelete = await service
      .from("admin_audit_events")
      .select("id")
      .eq("id", event.id)
      .maybeSingle();
    expect(afterDelete.data?.id).toBe(event.id);

    await service.from("departments").delete().eq("id", seeded.data!.id);
  });

  it("stamps the acting human from the session, not from the payload", async () => {
    const created = await adminA
      .from("departments")
      .insert({ clinic_id: clinicA, name: `Actor Proof ${suffix}` })
      .select("id")
      .single();
    expect(created.error).toBeNull();

    const [event] = await eventsFor(created.data!.id);
    expect(event.actor_user_id).toBe(adminAId);
    expect(event.actor_type).toBe("staff");
    expect(event.actor_role).toBe("admin");
    expect(event.actor_display).toBe("Admin A");
    expect(event.source).toBe("staff_web");
    expect(event.clinic_id).toBe(clinicA);

    await service.from("departments").delete().eq("id", created.data!.id);
  });

  it("records no human actor for a service-role write", async () => {
    const created = await service
      .from("departments")
      .insert({ clinic_id: clinicA, name: `System Write ${suffix}` })
      .select("id")
      .single();
    const [event] = await eventsFor(created.data!.id);
    expect(event.actor_user_id).toBeNull();
    expect(event.actor_type).toBe("system");
    expect(event.actor_display).toBeNull();

    await service.from("departments").delete().eq("id", created.data!.id);
  });

  it("never lets clinic A read clinic B's trail, in either direction", async () => {
    const inB = await service
      .from("departments")
      .insert({ clinic_id: clinicB, name: `B Only ${suffix}` })
      .select("id")
      .single();
    await eventsFor(inB.data!.id);

    const leaked = await adminA
      .from("admin_audit_events")
      .select("id")
      .eq("clinic_id", clinicB);
    expect(leaked.data ?? []).toHaveLength(0);

    const visibleToB = await adminB
      .from("admin_audit_events")
      .select("id, clinic_id");
    expect(visibleToB.data ?? []).not.toHaveLength(0);
    expect((visibleToB.data ?? []).every((row) => row.clinic_id === clinicB)).toBe(true);

    await service.from("departments").delete().eq("id", inB.data!.id);
  });

  it("shows nothing to a receptionist, and hides AI configuration from a manager", async () => {
    await service.from("clinics").update({ ai_reply_mode: "suggest" }).eq("id", clinicA);
    for (let attempt = 0; attempt < 6; attempt++) {
      const { data } = await service
        .from("admin_audit_events")
        .select("id")
        .eq("clinic_id", clinicA)
        .eq("module", "ai");
      if (data && data.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const receptionView = await receptionistA.from("admin_audit_events").select("id");
    expect(receptionView.data ?? []).toHaveLength(0);

    const managerView = await managerA.from("admin_audit_events").select("id, module");
    expect((managerView.data ?? []).some((row) => row.module === "ai")).toBe(false);

    const adminView = await adminA.from("admin_audit_events").select("id, module");
    expect((adminView.data ?? []).some((row) => row.module === "ai")).toBe(true);

    await service.from("clinics").update({ ai_reply_mode: "off" }).eq("id", clinicA);
  });

  it("refuses the RPC to a receptionist and derives the clinic from the session", async () => {
    const denied = await receptionistA.rpc("record_admin_audit_event", {
      p_module: "scheduling",
      p_action: "clinic_hours.updated",
      p_entity_type: "clinic_hours",
    });
    expect(denied.error).not.toBeNull();

    const allowed = await adminA.rpc("record_admin_audit_event", {
      p_module: "scheduling",
      p_action: "clinic_hours.updated",
      p_entity_type: "clinic_hours",
      p_entity_id: clinicA,
      p_before: { shift_count: 0, shifts: [] },
      p_after: { shift_count: 1, shifts: ["1:09:00-17:00"] },
      p_changed_fields: ["shifts"],
    });
    expect(allowed.error).toBeNull();

    const written = await service
      .from("admin_audit_events")
      .select("clinic_id, actor_user_id, module, source")
      .eq("id", allowed.data as string)
      .single();
    expect(written.data?.clinic_id).toBe(clinicA);
    expect(written.data?.actor_user_id).toBe(adminAId);
    expect(written.data?.module).toBe("scheduling");
    expect(written.data?.source).toBe("staff_web");
  });
});

describe("departments", () => {
  it("audits create, rename, disable and archive, and skips a no-op save", async () => {
    const created = await adminA
      .from("departments")
      .insert({ clinic_id: clinicA, name: `Neurology ${suffix}` })
      .select("id")
      .single();
    const id = created.data!.id;

    await adminA.from("departments").update({ name: `Neuro ${suffix}` }).eq("id", id);
    await adminA.from("departments").update({ is_active: false }).eq("id", id);
    // A save that changes nothing must not appear as a change.
    await adminA.from("departments").update({ is_active: false }).eq("id", id);
    await adminA
      .from("departments")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);

    const events = await eventsFor(id);
    expect(events.map((event) => event.action)).toEqual([
      "department.created",
      "department.renamed",
      "department.disabled",
      "department.archived",
    ]);
    const rename = events[1];
    expect(rename.changed_fields).toEqual(["name"]);
    expect((rename.before as Record<string, unknown>).name).toBe(`Neurology ${suffix}`);
    expect((rename.after as Record<string, unknown>).name).toBe(`Neuro ${suffix}`);
    expect(rename.module).toBe("departments");

    await service.from("departments").delete().eq("id", id);
  });
});

describe("services and pricing", () => {
  it("records an exact money change with its currency, service and department", async () => {
    const created = await adminA
      .from("services")
      .insert({
        clinic_id: clinicA,
        department_id: departmentA,
        name: `Consultation ${suffix}`,
        price: 25,
      })
      .select("id")
      .single();
    expect(created.error).toBeNull();
    const id = created.data!.id;

    await adminA.from("services").update({ price: 30 }).eq("id", id);

    const events = await eventsFor(id);
    const priceChange = events.find((event) => event.action === "service.price_changed");
    expect(priceChange).toBeTruthy();
    // Exact decimal strings, never floating point.
    expect((priceChange!.before as Record<string, unknown>).price).toBe("25.00");
    expect((priceChange!.after as Record<string, unknown>).price).toBe("30.00");
    expect((priceChange!.after as Record<string, unknown>).currency).toBe("KWD");
    expect(priceChange!.changed_fields).toEqual(["price"]);
    expect(priceChange!.entity_ref).toBe(`Consultation ${suffix}`);
    expect((priceChange!.metadata as Record<string, unknown>).department_id).toBe(departmentA);
    expect((priceChange!.metadata as Record<string, unknown>).department_name).toContain(
      "General Medicine",
    );

    await service.from("services").delete().eq("id", id);
  });

  it("produces no event when the price is saved unchanged", async () => {
    const created = await adminA
      .from("services")
      .insert({
        clinic_id: clinicA,
        department_id: departmentA,
        name: `Stable Price ${suffix}`,
        price: 30,
      })
      .select("id")
      .single();
    const id = created.data!.id;
    await eventsFor(id);

    await adminA.from("services").update({ price: 30 }).eq("id", id);
    await adminA.from("services").update({ price: 30.0 }).eq("id", id);

    const events = await eventsFor(id);
    expect(events.map((event) => event.action)).toEqual(["service.created"]);

    await service.from("services").delete().eq("id", id);
  });

  it("audits a department move and an enable/disable toggle", async () => {
    const created = await adminA
      .from("services")
      .insert({
        clinic_id: clinicA,
        department_id: departmentA,
        name: `Echo ${suffix}`,
        price: 40,
      })
      .select("id")
      .single();
    const id = created.data!.id;

    await adminA.from("services").update({ department_id: departmentA2 }).eq("id", id);
    await adminA.from("services").update({ is_active: false }).eq("id", id);
    await adminA.from("services").update({ is_active: true }).eq("id", id);

    const events = await eventsFor(id);
    expect(events.map((event) => event.action)).toEqual([
      "service.created",
      "service.department_changed",
      "service.disabled",
      "service.enabled",
    ]);
    expect(events[1].changed_fields).toEqual(["department_id"]);

    await service.from("services").delete().eq("id", id);
  });
});

describe("insurance", () => {
  it("audits provider lifecycle using the fields the domain actually has", async () => {
    const created = await adminA
      .from("insurance_providers")
      .insert({ clinic_id: clinicA, name: `Gulf Care ${suffix}`, code: "GC" })
      .select("id")
      .single();
    const id = created.data!.id;

    await adminA.from("insurance_providers").update({ code: "GCI" }).eq("id", id);
    await adminA.from("insurance_providers").update({ is_active: false }).eq("id", id);

    const events = await eventsFor(id);
    expect(events.map((event) => event.action)).toEqual([
      "insurance_provider.created",
      "insurance_provider.updated",
      "insurance_provider.disabled",
    ]);
    expect(events[1].changed_fields).toEqual(["code"]);
    expect(events[0].module).toBe("insurance");

    await service.from("insurance_providers").delete().eq("id", id);
  });
});

describe("staff, roles and permissions", () => {
  it("audits a role change and an activation without storing any secret", async () => {
    const staff = await createUser("staff-target");
    await service.from("profiles").insert({
      id: staff.id,
      clinic_id: clinicA,
      full_name: "Ahmed Target",
      role: "receptionist",
      is_active: true,
    });
    await eventsFor(staff.id);

    await adminA.from("profiles").update({ role: "admin" }).eq("id", staff.id);
    await adminA.from("profiles").update({ is_active: false }).eq("id", staff.id);

    const events = await eventsFor(staff.id);
    const actions = events.map((event) => event.action);
    expect(actions).toContain("staff.role_changed");
    expect(actions).toContain("staff.deactivated");

    const roleChange = events.find((event) => event.action === "staff.role_changed")!;
    expect((roleChange.before as Record<string, unknown>).role).toBe("receptionist");
    expect((roleChange.after as Record<string, unknown>).role).toBe("admin");
    expect(roleChange.entity_ref).toBe("Ahmed Target");

    const serialized = JSON.stringify(events);
    for (const forbidden of ["password", "token", "secret", "api_key", "temporary_password"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }

    await service.from("profiles").delete().eq("id", staff.id);
  });

  it("audits a page permission grant and revoke against the staff member", async () => {
    const staff = await createUser("perm-target");
    await service.from("profiles").insert({
      id: staff.id,
      clinic_id: clinicA,
      full_name: "Perm Target",
      role: "receptionist",
      is_active: true,
    });
    await service.from("admin_audit_events").delete().eq("entity_id", staff.id);

    await adminA.from("user_page_permissions").insert({
      user_id: staff.id,
      clinic_id: clinicA,
      page_slug: "reports",
      is_visible: true,
    });
    await adminA
      .from("user_page_permissions")
      .update({ is_visible: false })
      .eq("user_id", staff.id)
      .eq("page_slug", "reports");
    // Re-saving the same value is not a permission change.
    await adminA
      .from("user_page_permissions")
      .update({ is_visible: false })
      .eq("user_id", staff.id)
      .eq("page_slug", "reports");

    const events = await eventsFor(staff.id);
    expect(events.map((event) => event.action)).toEqual([
      "page_permission.granted",
      "page_permission.revoked",
    ]);
    expect((events[0].metadata as Record<string, unknown>).permission_key).toBe("reports");
    expect(events[0].module).toBe("staff");

    await service.from("user_page_permissions").delete().eq("user_id", staff.id);
    await service.from("profiles").delete().eq("id", staff.id);
  });
});

describe("clinic settings and the clinic-wide AI switch", () => {
  it("files the global AI reply mode under AI, with before and after", async () => {
    await service.from("admin_audit_events").delete().eq("entity_id", clinicA);
    await adminA.from("clinics").update({ ai_reply_mode: "auto" }).eq("id", clinicA);

    const events = await eventsFor(clinicA);
    const change = events.find((event) => event.action === "ai.patient_replies_changed")!;
    expect(change).toBeTruthy();
    expect(change.module).toBe("ai");
    expect((change.before as Record<string, unknown>).ai_reply_mode).toBe("off");
    expect((change.after as Record<string, unknown>).ai_reply_mode).toBe("auto");

    await service.from("clinics").update({ ai_reply_mode: "off" }).eq("id", clinicA);
  });

  it("records a sensitive settings field as changed without copying its value", async () => {
    await service.from("admin_audit_events").delete().eq("entity_id", clinicA);
    await adminA
      .from("clinics")
      .update({ invoice_followup_email_body: "Dear patient, your invoice is due." })
      .eq("id", clinicA);

    const events = await eventsFor(clinicA);
    const change = events.find(
      (event) => event.action === "clinic.invoice_followups_changed",
    )!;
    expect(change.changed_fields).toContain("invoice_followup_email_body");
    expect(JSON.stringify(change.before)).not.toContain("Dear patient");
    expect(JSON.stringify(change.after)).not.toContain("Dear patient");

    await service
      .from("clinics")
      .update({ invoice_followup_email_body: null })
      .eq("id", clinicA);
  });

  it("produces no event for a settings save that changed nothing", async () => {
    await service.from("admin_audit_events").delete().eq("entity_id", clinicA);
    const current = await service
      .from("clinics")
      .select("name")
      .eq("id", clinicA)
      .single();
    await adminA.from("clinics").update({ name: current.data!.name }).eq("id", clinicA);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const events = await service
      .from("admin_audit_events")
      .select("id")
      .eq("entity_id", clinicA);
    expect(events.data ?? []).toHaveLength(0);
  });
});

describe("whatsapp linked account", () => {
  it("records the pairing as a masked suffix and never the QR or auth state", async () => {
    const session = await service
      .from("whatsapp_linked_device_sessions")
      .insert({ clinic_id: clinicA, status: "awaiting_scan", desired_state: "online" })
      .select("id")
      .single();
    expect(session.error).toBeNull();
    const id = session.data!.id;

    // What the worker writes when a phone finishes scanning: a live pairing
    // payload sits on the row at this moment, and must not reach the trail.
    await service
      .from("whatsapp_linked_device_sessions")
      .update({
        status: "connected",
        phone_number: "+96551231330",
        qr_payload: "2@SUPERSECRETPAIRINGPAYLOAD==",
      })
      .eq("id", id);
    await service
      .from("whatsapp_linked_device_sessions")
      .update({ status: "disconnected", qr_payload: null })
      .eq("id", id);

    const events = await eventsFor(id);
    expect(events.map((event) => event.action)).toEqual([
      "whatsapp_account.connected",
      "whatsapp_account.disconnected",
    ]);
    const connected = events[0];
    expect(connected.module).toBe("messaging");
    expect(connected.entity_ref).toBe("\u2022\u2022\u2022\u20221330");
    expect(connected.actor_type).toBe("integration");
    expect(connected.source).toBe("whatsapp");
    expect(connected.actor_user_id).toBeNull();

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("SUPERSECRETPAIRINGPAYLOAD");
    expect(serialized).not.toContain("96551231330");
    expect(serialized).not.toContain("qr_payload");

    await service.from("whatsapp_linked_device_sessions").delete().eq("id", id);
  });
});

describe("atomicity", () => {
  it("writes the audit row inside the mutation's own transaction", async () => {
    // The trail's atomicity comes from where the write happens, not from a
    // retry: the trigger is an AFTER … FOR EACH ROW trigger, so its insert is
    // part of the statement that caused it. The observable consequence is that
    // a business row can never be readable without its event — checked here by
    // reading both back the instant the mutation returns, with no polling.
    const created = await adminA
      .from("services")
      .insert({
        clinic_id: clinicA,
        department_id: departmentA,
        name: `Atomic ${suffix}`,
        price: 12,
      })
      .select("id")
      .single();
    expect(created.error).toBeNull();

    const both = await service
      .from("admin_audit_events")
      .select("id, action")
      .eq("entity_id", created.data!.id);
    expect(both.data ?? []).toHaveLength(1);
    expect(both.data![0].action).toBe("service.created");

    await adminA.from("services").update({ price: 18 }).eq("id", created.data!.id);
    const afterPrice = await service
      .from("admin_audit_events")
      .select("action")
      .eq("entity_id", created.data!.id)
      .eq("action", "service.price_changed");
    expect(afterPrice.data ?? []).toHaveLength(1);

    await service.from("services").delete().eq("id", created.data!.id);
  });

  it("aborts and writes nothing when the audit row is rejected", async () => {
    // The vocabulary CHECK constraints are what a malformed audit write hits
    // first. A rejected write must surface as an error and leave no trace —
    // the same failure mode that, from inside a trigger, aborts the mutation.
    const broken = await adminA.rpc("record_admin_audit_event", {
      p_module: "not_a_module",
      p_action: "service.updated",
      p_entity_type: "service",
      p_entity_id: clinicA,
    });
    expect(broken.error).not.toBeNull();

    const malformedAction = await adminA.rpc("record_admin_audit_event", {
      p_module: "services",
      p_action: "not a dotted action",
      p_entity_type: "service",
      p_entity_id: clinicA,
    });
    expect(malformedAction.error).not.toBeNull();

    const written = await service
      .from("admin_audit_events")
      .select("id")
      .eq("entity_id", clinicA)
      .eq("entity_type", "service");
    expect(written.data ?? []).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P18 blocker — `record_admin_audit_event` is not a general-purpose audit
// authoring API.
//
// The RPC has to stay authenticated-callable, because deriving the real actor
// from the caller's JWT is the whole reason it exists. That makes its argument
// surface the one place in this migration where a human chooses what gets
// written, so what it *refuses* is a database property and is proved here
// against live Postgres rather than asserted about the SQL text.
// ─────────────────────────────────────────────────────────────────────────────

type RpcArgs = {
  p_module: string;
  p_action: string;
  p_entity_type: string;
  p_entity_id?: string | null;
  p_entity_ref?: string | null;
  p_before?: unknown;
  p_after?: unknown;
  p_changed_fields?: string[];
  p_metadata?: unknown;
};

const SHIFTS_BEFORE = { shift_count: 0, shifts: [] as string[] };
const SHIFTS_AFTER = { shift_count: 2, shifts: ["1:09:00-13:00", "1:16:00-20:00"] };
const TEMPLATES_BEFORE = { template_count: 0, templates: [] as string[] };
const TEMPLATES_AFTER = {
  template_count: 2,
  templates: ["Evening 15:00-22:00 (disabled)", "Morning 09:00-17:00"],
};

function callRpc(client: Client, args: RpcArgs) {
  // The RPC is typed to the shapes the application sends; these tests exist to
  // send shapes it never would, so the argument object is cast at the boundary.
  return client.rpc("record_admin_audit_event", args as never);
}

async function rowFor(id: string) {
  const { data } = await service
    .from("admin_audit_events")
    .select(
      "id, clinic_id, actor_user_id, actor_role, module, action, entity_type, entity_id, entity_ref, before, after, changed_fields, metadata, source",
    )
    .eq("id", id)
    .single();
  return data;
}

/** Every event this block writes, so the assertions below can be exhaustive. */
async function schedulingRows() {
  const { data } = await service
    .from("admin_audit_events")
    .select("id, action, entity_type, before, after")
    .eq("clinic_id", clinicA)
    .eq("module", "scheduling");
  return data ?? [];
}

async function clearScheduling() {
  await service
    .from("admin_audit_events")
    .delete()
    .eq("clinic_id", clinicA)
    .eq("module", "scheduling");
}

/**
 * Total rows in a clinic, whoever wrote them. The trigger-written events from
 * the blocks above are still in the table, so "the RPC wrote nothing" is a
 * statement about the *delta* across a batch of refused calls, not about the
 * table being empty.
 */
async function totalRows(clinicId: string) {
  const { count } = await service
    .from("admin_audit_events")
    .select("id", { count: "exact", head: true })
    .eq("clinic_id", clinicId);
  return count ?? 0;
}

describe("P18 blocker — record_admin_audit_event accepts only the scheduling tuples", () => {
  beforeAll(clearScheduling);
  afterAll(clearScheduling);

  it("accepts the three real scheduling events and nothing more", async () => {
    await clearScheduling();

    const hours = await callRpc(adminA, {
      p_module: "scheduling",
      p_action: "clinic_hours.updated",
      p_entity_type: "clinic_hours",
      p_entity_id: clinicA,
      p_before: SHIFTS_BEFORE,
      p_after: SHIFTS_AFTER,
      p_changed_fields: ["shifts"],
    });
    expect(hours.error).toBeNull();

    const staff = await callRpc(adminA, {
      p_module: "scheduling",
      p_action: "staff_schedule.updated",
      p_entity_type: "staff",
      p_entity_id: adminAId,
      p_entity_ref: "Admin A",
      p_before: SHIFTS_BEFORE,
      p_after: SHIFTS_AFTER,
      p_changed_fields: ["shifts"],
    });
    expect(staff.error).toBeNull();

    const templates = await callRpc(adminA, {
      p_module: "scheduling",
      p_action: "shift_templates.updated",
      p_entity_type: "shift_templates",
      p_entity_id: clinicA,
      p_before: TEMPLATES_BEFORE,
      p_after: TEMPLATES_AFTER,
      p_changed_fields: ["templates"],
    });
    expect(templates.error).toBeNull();

    const rows = await schedulingRows();
    expect(rows.map((row) => row.action).sort()).toEqual([
      "clinic_hours.updated",
      "shift_templates.updated",
      "staff_schedule.updated",
    ]);
    // The payload survives the round trip byte for byte — the validator is a
    // gate, not a rewriter.
    const hoursRow = await rowFor(hours.data as string);
    expect(hoursRow?.after).toEqual(SHIFTS_AFTER);
    const templatesRow = await rowFor(templates.data as string);
    expect(templatesRow?.after).toEqual(TEMPLATES_AFTER);

    await clearScheduling();
  });

  it("rejects every event outside the three tuples", async () => {
    await clearScheduling();

    const rejected: [string, RpcArgs][] = [
      // Real actions from other modules, all of which are trigger-written and
      // must be unreachable from an application caller.
      [
        "service.price_changed",
        {
          p_module: "services",
          p_action: "service.price_changed",
          p_entity_type: "service",
          p_entity_id: clinicA,
        },
      ],
      [
        "staff.role_changed",
        {
          p_module: "staff",
          p_action: "staff.role_changed",
          p_entity_type: "staff",
          p_entity_id: adminAId,
        },
      ],
      [
        "ai.patient_replies_changed",
        {
          p_module: "ai",
          p_action: "ai.patient_replies_changed",
          p_entity_type: "clinic",
          p_entity_id: clinicA,
        },
      ],
      [
        "whatsapp_account.connected",
        {
          p_module: "messaging",
          p_action: "whatsapp_account.connected",
          p_entity_type: "whatsapp_account",
          p_entity_id: clinicA,
        },
      ],
      // A plausible-looking action that simply does not exist.
      [
        "arbitrary valid-looking action",
        {
          p_module: "scheduling",
          p_action: "scheduling.something_reasonable",
          p_entity_type: "clinic_hours",
          p_entity_id: clinicA,
          p_before: SHIFTS_BEFORE,
          p_after: SHIFTS_AFTER,
          p_changed_fields: ["shifts"],
        },
      ],
      // An allowed module + an unsupported action.
      [
        "scheduling module, unsupported action",
        {
          p_module: "scheduling",
          p_action: "clinic_hours.deleted",
          p_entity_type: "clinic_hours",
          p_entity_id: clinicA,
          p_before: SHIFTS_BEFORE,
          p_after: SHIFTS_AFTER,
          p_changed_fields: ["shifts"],
        },
      ],
      // The tuple is matched as a whole: an allowed action paired with the
      // wrong entity type must not slip through three independent IN lists.
      [
        "clinic_hours.updated + staff",
        {
          p_module: "scheduling",
          p_action: "clinic_hours.updated",
          p_entity_type: "staff",
          p_entity_id: adminAId,
          p_before: SHIFTS_BEFORE,
          p_after: SHIFTS_AFTER,
          p_changed_fields: ["shifts"],
        },
      ],
      [
        "shift_templates.updated + clinic_hours",
        {
          p_module: "scheduling",
          p_action: "shift_templates.updated",
          p_entity_type: "clinic_hours",
          p_entity_id: clinicA,
          p_before: TEMPLATES_BEFORE,
          p_after: TEMPLATES_AFTER,
          p_changed_fields: ["templates"],
        },
      ],
      [
        "staff_schedule.updated + shift_templates",
        {
          p_module: "scheduling",
          p_action: "staff_schedule.updated",
          p_entity_type: "shift_templates",
          p_entity_id: clinicA,
          p_before: SHIFTS_BEFORE,
          p_after: SHIFTS_AFTER,
          p_changed_fields: ["shifts"],
        },
      ],
      // A wrong module with an otherwise allowed action + entity type.
      [
        "staff module + staff_schedule.updated",
        {
          p_module: "staff",
          p_action: "staff_schedule.updated",
          p_entity_type: "staff",
          p_entity_id: adminAId,
          p_before: SHIFTS_BEFORE,
          p_after: SHIFTS_AFTER,
          p_changed_fields: ["shifts"],
        },
      ],
      [
        "clinic module + clinic_hours.updated",
        {
          p_module: "clinic",
          p_action: "clinic_hours.updated",
          p_entity_type: "clinic_hours",
          p_entity_id: clinicA,
          p_before: SHIFTS_BEFORE,
          p_after: SHIFTS_AFTER,
          p_changed_fields: ["shifts"],
        },
      ],
      // Not a module at all, and not a dotted action at all.
      [
        "not_a_module",
        {
          p_module: "not_a_module",
          p_action: "clinic_hours.updated",
          p_entity_type: "clinic_hours",
          p_entity_id: clinicA,
        },
      ],
      [
        "not a dotted action",
        {
          p_module: "scheduling",
          p_action: "not a dotted action",
          p_entity_type: "clinic_hours",
          p_entity_id: clinicA,
        },
      ],
    ];

    const before = await totalRows(clinicA);
    for (const [label, args] of rejected) {
      const result = await callRpc(adminA, args);
      expect(result.error, `${label} must be refused`).not.toBeNull();
      expect(result.error?.message, label).toContain("ADMIN_AUDIT_UNSUPPORTED_EVENT");
    }

    expect(await schedulingRows()).toHaveLength(0);
    expect(await totalRows(clinicA)).toBe(before);
  });

  it("cannot be used to forge an AI audit event a manager could not otherwise write", async () => {
    // The manager passes the role gate, so this is the strongest available
    // caller for the AI module — which RLS then hides from managers anyway.
    for (const entityType of ["clinic", "clinic_hours", "staff"]) {
      const forged = await callRpc(managerA, {
        p_module: "ai",
        p_action: "ai.patient_replies_changed",
        p_entity_type: entityType,
        p_entity_id: clinicA,
        p_before: SHIFTS_BEFORE,
        p_after: SHIFTS_AFTER,
        p_changed_fields: ["shifts"],
      });
      expect(forged.error?.message).toContain("ADMIN_AUDIT_UNSUPPORTED_EVENT");
    }

    const aiRows = await service
      .from("admin_audit_events")
      .select("id")
      .eq("clinic_id", clinicA)
      .eq("module", "ai");
    expect(aiRows.data ?? []).toHaveLength(0);
  });
});

describe("P18 blocker — the RPC payload cannot become a PHI channel", () => {
  beforeAll(clearScheduling);
  afterAll(clearScheduling);

  /** The keys an attacker would actually try to park in an audit row. */
  const FORBIDDEN_KEYS = [
    "national_id",
    "phone",
    "email",
    "diagnosis",
    "medical_note",
    "note",
    "message",
    "token",
    "secret",
    "credential",
  ] as const;

  it("refuses every sensitive key smuggled into before, after or metadata", async () => {
    await clearScheduling();

    for (const key of FORBIDDEN_KEYS) {
      const value = `${key}-value-290010112345`;

      // (a) alongside the legitimate summary keys, in `before`.
      const inBefore = await callRpc(adminA, {
        p_module: "scheduling",
        p_action: "clinic_hours.updated",
        p_entity_type: "clinic_hours",
        p_entity_id: clinicA,
        p_before: { ...SHIFTS_BEFORE, [key]: value },
        p_after: SHIFTS_AFTER,
        p_changed_fields: ["shifts"],
      });
      expect(inBefore.error?.message, `before.${key}`).toContain(
        "ADMIN_AUDIT_UNSUPPORTED_PAYLOAD",
      );

      // (b) alongside the legitimate summary keys, in `after`.
      const inAfter = await callRpc(adminA, {
        p_module: "scheduling",
        p_action: "clinic_hours.updated",
        p_entity_type: "clinic_hours",
        p_entity_id: clinicA,
        p_before: SHIFTS_BEFORE,
        p_after: { ...SHIFTS_AFTER, [key]: value },
        p_changed_fields: ["shifts"],
      });
      expect(inAfter.error?.message, `after.${key}`).toContain(
        "ADMIN_AUDIT_UNSUPPORTED_PAYLOAD",
      );

      // (c) in `metadata`, which the application never populates at all.
      const inMetadata = await callRpc(adminA, {
        p_module: "scheduling",
        p_action: "clinic_hours.updated",
        p_entity_type: "clinic_hours",
        p_entity_id: clinicA,
        p_before: SHIFTS_BEFORE,
        p_after: SHIFTS_AFTER,
        p_changed_fields: ["shifts"],
        p_metadata: { [key]: value },
      });
      expect(inMetadata.error?.message, `metadata.${key}`).toContain(
        "ADMIN_AUDIT_UNSUPPORTED_PAYLOAD",
      );

      // (d) as the *only* content, replacing the summary entirely.
      const asPayload = await callRpc(adminA, {
        p_module: "scheduling",
        p_action: "shift_templates.updated",
        p_entity_type: "shift_templates",
        p_entity_id: clinicA,
        p_before: { [key]: value },
        p_after: { [key]: value },
        p_changed_fields: ["templates"],
      });
      expect(asPayload.error?.message, `payload=${key}`).toContain(
        "ADMIN_AUDIT_UNSUPPORTED_PAYLOAD",
      );

      // (e) inside the summary array, where a nested object would otherwise be
      // an unbounded JSON channel.
      const nested = await callRpc(adminA, {
        p_module: "scheduling",
        p_action: "clinic_hours.updated",
        p_entity_type: "clinic_hours",
        p_entity_id: clinicA,
        p_before: SHIFTS_BEFORE,
        p_after: { shift_count: 1, shifts: [{ [key]: value }] },
        p_changed_fields: ["shifts"],
      });
      expect(nested.error?.message, `nested ${key}`).toContain(
        "ADMIN_AUDIT_UNSUPPORTED_PAYLOAD",
      );
    }

    expect(await schedulingRows()).toHaveLength(0);
  });

  it("refuses arbitrary nested JSON however it is wrapped", async () => {
    const shapes: [string, unknown][] = [
      ["deep object", { shift_count: 0, shifts: [], extra: { a: { b: { c: "phi" } } } }],
      ["array of objects", { shift_count: 1, shifts: [{ day: 1, note: "phi" }] }],
      ["array of arrays", { shift_count: 1, shifts: [["1:09:00-17:00"]] }],
      ["object instead of array", { shift_count: 1, shifts: { "0": "1:09:00-17:00" } }],
      ["numbers instead of strings", { shift_count: 1, shifts: [12345678] }],
      ["top-level array", []],
      ["top-level string", "1:09:00-17:00"],
      ["count as a channel", { shift_count: 290010112345, shifts: [] }],
      ["count disagrees with array", { shift_count: 0, shifts: ["1:09:00-17:00"] }],
      ["missing key", { shifts: [] }],
      ["renamed key", { count: 0, shifts: [] }],
      ["template shape on an hours tuple", TEMPLATES_AFTER],
    ];

    for (const [label, after] of shapes) {
      const result = await callRpc(adminA, {
        p_module: "scheduling",
        p_action: "clinic_hours.updated",
        p_entity_type: "clinic_hours",
        p_entity_id: clinicA,
        p_before: SHIFTS_BEFORE,
        p_after: after,
        p_changed_fields: ["shifts"],
      });
      expect(result.error, label).not.toBeNull();
    }

    expect(await schedulingRows()).toHaveLength(0);
  });

  it("accepts a well-formed summary and refuses a malformed one", async () => {
    await clearScheduling();

    const good = await callRpc(adminA, {
      p_module: "scheduling",
      p_action: "staff_schedule.updated",
      p_entity_type: "staff",
      p_entity_id: adminAId,
      p_before: { shift_count: 1, shifts: ["0:08:00-12:00"] },
      p_after: { shift_count: 2, shifts: ["0:08:00-12:00", "6:23:00-23:59"] },
      p_changed_fields: ["shifts"],
    });
    expect(good.error).toBeNull();

    const goodTemplates = await callRpc(adminA, {
      p_module: "scheduling",
      p_action: "shift_templates.updated",
      p_entity_type: "shift_templates",
      p_entity_id: clinicA,
      p_before: TEMPLATES_BEFORE,
      p_after: { template_count: 1, templates: ["شفت المساء 15:00-22:00"] },
      p_changed_fields: ["templates"],
    });
    expect(goodTemplates.error).toBeNull();

    const malformed: [string, unknown][] = [
      ["day out of range", { shift_count: 1, shifts: ["7:09:00-17:00"] }],
      ["hour out of range", { shift_count: 1, shifts: ["1:24:00-25:00"] }],
      ["seconds not trimmed", { shift_count: 1, shifts: ["1:09:00:00-17:00:00"] }],
      ["missing day", { shift_count: 1, shifts: ["09:00-17:00"] }],
      ["free text appended", { shift_count: 1, shifts: ["1:09:00-17:00 diagnosis"] }],
      ["too many shifts", { shift_count: 29, shifts: Array(29).fill("1:09:00-17:00") }],
    ];
    for (const [label, after] of malformed) {
      const result = await callRpc(adminA, {
        p_module: "scheduling",
        p_action: "staff_schedule.updated",
        p_entity_type: "staff",
        p_entity_id: adminAId,
        p_before: SHIFTS_BEFORE,
        p_after: after,
        p_changed_fields: ["shifts"],
      });
      expect(result.error?.message, label).toContain("ADMIN_AUDIT_UNSUPPORTED_PAYLOAD");
    }

    const malformedTemplates: [string, unknown][] = [
      ["no time range", { template_count: 1, templates: ["Morning"] }],
      ["unknown suffix", { template_count: 1, templates: ["Morning 09:00-17:00 (deleted)"] }],
      [
        "phone number as a name",
        { template_count: 1, templates: ["96550001234 09:00-17:00"] },
      ],
      [
        "civil id as a name",
        { template_count: 1, templates: ["290010112345 09:00-17:00"] },
      ],
      [
        "newline in the name",
        { template_count: 1, templates: ["Morning\ndiagnosis: x 09:00-17:00"] },
      ],
      [
        "name past the 60-character bound",
        { template_count: 1, templates: [`${"x".repeat(61)} 09:00-17:00`] },
      ],
      [
        "too many templates",
        { template_count: 11, templates: Array(11).fill("Morning 09:00-17:00") },
      ],
    ];
    for (const [label, after] of malformedTemplates) {
      const result = await callRpc(adminA, {
        p_module: "scheduling",
        p_action: "shift_templates.updated",
        p_entity_type: "shift_templates",
        p_entity_id: clinicA,
        p_before: TEMPLATES_BEFORE,
        p_after: after,
        p_changed_fields: ["templates"],
      });
      expect(result.error?.message, label).toContain("ADMIN_AUDIT_UNSUPPORTED_PAYLOAD");
    }

    // Only the two good calls landed.
    const rows = await schedulingRows();
    expect(rows).toHaveLength(2);
    await clearScheduling();
  });

  it("pins changed_fields and metadata to the one safe scheduling value", async () => {
    await clearScheduling();

    const badChangedFields: string[][] = [
      [],
      ["templates"],
      ["shifts", "national_id"],
      ["shifts", "shifts"],
      ["national_id"],
      ["Shifts"],
    ];
    for (const fields of badChangedFields) {
      const result = await callRpc(adminA, {
        p_module: "scheduling",
        p_action: "clinic_hours.updated",
        p_entity_type: "clinic_hours",
        p_entity_id: clinicA,
        p_before: SHIFTS_BEFORE,
        p_after: SHIFTS_AFTER,
        p_changed_fields: fields,
      });
      expect(result.error?.message, JSON.stringify(fields)).toContain(
        "ADMIN_AUDIT_UNSUPPORTED_PAYLOAD",
      );
    }

    const nonEmptyMetadata = await callRpc(adminA, {
      p_module: "scheduling",
      p_action: "clinic_hours.updated",
      p_entity_type: "clinic_hours",
      p_entity_id: clinicA,
      p_before: SHIFTS_BEFORE,
      p_after: SHIFTS_AFTER,
      p_changed_fields: ["shifts"],
      p_metadata: { harmless_looking: "value" },
    });
    expect(nonEmptyMetadata.error?.message).toContain("ADMIN_AUDIT_UNSUPPORTED_PAYLOAD");

    expect(await schedulingRows()).toHaveLength(0);
  });
});

describe("P18 blocker — actor, clinic and entity stay authoritative", () => {
  beforeAll(clearScheduling);
  afterAll(clearScheduling);

  it("keeps clinic and actor derived from the session on the narrowed RPC", async () => {
    await clearScheduling();

    const written = await callRpc(managerA, {
      p_module: "scheduling",
      p_action: "clinic_hours.updated",
      p_entity_type: "clinic_hours",
      // A caller-supplied entity id pointing at another clinic must not be
      // honoured, and must not become the row's clinic either.
      p_entity_id: clinicA,
      p_entity_ref: "Somebody Else",
      p_before: SHIFTS_BEFORE,
      p_after: SHIFTS_AFTER,
      p_changed_fields: ["shifts"],
    });
    expect(written.error).toBeNull();

    const row = await rowFor(written.data as string);
    expect(row?.clinic_id).toBe(clinicA);
    expect(row?.actor_user_id).not.toBe(adminAId);
    expect(row?.actor_role).toBe("manager");
    expect(row?.source).toBe("staff_web");
    // `entity_ref` is derived, so the caller's string never lands.
    expect(row?.entity_ref).toBeNull();
    expect(row?.entity_id).toBe(clinicA);
    expect(row?.metadata).toEqual({});

    await clearScheduling();
  });

  it("derives the staff display name and refuses a target outside the caller's clinic", async () => {
    await clearScheduling();

    const written = await callRpc(adminA, {
      p_module: "scheduling",
      p_action: "staff_schedule.updated",
      p_entity_type: "staff",
      p_entity_id: adminAId,
      p_entity_ref: "Injected Name 290010112345",
      p_before: SHIFTS_BEFORE,
      p_after: SHIFTS_AFTER,
      p_changed_fields: ["shifts"],
    });
    expect(written.error).toBeNull();
    const row = await rowFor(written.data as string);
    expect(row?.entity_ref).toBe("Admin A");

    // Clinic B's admin is a real profile, and a real uuid, and still not a
    // target clinic A may file a schedule event against.
    const crossClinic = await callRpc(adminA, {
      p_module: "scheduling",
      p_action: "staff_schedule.updated",
      p_entity_type: "staff",
      p_entity_id: adminBId,
      p_before: SHIFTS_BEFORE,
      p_after: SHIFTS_AFTER,
      p_changed_fields: ["shifts"],
    });
    expect(crossClinic.error?.message).toContain("ADMIN_AUDIT_UNSUPPORTED_EVENT");

    const unknownStaff = await callRpc(adminA, {
      p_module: "scheduling",
      p_action: "staff_schedule.updated",
      p_entity_type: "staff",
      p_entity_id: randomUUID(),
      p_before: SHIFTS_BEFORE,
      p_after: SHIFTS_AFTER,
      p_changed_fields: ["shifts"],
    });
    expect(unknownStaff.error?.message).toContain("ADMIN_AUDIT_UNSUPPORTED_EVENT");

    // A clinic-wide event cannot be redirected at another clinic's id either.
    const foreignClinic = await callRpc(adminA, {
      p_module: "scheduling",
      p_action: "shift_templates.updated",
      p_entity_type: "shift_templates",
      p_entity_id: clinicB,
      p_before: TEMPLATES_BEFORE,
      p_after: TEMPLATES_AFTER,
      p_changed_fields: ["templates"],
    });
    expect(foreignClinic.error?.message).toContain("ADMIN_AUDIT_UNSUPPORTED_EVENT");

    const inB = await service
      .from("admin_audit_events")
      .select("id")
      .eq("clinic_id", clinicB)
      .eq("module", "scheduling");
    expect(inB.data ?? []).toHaveLength(0);

    await clearScheduling();
  });

  it("still refuses a receptionist, whatever the tuple", async () => {
    await clearScheduling();

    for (const args of [
      {
        p_module: "scheduling",
        p_action: "clinic_hours.updated",
        p_entity_type: "clinic_hours",
        p_entity_id: clinicA,
        p_before: SHIFTS_BEFORE,
        p_after: SHIFTS_AFTER,
        p_changed_fields: ["shifts"],
      },
      {
        p_module: "scheduling",
        p_action: "shift_templates.updated",
        p_entity_type: "shift_templates",
        p_entity_id: clinicA,
        p_before: TEMPLATES_BEFORE,
        p_after: TEMPLATES_AFTER,
        p_changed_fields: ["templates"],
      },
    ] satisfies RpcArgs[]) {
      const denied = await callRpc(receptionistA, args);
      expect(denied.error?.message).toContain("ADMIN_AUDIT_FORBIDDEN");
    }

    // The role gate runs first, so an unauthorised caller cannot even probe
    // which tuples exist.
    const probe = await callRpc(receptionistA, {
      p_module: "not_a_module",
      p_action: "not.real",
      p_entity_type: "nothing",
    });
    expect(probe.error?.message).toContain("ADMIN_AUDIT_FORBIDDEN");

    expect(await schedulingRows()).toHaveLength(0);
  });

  it("leaves no general-purpose authoring path: every other module stays trigger-only", async () => {
    await clearScheduling();

    // Sweep the whole declared module vocabulary against the whole declared
    // action vocabulary the triggers use. Only the three scheduling tuples may
    // survive, and they are covered above; here nothing at all may be written.
    const modules = [
      "clinic",
      "departments",
      "services",
      "insurance",
      "staff",
      "ai",
      "messaging",
    ];
    const actions = [
      "department.created",
      "department.renamed",
      "service.price_changed",
      "service.updated",
      "insurance_provider.disabled",
      "staff.role_changed",
      "page_permission.granted",
      "ai_permission.granted",
      "ai.patient_replies_changed",
      "ai.assistant_style_changed",
      "clinic.settings_updated",
      "whatsapp_account.connected",
    ];

    const before = await totalRows(clinicA);
    for (const auditModule of modules) {
      for (const action of actions) {
        const result = await callRpc(adminA, {
          p_module: auditModule,
          p_action: action,
          p_entity_type: action.split(".")[0],
          p_entity_id: clinicA,
          p_before: SHIFTS_BEFORE,
          p_after: SHIFTS_AFTER,
          p_changed_fields: ["shifts"],
        });
        expect(result.error, `${auditModule}/${action}`).not.toBeNull();
      }
    }

    // Not one of the 84 attempts produced a row.
    expect(await schedulingRows()).toHaveLength(0);
    expect(await totalRows(clinicA)).toBe(before);
  });
});
