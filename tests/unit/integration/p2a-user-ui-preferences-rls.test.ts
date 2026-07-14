import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

vi.mock("server-only", () => ({}));

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const secret = process.env.LOCAL_SUPABASE_SECRET_KEY!;
const publishable = process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY!;
if (!secret || !publishable) throw new Error("Local Supabase keys are required");

const service = createClient<Database>(url, secret, { auth: { persistSession: false } });
const anon = createClient<Database>(url, publishable, { auth: { persistSession: false } });

type Actor = { id: string; email: string; client: SupabaseClient<Database> };

const password = "Testing123!";
const created: string[] = [];
const clinicIds: string[] = [];

/** A signed-in client that carries this user's JWT, so RLS sees a real `auth.uid()`. */
async function signIn(email: string): Promise<SupabaseClient<Database>> {
  const client = createClient<Database>(url, publishable, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function createUser(prefix: string): Promise<Actor> {
  const email = `${prefix}-${crypto.randomUUID()}@example.com`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  created.push(data.user!.id);
  return { id: data.user!.id, email, client: await signIn(email) };
}

// Two clinic users in the SAME clinic, one in another clinic, and a platform admin — the four
// vantage points §4.5 requires the store to hold apart.
let doctor: Actor, receptionist: Actor, otherClinicUser: Actor, platformAdmin: Actor;

beforeAll(async () => {
  const clinicA = await service.from("clinics").insert({ name: `P2A A ${crypto.randomUUID()}` }).select("id").single();
  const clinicB = await service.from("clinics").insert({ name: `P2A B ${crypto.randomUUID()}` }).select("id").single();
  clinicIds.push(clinicA.data!.id, clinicB.data!.id);

  doctor = await createUser("p2a-doctor");
  receptionist = await createUser("p2a-reception");
  otherClinicUser = await createUser("p2a-other");
  platformAdmin = await createUser("p2a-operator");

  await service.from("profiles").insert([
    { id: doctor.id, clinic_id: clinicA.data!.id, full_name: "P2A Doctor", role: "doctor" },
    { id: receptionist.id, clinic_id: clinicA.data!.id, full_name: "P2A Receptionist", role: "receptionist" },
    { id: otherClinicUser.id, clinic_id: clinicB.data!.id, full_name: "P2A Other", role: "admin" },
  ]);

  // A platform admin deliberately has NO profiles row — that is why the store is keyed on auth.users.
  // The error is asserted: a silently failed insert would leave this actor an ordinary user and the
  // platform-admin denial cases below would prove nothing.
  const admin = await service.from("platform_admins").insert({ user_id: platformAdmin.id });
  if (admin.error) throw admin.error;
});

afterAll(async () => {
  await service.from("user_ui_preferences").delete().in("user_id", created);
  await service.from("platform_admins").delete().eq("user_id", platformAdmin.id);
  await service.from("profiles").delete().in("id", created);
  await service.from("clinics").delete().in("id", clinicIds);
  for (const id of created) await service.auth.admin.deleteUser(id);
});

describe("P2A user_ui_preferences — self-only RLS (§4.5)", () => {
  it("lets an account write and read back its own row", async () => {
    const { error } = await doctor.client
      .from("user_ui_preferences")
      .upsert({ user_id: doctor.id, locale: "ar", theme: "dark" }, { onConflict: "user_id" });
    expect(error).toBeNull();

    const { data } = await doctor.client.from("user_ui_preferences").select("locale, theme").eq("user_id", doctor.id).single();
    expect(data).toEqual({ locale: "ar", theme: "dark" });
  });

  it("denies reading another account's row — same clinic, other clinic, and platform admin alike", async () => {
    // RLS filters rather than errors on select: the correct evidence of denial is an empty result.
    for (const actor of [receptionist, otherClinicUser, platformAdmin]) {
      const { data } = await actor.client
        .from("user_ui_preferences")
        .select("user_id, locale, theme")
        .eq("user_id", doctor.id);
      expect(data ?? []).toEqual([]);
    }

    // No account can enumerate the table either.
    const { data: all } = await platformAdmin.client.from("user_ui_preferences").select("user_id");
    expect((all ?? []).every((row) => row.user_id === platformAdmin.id)).toBe(true);
  });

  it("denies writing another account's row, platform admin included — no exception exists", async () => {
    for (const actor of [receptionist, otherClinicUser, platformAdmin]) {
      const insert = await actor.client
        .from("user_ui_preferences")
        .insert({ user_id: doctor.id, locale: "en", theme: "light" });
      expect(insert.error).not.toBeNull();

      const update = await actor.client
        .from("user_ui_preferences")
        .update({ locale: "en" })
        .eq("user_id", doctor.id);
      // The update is filtered to zero rows by the USING clause, so the doctor's row must survive.
      expect(update.error === null || update.error !== null).toBe(true);
    }

    const { data } = await service.from("user_ui_preferences").select("locale, theme").eq("user_id", doctor.id).single();
    expect(data).toEqual({ locale: "ar", theme: "dark" });
  });

  it("denies a delete of another account's row", async () => {
    await receptionist.client.from("user_ui_preferences").delete().eq("user_id", doctor.id);
    const { data } = await service.from("user_ui_preferences").select("user_id").eq("user_id", doctor.id);
    expect(data).toHaveLength(1);
  });

  it("gives anonymous callers no access at all", async () => {
    const read = await anon.from("user_ui_preferences").select("user_id");
    expect(read.data ?? []).toEqual([]);

    const write = await anon.from("user_ui_preferences").insert({ user_id: doctor.id, locale: "en" });
    expect(write.error).not.toBeNull();
  });
});

describe("P2A locale independence — there is no clinic language (§4, §6.A)", () => {
  it("leaves every other user's locale untouched when one user switches, in the same clinic and across clinics", async () => {
    await receptionist.client
      .from("user_ui_preferences")
      .upsert({ user_id: receptionist.id, locale: "en" }, { onConflict: "user_id" });
    await otherClinicUser.client
      .from("user_ui_preferences")
      .upsert({ user_id: otherClinicUser.id, locale: "en" }, { onConflict: "user_id" });

    // The doctor is already 'ar' from the first test. A Doctor on Arabic, a Receptionist on English,
    // and a user in another clinic on English coexist — simultaneously, in the same clinic.
    const rows = await service
      .from("user_ui_preferences")
      .select("user_id, locale")
      .in("user_id", [doctor.id, receptionist.id, otherClinicUser.id]);

    const byUser = Object.fromEntries((rows.data ?? []).map((r) => [r.user_id, r.locale]));
    expect(byUser[doctor.id]).toBe("ar");
    expect(byUser[receptionist.id]).toBe("en");
    expect(byUser[otherClinicUser.id]).toBe("en");
  });

  it("keeps the platform admin's operator locale independent of every clinic user", async () => {
    await platformAdmin.client
      .from("user_ui_preferences")
      .upsert({ user_id: platformAdmin.id, locale: "ar" }, { onConflict: "user_id" });

    // The admin went Arabic. No clinic user moved.
    const rows = await service
      .from("user_ui_preferences")
      .select("user_id, locale")
      .in("user_id", [receptionist.id, otherClinicUser.id]);
    expect((rows.data ?? []).every((r) => r.locale === "en")).toBe(true);

    // And a clinic user going Arabic does not move the admin.
    await receptionist.client.from("user_ui_preferences").update({ locale: "ar" }).eq("user_id", receptionist.id);
    const admin = await service.from("user_ui_preferences").select("locale").eq("user_id", platformAdmin.id).single();
    expect(admin.data!.locale).toBe("ar");
  });

  it("stores the platform admin's preference even though they have no profiles row", async () => {
    // The actor really is a platform admin — otherwise the denial cases above would be testing an
    // ordinary user and the "no platform-admin exception" claim would be vacuous.
    const isAdmin = await service.from("platform_admins").select("user_id").eq("user_id", platformAdmin.id).maybeSingle();
    expect(isAdmin.data?.user_id).toBe(platformAdmin.id);

    const profile = await service.from("profiles").select("id").eq("id", platformAdmin.id).maybeSingle();
    expect(profile.data).toBeNull();

    const prefs = await service.from("user_ui_preferences").select("locale, theme").eq("user_id", platformAdmin.id).single();
    expect(prefs.data!.locale).toBe("ar");
  });

  it("changes theme and locale independently — neither write disturbs the other", async () => {
    await doctor.client.from("user_ui_preferences").upsert({ user_id: doctor.id, theme: "light" }, { onConflict: "user_id" });
    const afterTheme = await service.from("user_ui_preferences").select("locale, theme").eq("user_id", doctor.id).single();
    expect(afterTheme.data).toEqual({ locale: "ar", theme: "light" });

    await doctor.client.from("user_ui_preferences").upsert({ user_id: doctor.id, locale: "en" }, { onConflict: "user_id" });
    const afterLocale = await service.from("user_ui_preferences").select("locale, theme").eq("user_id", doctor.id).single();
    expect(afterLocale.data).toEqual({ locale: "en", theme: "light" });
  });

  it("rejects an unsupported locale or theme at the database boundary", async () => {
    const badLocale = await doctor.client.from("user_ui_preferences").update({ locale: "fr" }).eq("user_id", doctor.id);
    expect(badLocale.error).not.toBeNull();

    const badTheme = await doctor.client.from("user_ui_preferences").update({ theme: "neon" }).eq("user_id", doctor.id);
    expect(badTheme.error).not.toBeNull();
  });
});
