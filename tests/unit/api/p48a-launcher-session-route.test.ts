import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiToolAuthorizationError } from "@/lib/ai/errors";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  resolveSession: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("next-intl/server", () => ({ getLocale: async () => "en" }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/ai/authorization", () => ({
  authorizeStaffAssistant: mocks.authorize,
}));
vi.mock("@/lib/ai/launchers", () => ({
  resolveAssistantLauncherSession: mocks.resolveSession,
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.rateLimit }));

import { POST } from "@/app/api/agent/launcher-session/route";

const USER = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  email: "admin@example.com",
  role: "admin" as const,
  fullName: "Admin",
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};

function request(body: unknown) {
  return new Request("https://clinicflow.test/api/agent/launcher-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(USER);
  mocks.rateLimit.mockResolvedValue({
    allowed: true,
    retryAfterSeconds: 0,
    backendAvailable: true,
  });
  mocks.resolveSession.mockResolvedValue({
    context: { type: "dashboard" },
    access: { state: "available", remaining: 19, limit: 20 },
    seededActiveContext: {
      patient: {
        entity_type: "patient",
        entity_id: "00000000-0000-4000-8000-000000000011",
        display_label: "Seeded Patient",
        set_at: "2026-08-16T00:00:00.000Z",
        set_by: "page_context",
      },
    },
    capabilities: { toolNames: ["query_resource"], items: [] },
  });
});

describe("P4.8 deferred launcher session route", () => {
  it.each([
    ["unauthenticated", 401],
    ["role_forbidden", 403],
    ["page_hidden", 403],
    ["feature_not_entitled", 403],
    ["subscription_inactive", 403],
    ["usage_limit_reached", 429],
    ["lookup_failed", 503],
  ] as const)("preserves the %s authorization denial", async (reason, status) => {
    mocks.authorize.mockRejectedValueOnce(new AiToolAuthorizationError(reason));
    const response = await POST(request({ context: { type: "dashboard" } }));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: reason });
    expect(mocks.resolveSession).not.toHaveBeenCalled();
  });

  it("rejects malformed contexts before hydration", async () => {
    for (const context of [
      { type: "dashboard", extra: true },
      { type: "revenue", dateRange: { from: "2026-07-01", to: "not-a-date" } },
    ]) {
      const response = await POST(request({ context }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    }
    expect(mocks.resolveSession).not.toHaveBeenCalled();
  });

  it("uses a dedicated per-user-and-clinic limiter before parsing or hydration", async () => {
    mocks.rateLimit.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 17,
      backendAvailable: true,
    });
    const response = await POST(request({ context: { type: "dashboard" } }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "rate_limited" });
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      "assistant-launcher-session",
      `${USER.clinicId}:${USER.id}`,
      { limit: 30, windowSeconds: 60, failureMode: "open" },
    );
    expect(mocks.resolveSession).not.toHaveBeenCalled();
  });

  it("keeps the launcher fail-soft when the limiter backend is unavailable", async () => {
    mocks.rateLimit.mockResolvedValueOnce({
      allowed: true,
      retryAfterSeconds: 30,
      backendAvailable: false,
    });
    const response = await POST(request({ context: { type: "dashboard" } }));
    expect(response.status).toBe(200);
    expect(mocks.resolveSession).toHaveBeenCalledTimes(1);
  });

  it("allows an in-policy burst and resolves each accepted request", async () => {
    const responses = await Promise.all([
      POST(request({ context: { type: "dashboard" } })),
      POST(request({ context: { type: "dashboard" } })),
      POST(request({ context: { type: "dashboard" } })),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200, 200]);
    expect(mocks.rateLimit).toHaveBeenCalledTimes(3);
    expect(mocks.resolveSession).toHaveBeenCalledTimes(3);
  });

  it("rejects oversized bodies before JSON parsing or hydration", async () => {
    const response = await POST(request({
      context: { type: "dashboard" },
      padding: "x".repeat(2_100),
    }));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "request_too_large",
    });
    expect(mocks.resolveSession).not.toHaveBeenCalled();
  });

  it.each([
    { type: "revenue", dateRange: { from: "2026-07-01", to: "2026-07-31" } },
    { type: "reports", report: "no_shows", range: { from: "2026-07-01", to: "2026-07-31" } },
    { type: "invoices", filter: "outstanding" },
    { type: "staff" },
    { type: "departments" },
    { type: "doctor-schedule" },
  ] as const)("hydrates the valid P4.8B $type context through the repeated gate", async (context) => {
    const response = await POST(request({ context }));
    expect(response.status).toBe(200);
    expect(mocks.resolveSession).toHaveBeenCalledWith({
      user: USER,
      context,
      locale: "en",
    });
  });

  // Post-plan completion, change 3: the launcher opens a *new* conversation
  // seeded with the server-derived context of the record on screen, instead of
  // silently resuming whatever conversation happened to be most recent. Past
  // conversations are reached from the shared history panel inside the sheet.
  it("returns a fresh seeded session and capabilities only after authenticated resolution", async () => {
    const response = await POST(request({ context: { type: "dashboard" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      initialMessages: [],
      historyTruncated: false,
      remaining: 19,
      capabilities: { toolNames: ["query_resource"], items: [] },
      initialActiveContext: {
        patient: expect.objectContaining({
          entity_id: "00000000-0000-4000-8000-000000000011",
          set_by: "page_context",
        }),
      },
    });
    expect(payload.initialConversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(mocks.resolveSession).toHaveBeenCalledWith({
      user: USER,
      context: { type: "dashboard" },
      locale: "en",
    });
  });

  it("mints a distinct conversation id on every launcher open", async () => {
    const ids = await Promise.all(
      [0, 1].map(async () =>
        ((await (await POST(request({ context: { type: "dashboard" } }))).json()) as {
          initialConversationId: string;
        }).initialConversationId,
      ),
    );
    expect(new Set(ids).size).toBe(2);
  });

  it("fails closed when persistence or the repeated launcher gate is unavailable", async () => {
    mocks.resolveSession.mockResolvedValueOnce(null);
    const response = await POST(request({ context: { type: "dashboard" } }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "temporarily_unavailable",
    });
  });
});
