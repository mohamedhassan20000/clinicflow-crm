import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  limit: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock("server-only", () => ({}));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: async () => ({ from: mocks.from }),
  }));
  mocks.from.mockReturnValue({
    select: () => ({ limit: mocks.limit }),
  });
});

describe("P4.8 launcher persistence readiness", () => {
  it("checks both RLS persistence tables without loading history and caches readiness", async () => {
    mocks.limit.mockResolvedValue({ data: [], error: null });
    const { isAssistantPersistenceReady } = await import(
      "@/lib/ai/persistence-readiness"
    );

    await expect(isAssistantPersistenceReady()).resolves.toBe(true);
    await expect(isAssistantPersistenceReady()).resolves.toBe(true);
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual([
      "agent_conversations",
      "agent_messages",
    ]);
    expect(mocks.limit).toHaveBeenCalledTimes(2);
  });

  it("fails closed when either persistence table is missing", async () => {
    mocks.limit
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { code: "PGRST205", message: "table not found" },
      });
    const { isAssistantPersistenceReady } = await import(
      "@/lib/ai/persistence-readiness"
    );

    await expect(isAssistantPersistenceReady()).resolves.toBe(false);
  });
});
