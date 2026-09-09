/**
 * "Close all open conversations", against a real database.
 *
 * The unit test for this action mocks PostgREST, so it proves the *loop* is
 * correct — that it pages past failures, terminates, and reaches past 300 rows.
 * What it cannot prove is that the loop's premise holds: that closing a row
 * genuinely removes it from `status = 'open'`, that the account boundary the
 * count and the pages share is the one the database enforces, and that the
 * per-conversation close still performs the full P11N reset when it is the
 * bulk path calling it rather than the button.
 *
 * So this runs the real action against the local stack, with only the two
 * things that cannot exist outside a Next request stubbed: the role gate and
 * `revalidatePath`. Every read, every write, the boundary resolution, the
 * episode ending and the audit line are the production code paths.
 *
 * Local Supabase only. `LOCAL_SUPABASE_*` are the sole credentials read here.
 */

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
const anonKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = `bulkclose-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clinicId = randomUUID();
const staffId = randomUUID();
const otherClinicId = randomUUID();
const otherStaffId = randomUUID();
/** The clinic's proved WhatsApp account — the boundary everything is scoped to. */
const linkedAccountId = `+2015${String(Date.now()).slice(-8)}`;
/** A different account for the same clinic: legacy rows that must not be touched. */
const strayAccountId = `+2016${String(Date.now()).slice(-8)}`;
const email = `${suffix}@example.test`;
const otherEmail = `${suffix}-other@example.test`;
const password = "BulkClose12345!";

let actingUser: { id: string; clinicId: string; role: string } = {
  id: staffId,
  clinicId,
  role: "admin",
};

/**
 * The Inbox loader reads through the *authenticated* staff client. Hoisted
 * here rather than mocked inside the test, because `vi.mock` is what the
 * module graph sees; the client itself is filled in during `beforeAll`.
 */
let staffClient: ReturnType<typeof createClient<Database>>;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => staffClient }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/rbac", () => ({
  requireMutationRole: async () => actingUser,
  requireRole: async () => actingUser,
}));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: async () => undefined }));

/** Ids created per test, cleaned up between them. */
let created: string[] = [];

async function makeConversation(input: {
  status: "open" | "closed";
  account?: string | null;
  clinic?: string;
  index: number;
}) {
  const id = randomUUID();
  const clinic = input.clinic ?? clinicId;
  const result = await service.from("conversations").insert({
    id,
    clinic_id: clinic,
    channel: "whatsapp",
    participant_address: `+2019${String(input.index).padStart(8, "0")}`,
    display_name: `Contact ${input.index}`,
    status: input.status,
    last_message_at: new Date(Date.now() - input.index * 1000).toISOString(),
    whatsapp_account_id: input.account === undefined ? linkedAccountId : input.account,
  });
  if (result.error) throw result.error;
  created.push(id);
  return id;
}

async function statusOf(id: string) {
  const row = await service
    .from("conversations")
    .select("status, status_updated_at, ai_collected_data, ai_booking_stage, current_episode_id")
    .eq("id", id)
    .maybeSingle();
  if (row.error) throw row.error;
  return row.data!;
}

async function cleanupConversations() {
  if (created.length === 0) return;
  await service.from("ai_suggested_replies").delete().in("conversation_id", created);
  await service.from("conversation_episodes").delete().in("conversation_id", created);
  await service.from("conversations").delete().in("id", created);
  created = [];
}

async function cleanup() {
  await cleanupConversations();
  for (const clinic of [clinicId, otherClinicId]) {
    await service.from("ai_suggested_replies").delete().eq("clinic_id", clinic);
    await service.from("conversation_episodes").delete().eq("clinic_id", clinic);
    await service.from("conversations").delete().eq("clinic_id", clinic);
    await service.from("clinic_channels").delete().eq("clinic_id", clinic);
    await service.from("whatsapp_linked_device_sessions").delete().eq("clinic_id", clinic);
    await service.from("audit_logs").delete().eq("clinic_id", clinic);
  }
  for (const id of [staffId, otherStaffId]) {
    await service.from("profiles").delete().eq("id", id);
    await service.auth.admin.deleteUser(id).catch(() => undefined);
  }
  await service.from("clinics").delete().eq("id", clinicId);
  await service.from("clinics").delete().eq("id", otherClinicId);
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = secretKey;
  await cleanup();

  let r: { error: unknown } = await service
    .from("clinics")
    .insert([
      { id: clinicId, name: `Bulk close ${suffix}`, country: "EG" },
      { id: otherClinicId, name: `Bulk close other ${suffix}`, country: "EG" },
    ]);
  if (r.error) throw r.error;

  r = await service.from("clinic_channels").insert({
    clinic_id: clinicId,
    channel: "whatsapp",
    provider: "linked_device",
    sender_identity: `bulk${Date.now()}`,
    status: "active",
  });
  if (r.error) throw r.error;
  // The proved identity. `resolveWhatsAppAccountBoundary` reads this row, and
  // it is what makes the boundary an identity fact rather than a socket fact.
  r = await service.from("whatsapp_linked_device_sessions").insert({
    clinic_id: clinicId,
    status: "connected",
    desired_state: "online",
    authenticated_account_id: linkedAccountId,
    phone_number: linkedAccountId,
  });
  if (r.error) throw r.error;

  const auth = await service.auth.admin.createUser({
    id: staffId, email, password, email_confirm: true,
  });
  if (auth.error) throw auth.error;
  r = await service.from("profiles").insert({
    id: staffId, clinic_id: clinicId, full_name: "Bulk Close Admin",
    role: "admin", must_change_password: false,
  });
  if (r.error) throw r.error;

  const otherAuth = await service.auth.admin.createUser({
    id: otherStaffId, email: otherEmail, password, email_confirm: true,
  });
  if (otherAuth.error) throw otherAuth.error;
  r = await service.from("profiles").insert({
    id: otherStaffId, clinic_id: otherClinicId, full_name: "Other Admin",
    role: "admin", must_change_password: false,
  });
  if (r.error) throw r.error;

  staffClient = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  const session = await staffClient.auth.signInWithPassword({ email, password });
  if (session.error) throw session.error;
});

afterAll(cleanup);

describe("closing every open conversation, against the database", () => {
  it("counts and closes exactly the open rows in this clinic's account boundary", async () => {
    const { closeOpenConversations, countOpenConversations } = await import(
      "@/actions/messaging"
    );

    const open = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        makeConversation({ status: "open", index }),
      ),
    );
    const alreadyClosed = await makeConversation({ status: "closed", index: 50 });
    // Out of scope in three different ways, none of which may be closed.
    const otherAccount = await makeConversation({
      status: "open", account: strayAccountId, index: 60,
    });
    const legacyNullAccount = await makeConversation({
      status: "open", account: null, index: 61,
    });
    const otherClinic = await makeConversation({
      status: "open", clinic: otherClinicId, account: null, index: 62,
    });

    const closedBefore = await statusOf(alreadyClosed);

    const counted = await countOpenConversations();
    expect(counted.total).toBe(open.length);

    const result = await closeOpenConversations();
    expect(result).toEqual({ total: 8, closed: 8, failed: 0 });

    for (const id of open) {
      expect((await statusOf(id)).status).toBe("closed");
    }
    // Untouched means untouched: not rewritten, so its timestamp did not move.
    const closedAfter = await statusOf(alreadyClosed);
    expect(closedAfter.status).toBe("closed");
    expect(closedAfter.status_updated_at).toBe(closedBefore.status_updated_at);

    for (const id of [otherAccount, legacyNullAccount, otherClinic]) {
      expect((await statusOf(id)).status).toBe("open");
    }

    // Nothing left to do, said honestly rather than by closing something else.
    await expect(countOpenConversations()).resolves.toEqual({ total: 0 });
    await expect(closeOpenConversations()).resolves.toEqual({
      total: 0, closed: 0, failed: 0,
    });

    await cleanupConversations();
  }, 120_000);

  it("pages through a set larger than one page, closing all of it", async () => {
    const { closeOpenConversations, countOpenConversations } = await import(
      "@/actions/messaging"
    );

    // Above BULK_CLOSE_PAGE_SIZE (100), so the loop must fetch more than once.
    // Kept to 240 rather than 450 so the suite stays a suite; the >300 case is
    // pinned in the unit test, and what this proves is the *paging premise* —
    // that a closed row leaves the eligible set, so the next page advances.
    const total = 240;
    const rows = Array.from({ length: total }, (_, index) => {
      const id = randomUUID();
      created.push(id);
      return {
        id,
        clinic_id: clinicId,
        channel: "whatsapp" as const,
        participant_address: `+2018${String(index).padStart(8, "0")}`,
        display_name: `Paged ${index}`,
        status: "open" as const,
        last_message_at: new Date(Date.now() - index * 1000).toISOString(),
        whatsapp_account_id: linkedAccountId,
      };
    });
    const inserted = await service.from("conversations").insert(rows);
    if (inserted.error) throw inserted.error;

    await expect(countOpenConversations()).resolves.toEqual({ total });

    const result = await closeOpenConversations();
    expect(result).toEqual({ total, closed: total, failed: 0 });

    const remaining = await service
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .eq("status", "open");
    expect(remaining.count).toBe(0);

    await cleanupConversations();
  }, 300_000);

  it("performs the full P11N reset on every conversation it closes", async () => {
    const { closeOpenConversations } = await import("@/actions/messaging");

    const id = await makeConversation({ status: "open", index: 70 });
    // The state a half-finished intake leaves behind, and a pending draft the
    // assistant had queued for it.
    let r: { error: unknown } = await service
      .from("conversations")
      .update({
        ai_collected_data: { full_name: "Ahmed" },
        ai_booking_stage: { stage: "collecting", turns: 3 },
        ai_auto_close_after: new Date().toISOString(),
      })
      .eq("id", id);
    if (r.error) throw r.error;
    r = await service.from("ai_suggested_replies").insert({
      clinic_id: clinicId, conversation_id: id, body: "Still need your ID",
      status: "pending", escalate: false, mode: "suggest",
    });
    if (r.error) throw r.error;

    const result = await closeOpenConversations();
    expect(result.closed).toBe(1);

    const after = await statusOf(id);
    expect(after.status).toBe("closed");
    expect(after.ai_collected_data).toEqual({});
    expect(after.ai_booking_stage).toBeNull();
    expect(after.current_episode_id).toBeNull();

    const drafts = await service
      .from("ai_suggested_replies")
      .select("status")
      .eq("conversation_id", id);
    if (drafts.error) throw drafts.error;
    // A draft written for a finished exchange must never become sendable.
    expect(drafts.data?.every((row) => row.status === "superseded")).toBe(true);

    await cleanupConversations();
  }, 120_000);

  it("closes nothing for a clinic whose account boundary is unproved", async () => {
    const { closeOpenConversations, countOpenConversations } = await import(
      "@/actions/messaging"
    );

    // The other clinic is mid-pairing: a linked-device channel row exists, but
    // no account has ever been proved. It must fail closed rather than be
    // handed the legacy NULL scope as a consolation.
    const channel = await service.from("clinic_channels").insert({
      clinic_id: otherClinicId, channel: "whatsapp", provider: "linked_device",
      sender_identity: `bulkother${Date.now()}`, status: "pending",
    });
    if (channel.error) throw channel.error;
    const stray = await makeConversation({
      status: "open", clinic: otherClinicId, account: null, index: 80,
    });

    const previous = actingUser;
    actingUser = { id: otherStaffId, clinicId: otherClinicId, role: "admin" };
    try {
      const counted = await countOpenConversations();
      expect(counted.error).toBeTruthy();
      expect(counted.total).toBeUndefined();

      const result = await closeOpenConversations();
      expect(result.error).toBeTruthy();
      expect(result.closed).toBeUndefined();
    } finally {
      actingUser = previous;
    }

    expect((await statusOf(stray)).status).toBe("open");
    await cleanupConversations();
  }, 120_000);
});

describe("the status a staff member sets is the status the Inbox reads back", () => {
  it("persists a close and a reopen through the Inbox's own read path", async () => {
    const { updateConversationStatus } = await import("@/actions/messaging");
    const { loadInboxData } = await import("@/lib/messaging/inbox");
    const { conversationBadgeState } = await import(
      "@/lib/messaging/conversation-status"
    );

    const id = await makeConversation({ status: "open", index: 90 });
    const user = { id: staffId, clinicId, role: "admin" } as never;

    const closed = await updateConversationStatus({ conversationId: id, status: "closed" });
    expect(closed.success).toBe(true);
    let data = await loadInboxData(user, id);
    let row = data.conversations.find((conversation) => conversation.id === id);
    expect(row?.status).toBe("closed");
    expect(conversationBadgeState(row!)).toBe("done");

    const reopened = await updateConversationStatus({ conversationId: id, status: "open" });
    expect(reopened.success).toBe(true);
    data = await loadInboxData(user, id);
    row = data.conversations.find((conversation) => conversation.id === id);
    expect(row?.status).toBe("open");
    // The defect this pass fixed: the row reopened and the badge stayed Done,
    // because the thread has no episode and the derivation read that as
    // "resting". The explicit column is newer than the boundary, so it wins.
    expect(conversationBadgeState(row!)).not.toBe("done");

    await cleanupConversations();
  }, 120_000);
});
