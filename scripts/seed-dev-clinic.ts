/**
 * Local development / manual-QA clinic fixture — **Health Care Pro**.
 *
 * Why this exists. The manual-QA clinic was created by hand through the app and
 * therefore lived only in whatever database happened to be attached; a
 * `supabase db reset` (or a fresh checkout) left no trace of it, and a clinic
 * re-created through signup lands on the **Basic** 14-day trial with no AI
 * commercial terms. On that shape `resolveEffectiveAiFeature` returns false for
 * every `ai.*` key, so the Assistant correctly reports "AI is available only on
 * Pro + AI" — the message is accurate, the *fixture* was wrong.
 *
 * What it does. Provisions Health Care Pro as an ordinary, fully legitimate
 * **Pro + AI** subscriber, using exactly the rows an operator grant would
 * create and nothing else:
 *
 *   - `clinics`               — the workspace
 *   - `subscriptions`         — `plan_id` → the `pro_ai` plan row, `status`
 *                               `active`, with a current period that has not
 *                               expired (so `resolveSubscriptionAccess` allows)
 *   - `ai_commercial_terms`   — `accepted_at` set, which the Phase 0b resolver
 *                               requires *in addition to* the plan
 *   - `profiles`              — one user per staff role, so the whole role
 *                               matrix (including the doctor/assistant write
 *                               surface restored by final review B-2) is
 *                               manually reachable
 *
 * What it deliberately does **not** do. It writes no `clinic_feature_overrides`,
 * adds no clinic-name special case, and touches no entitlement code. The clinic
 * gets its AI capabilities the same way any paying Pro + AI clinic does: the
 * plan row carries the feature flags, `effective_ai_feature` /
 * `resolveEffectiveAiFeature` resolve them against an active subscription and an
 * accepted terms row, and every downstream gate runs unchanged. Point it at a
 * Basic plan instead and the Assistant goes back to refusing — which is the
 * proof that nothing here is a bypass.
 *
 * Local only: it refuses any Supabase host that is not 127.0.0.1 / localhost.
 *
 *   pnpm dev:seed-clinic
 */

import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";

const LOCAL_URL = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_KEY =
  process.env.LOCAL_SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

export const DEV_CLINIC = {
  id: "93000000-0000-4000-8000-000000000001",
  name: "Health Care Pro",
  /** The highest plan. Changing this slug is the only supported way to retier. */
  planSlug: "pro_ai",
  password: "ClinicFlowDev123!",
  staff: [
    { key: "admin", role: "admin", email: "dev-admin@clinicflow.example.invalid", fullName: "Huda Al-Amin" },
    { key: "manager", role: "manager", email: "dev-manager@clinicflow.example.invalid", fullName: "Faisal Nasr" },
    { key: "receptionist", role: "receptionist", email: "dev-reception@clinicflow.example.invalid", fullName: "Lina Habib" },
    { key: "doctor", role: "doctor", email: "dev-doctor@clinicflow.example.invalid", fullName: "Dr. Karim Aziz" },
    { key: "assistant", role: "assistant", email: "dev-assistant@clinicflow.example.invalid", fullName: "Reem Saad" },
  ],
} as const;

type StaffKey = (typeof DEV_CLINIC.staff)[number]["key"];

function requireLocalService() {
  if (!SERVICE_KEY) {
    throw new Error(
      "LOCAL_SUPABASE_SECRET_KEY is required to seed the local development clinic.",
    );
  }
  const url = new URL(LOCAL_URL);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(
      `Refusing to seed a non-local Supabase project (${url.hostname}).`,
    );
  }
  return createClient<Database>(LOCAL_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

type Service = ReturnType<typeof requireLocalService>;

async function assertResult(
  label: string,
  result: PromiseLike<{ error: { message: string } | null }>,
) {
  const { error } = await result;
  if (error) throw new Error(`${label}: ${error.message}`);
}

async function ensureUser(service: Service, email: string) {
  const existing = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (existing.error) throw new Error(`List users: ${existing.error.message}`);
  const found = existing.data.users.find((user) => user.email === email);
  if (found) {
    const refreshed = await service.auth.admin.updateUserById(found.id, {
      password: DEV_CLINIC.password,
      email_confirm: true,
    });
    if (refreshed.error) throw new Error(`Refresh ${email}: ${refreshed.error.message}`);
    return found.id;
  }
  const created = await service.auth.admin.createUser({
    email,
    password: DEV_CLINIC.password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw new Error(created.error?.message ?? `Create ${email}`);
  }
  return created.data.user.id;
}

function isoDaysFromNow(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export async function seedDevClinic() {
  const service = requireLocalService();
  const probe = await service.from("clinics").select("id").limit(1);
  if (probe.error) throw new Error(`Local Supabase unavailable: ${probe.error.message}`);

  const ids = {} as Record<StaffKey, string>;
  for (const member of DEV_CLINIC.staff) {
    ids[member.key] = await ensureUser(service, member.email);
  }

  await assertResult(
    "Insert clinic",
    service.from("clinics").upsert({
      id: DEV_CLINIC.id,
      name: DEV_CLINIC.name,
      country: "KW",
      currency: "KWD",
      locale: "en",
      timezone: "Asia/Kuwait",
      week_start: 6,
      phone: "+96522220000",
      phone_e164_valid: true,
      onboarding_completed_at: new Date().toISOString(),
      working_hours_start: "08:00",
      working_hours_end: "18:00",
    }),
  );

  // The plan is looked up by slug *here*, in the fixture, because seeding is
  // where a plan is chosen. No runtime resolver reads a slug (plan §5 / review
  // D-6); the entitlement it produces flows purely from the plan row's own
  // `features` map.
  const plan = await service
    .from("plans")
    .select("id, features")
    .eq("slug", DEV_CLINIC.planSlug)
    .single();
  if (plan.error) {
    throw new Error(`Load "${DEV_CLINIC.planSlug}" plan: ${plan.error.message}`);
  }

  await assertResult(
    "Insert subscription",
    service.from("subscriptions").upsert(
      {
        clinic_id: DEV_CLINIC.id,
        plan_id: plan.data.id,
        provider: "manual",
        status: "active",
        trial_ends_at: null,
        current_period_start: isoDaysFromNow(-7),
        current_period_end: isoDaysFromNow(358),
      },
      { onConflict: "clinic_id" },
    ),
  );

  // Phase 0b makes AI entitlement the conjunction of an allowed subscription,
  // an accepted commercial-terms row, the plan's `ai_assistant` umbrella, and
  // the individual key. Without this row every `ai.*` feature resolves false
  // however good the plan is — which is what produced the "requires the highest
  // subscription" notice on a clinic that had, by plan, the highest one.
  await assertResult(
    "Accept AI commercial terms",
    service.from("ai_commercial_terms").upsert(
      {
        clinic_id: DEV_CLINIC.id,
        overage_mode: "hard_cap",
        overage_budget_micros: 0,
        addon_budget_micros: 0,
        change_reason: "pilot",
        updated_by: ids.admin,
        accepted_at: new Date().toISOString(),
      },
      { onConflict: "clinic_id" },
    ),
  );

  await assertResult(
    "Insert profiles",
    service.from("profiles").upsert(
      DEV_CLINIC.staff.map((member) => ({
        id: ids[member.key],
        clinic_id: DEV_CLINIC.id,
        full_name: member.fullName,
        role: member.role,
        must_change_password: false,
        is_active: true,
      })),
    ),
  );

  // The assistant's whole scope is its supervised doctors, so an unassigned
  // assistant is indistinguishable from a broken one during manual QA.
  await assertResult(
    "Assign assistant to doctor",
    service.from("assistant_doctor_assignments").upsert(
      {
        clinic_id: DEV_CLINIC.id,
        assistant_id: ids.assistant,
        doctor_id: ids.doctor,
      },
      { onConflict: "assistant_id,doctor_id" },
    ),
  );

  return { clinicId: DEV_CLINIC.id, planSlug: DEV_CLINIC.planSlug, userIds: ids };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedDevClinic()
    .then(({ clinicId, planSlug }) => {
      process.stdout.write(
        `Seeded local development clinic "${DEV_CLINIC.name}" (${clinicId}) on the ${planSlug} plan.\n` +
          `Sign in as any of: ${DEV_CLINIC.staff.map((member) => member.email).join(", ")}\n` +
          `Password: ${DEV_CLINIC.password}\n`,
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
