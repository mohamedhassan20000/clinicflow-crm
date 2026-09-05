import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const localUrl = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const secretKey = process.env.LOCAL_SUPABASE_SECRET_KEY;
if (!secretKey) {
  throw new Error("LOCAL_SUPABASE_SECRET_KEY is required for Phase 5f E2E.");
}

const service = createClient<Database>(localUrl, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const suffix = `phase5f-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "Phase5fPrivileged12345!";
const email = `${suffix}-admin@example.com`;
const ids = {
  clinic: randomUUID(),
  admin: "",
  target: "",
  conversation: randomUUID(),
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function canonical(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

async function must<T>(
  result: PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T | null> {
  const { data, error } = await result;
  if (error) throw new Error(error.message);
  return data;
}

async function login(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /sign in|تسجيل الدخول/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
}

function privilegedStream(input: Record<string, unknown>, output: unknown) {
  const toolCallId = "phase5f-role-change";
  return [
    { type: "start", messageId: "assistant-phase5f" },
    { type: "start-step" },
    {
      type: "tool-input-start",
      toolCallId,
      toolName: "execute_action",
    },
    {
      type: "tool-input-available",
      toolCallId,
      toolName: "execute_action",
      input: { action: "staff.change_role", input },
    },
    { type: "tool-output-available", toolCallId, output },
    { type: "finish-step" },
    { type: "finish", finishReason: "stop" },
  ]
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("") + "data: [DONE]\n\n";
}

async function issueRoleChangeConfirmation() {
  const input = {
    staff_id: ids.target,
    role: "manager",
    department_id: null,
    supervising_doctor_ids: [],
  };
  const before = {
    id: ids.target,
    full_name: "Phase 5f Receptionist",
    role: "receptionist",
    department_id: null,
    phone: null,
    is_active: true,
    supervising_doctor_ids: [],
  };
  const after = { ...before, role: "manager" };
  const now = Date.now();
  const expiresAt = new Date(now + 120_000).toISOString();
  const inputDigest = digest(input);
  const binding = {
    targetUserId: ids.target,
    beforeDigest: digest(before),
    afterDigest: digest(after),
  };
  const payload = {
    v: 1,
    actionId: "staff.change_role",
    inputDigest,
    userId: ids.admin,
    clinicId: ids.clinic,
    conversationId: ids.conversation,
    nonce: randomBytes(24).toString("base64url"),
    exp: now + 120_000,
    privileged: binding,
  };
  const key = Buffer.from(
    process.env.AI_ACTION_CONFIRMATION_HMAC_KEY ??
      Buffer.alloc(32, 9).toString("base64"),
    "base64",
  );
  const signature = createHmac("sha256", key)
    .update(
      [
        "clinicflow-ai-action-confirmation",
        JSON.stringify(payload),
        canonical(input),
      ].join("\u0000"),
      "utf8",
    )
    .digest("base64url");
  const token = `${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${signature}`;

  await must(
    service.rpc("issue_ai_action_confirmation", {
      p_token_hash: createHash("sha256").update(token).digest("hex"),
      p_clinic_id: ids.clinic,
      p_actor_id: ids.admin,
      p_conversation_id: ids.conversation,
      p_action_id: "staff.change_role",
      p_input_digest: inputDigest,
      p_expires_at: expiresAt,
      p_risk_class: "privileged",
      p_target_user_id: ids.target,
      p_before_digest: binding.beforeDigest,
      p_after_digest: binding.afterDigest,
    }),
  );

  return {
    input,
    output: {
      action_id: "staff.change_role",
      phase: "preview",
      risk_class: "privileged",
      confirmation_required: true,
      step_up_required: true,
      confirm_token: token,
      expires_at: expiresAt,
      preview: {
        title: "Change staff role",
        summary: "Review the exact staff role change. Credential re-entry is required.",
        changes: [
          {
            label: "Staff member",
            before: `Phase 5f Receptionist (user ${ids.target})`,
            after: `Phase 5f Receptionist (user ${ids.target})`,
            identifiesRecord: true,
          },
          { label: "Role", before: "receptionist", after: "manager" },
        ],
      },
    },
  };
}

test.beforeAll(async () => {
  const [admin, target] = await Promise.all([
    service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    }),
    service.auth.admin.createUser({
      email: `${suffix}-target@example.com`,
      password,
      email_confirm: true,
    }),
  ]);
  if (admin.error || !admin.data.user) throw admin.error ?? new Error("No admin");
  if (target.error || !target.data.user) throw target.error ?? new Error("No target");
  ids.admin = admin.data.user.id;
  ids.target = target.data.user.id;

  await must(
    service.from("clinics").insert({
      id: ids.clinic,
      name: `Phase 5f E2E Clinic ${suffix}`,
      onboarding_completed_at: new Date().toISOString(),
    }),
  );
  const plan = await service.from("plans").select("id").eq("slug", "pro_ai").single();
  if (plan.error) throw plan.error;
  await must(
    service.from("subscriptions").insert({
      clinic_id: ids.clinic,
      plan_id: plan.data.id,
      status: "trialing",
      trial_ends_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    }),
  );
  await must(
    service.from("profiles").insert([
      {
        id: ids.admin,
        clinic_id: ids.clinic,
        full_name: "Phase 5f Primary Admin",
        role: "admin",
        must_change_password: false,
      },
      {
        id: ids.target,
        clinic_id: ids.clinic,
        full_name: "Phase 5f Receptionist",
        role: "receptionist",
        must_change_password: false,
      },
    ]),
  );
  // Phase 0b made every `ai.*` key resolve through accepted commercial terms.
  // Without this row `effective_ai_feature` is false for the whole umbrella,
  // the assistant page renders the upgrade gate, and no composer ever mounts.
  // `change_reason` and `updated_by` are NOT NULL.
  await must(
    service.from("ai_commercial_terms").insert({
      clinic_id: ids.clinic,
      addon_budget_micros: 0,
      overage_mode: "hard_cap",
      overage_budget_micros: 0,
      change_reason: "pilot",
      updated_by: ids.admin,
      accepted_at: new Date().toISOString(),
    }),
  );
  await must(
    service.from("agent_conversations").insert({
      id: ids.conversation,
      clinic_id: ids.clinic,
      user_id: ids.admin,
      persona: "doctor",
      locale: "en",
    }),
  );
});

test.afterAll(async () => {
  await service.from("notifications").delete().eq("clinic_id", ids.clinic);
  await service
    .from("ai_privileged_action_rate_limits")
    .delete()
    .eq("clinic_id", ids.clinic);
  await service.from("ai_action_receipts").delete().eq("clinic_id", ids.clinic);
  await service
    .from("ai_action_confirmations")
    .delete()
    .eq("clinic_id", ids.clinic);
  await service.from("agent_messages").delete().eq("clinic_id", ids.clinic);
  await service.from("agent_conversations").delete().eq("clinic_id", ids.clinic);
  await service.from("ai_commercial_terms").delete().eq("clinic_id", ids.clinic);
  await service.from("subscriptions").delete().eq("clinic_id", ids.clinic);
  await service.from("profiles").delete().eq("clinic_id", ids.clinic);
  await service.from("clinics").delete().eq("id", ids.clinic);
  if (ids.admin) await service.auth.admin.deleteUser(ids.admin);
  if (ids.target) await service.auth.admin.deleteUser(ids.target);
});

test("primary admin changes a staff role only after exact diff and password step-up", async ({
  page,
}) => {
  await login(page);
  const confirmation = await issueRoleChangeConfirmation();
  await page.route("**/api/agent/chat", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-vercel-ai-ui-message-stream": "v1",
      },
      body: privilegedStream(confirmation.input, confirmation.output),
    });
  });

  await page.goto("/assistant");
  await page
    .getByRole("textbox", { name: "Message the clinic assistant" })
    .fill("Promote Phase 5f Receptionist to manager");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByText("Review this security change")).toBeVisible();
  await expect(page.getByText("receptionist", { exact: true })).toBeVisible();
  await expect(page.getByText("manager", { exact: true })).toBeVisible();
  const apply = page.getByRole("button", {
    name: "Re-authenticate and apply exact change",
  });
  await expect(apply).toBeDisabled();
  await page.getByLabel("Current password").fill(password);
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByText("The confirmed action completed.")).toBeVisible({
    timeout: 15_000,
  });
  // Step-up must verify the credential without disturbing the session that is
  // confirming: a global sign-out here would bounce the admin to /login.
  await expect(page).toHaveURL(/\/assistant/);

  const target = await service
    .from("profiles")
    .select("role")
    .eq("id", ids.target)
    .single();
  expect(target.error).toBeNull();
  expect(target.data?.role).toBe("manager");
  const receipts = await service
    .from("ai_action_receipts")
    .select("phase, authorization_outcome, outcome")
    .eq("clinic_id", ids.clinic)
    .eq("action_id", "staff.change_role")
    .eq("phase", "execute");
  expect(receipts.data).toContainEqual({
    phase: "execute",
    authorization_outcome: "allowed",
    outcome: "success",
  });
  const notifications = await service
    .from("notifications")
    .select("recipient_id, type, data")
    .eq("clinic_id", ids.clinic)
    .eq("type", "ai_privileged_change");
  expect(notifications.data).toContainEqual(
    expect.objectContaining({
      recipient_id: ids.admin,
      type: "ai_privileged_change",
      data: expect.objectContaining({
        actionId: "staff.change_role",
        targetUserId: ids.target,
      }),
    }),
  );
});
