import { describe, expect, it, vi } from "vitest";

/**
 * Post-plan product completion — the two server actions that carry conversation
 * history for *both* `/assistant` and every contextual "Ask Assistant" shortcut.
 *
 * There is deliberately one pair of actions and one persistence layer. These
 * tests assert the boundary they add: authorization first, an independent
 * limiter, no denial that distinguishes "not yours" from "does not exist", and
 * no leaked internals when the store fails.
 */

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "admin" as const,
  departmentId: null,
  email: "admin@clinic.test",
  fullName: "Admin",
  avatarUrl: null,
  mustChangePassword: false,
};
const CONVERSATION = "22222222-2222-4222-8222-222222222222";

async function loadActions(options: {
  rateLimitAllowed?: boolean;
  list?: unknown;
  listError?: Error;
  open?: unknown;
  openError?: Error;
  authorizeError?: Error;
} = {}) {
  vi.resetModules();
  const authorizeStaffAssistant = vi.fn(async () => {
    if (options.authorizeError) throw options.authorizeError;
    return USER;
  });
  const checkRateLimit = vi.fn(async () => ({
    allowed: options.rateLimitAllowed ?? true,
    retryAfterSeconds: options.rateLimitAllowed === false ? 30 : 0,
    backendAvailable: true,
  }));
  const listAssistantConversations = vi.fn(async () => {
    if (options.listError) throw options.listError;
    return options.list ?? [];
  });
  const loadAssistantConversationById = vi.fn(async () => {
    if (options.openError) throw options.openError;
    return options.open ?? null;
  });
  const captureException = vi.fn();

  vi.doMock("server-only", () => ({}));
  vi.doMock("@sentry/nextjs", () => ({ captureException }));
  vi.doMock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
  vi.doMock("@/lib/rate-limit", () => ({ checkRateLimit }));
  vi.doMock("@/lib/ai/authorization", () => ({ authorizeStaffAssistant }));
  vi.doMock("@/lib/ai/conversations", () => ({
    listAssistantConversations,
    loadAssistantConversationById,
  }));

  return {
    authorizeStaffAssistant,
    checkRateLimit,
    listAssistantConversations,
    loadAssistantConversationById,
    captureException,
    actions: await import("@/actions/assistant-conversations"),
  };
}

const SUMMARY = {
  id: CONVERSATION,
  title: "Blood types",
  updatedAt: "2026-08-16T10:00:00.000Z",
  createdAt: "2026-08-16T09:00:00.000Z",
  patientBound: false,
};

describe("listAssistantConversationHistory", () => {
  it("authorizes before reading and returns the caller's own conversations", async () => {
    const ctx = await loadActions({ list: [SUMMARY] });
    await expect(ctx.actions.listAssistantConversationHistory()).resolves.toEqual({
      success: true,
      conversations: [SUMMARY],
    });
    expect(ctx.authorizeStaffAssistant).toHaveBeenCalledTimes(1);
    expect(ctx.listAssistantConversations).toHaveBeenCalledWith(
      expect.objectContaining({ user: USER }),
    );
  });

  it("propagates the Assistant authorization denial rather than returning an empty list", async () => {
    const denial = Object.assign(new Error("role_forbidden"), {
      name: "AiToolAuthorizationError",
    });
    const ctx = await loadActions({ authorizeError: denial });
    await expect(ctx.actions.listAssistantConversationHistory()).rejects.toBe(denial);
    expect(ctx.listAssistantConversations).not.toHaveBeenCalled();
  });

  it("applies its own limiter before touching the store", async () => {
    const ctx = await loadActions({ rateLimitAllowed: false });
    await expect(ctx.actions.listAssistantConversationHistory()).resolves.toEqual({
      success: false,
      reason: "rate_limited",
    });
    expect(ctx.checkRateLimit).toHaveBeenCalledWith(
      "assistant-conversation-history",
      `${USER.clinicId}:${USER.id}`,
      { limit: 60, windowSeconds: 60, failureMode: "open" },
    );
    expect(ctx.listAssistantConversations).not.toHaveBeenCalled();
  });

  it("reports a store failure as unavailable and records it without leaking internals", async () => {
    const ctx = await loadActions({ listError: new Error("persistence_failed") });
    await expect(ctx.actions.listAssistantConversationHistory()).resolves.toEqual({
      success: false,
      reason: "unavailable",
    });
    expect(ctx.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: { clinicId: USER.clinicId, role: USER.role },
      }),
    );
  });
});

describe("openAssistantConversation", () => {
  const LOADED = {
    id: CONVERSATION,
    title: "Blood types",
    patientId: null,
    messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
    activeContext: {},
    historyTruncated: false,
  };

  it("returns the persisted transcript and context for the caller's conversation", async () => {
    const ctx = await loadActions({ open: LOADED });
    await expect(
      ctx.actions.openAssistantConversation({ conversationId: CONVERSATION }),
    ).resolves.toEqual({ success: true, conversation: LOADED });
  });

  it("returns the patient binding so the next turn can re-declare and re-authorize it", async () => {
    const patientId = "33333333-3333-4333-8333-333333333333";
    const ctx = await loadActions({ open: { ...LOADED, patientId } });
    const result = await ctx.actions.openAssistantConversation({
      conversationId: CONVERSATION,
    });
    expect(result).toMatchObject({ success: true, conversation: { patientId } });
  });

  it("rejects a non-uuid id before authorizing", async () => {
    const ctx = await loadActions();
    await expect(
      ctx.actions.openAssistantConversation({ conversationId: "../../etc/passwd" }),
    ).resolves.toEqual({ success: false, reason: "invalid_selection" });
    expect(ctx.authorizeStaffAssistant).not.toHaveBeenCalled();
  });

  it("rejects an over-specified payload", async () => {
    const ctx = await loadActions();
    await expect(
      ctx.actions.openAssistantConversation({
        conversationId: CONVERSATION,
        clinicId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ).resolves.toEqual({ success: false, reason: "invalid_selection" });
  });

  it("returns not_found identically for another user's conversation and a missing one", async () => {
    const ctx = await loadActions({ open: null });
    await expect(
      ctx.actions.openAssistantConversation({ conversationId: CONVERSATION }),
    ).resolves.toEqual({ success: false, reason: "not_found" });
  });

  it("applies the limiter before the store read", async () => {
    const ctx = await loadActions({ rateLimitAllowed: false });
    await expect(
      ctx.actions.openAssistantConversation({ conversationId: CONVERSATION }),
    ).resolves.toEqual({ success: false, reason: "rate_limited" });
    expect(ctx.loadAssistantConversationById).not.toHaveBeenCalled();
  });
});
