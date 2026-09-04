import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

/**
 * P11T-HOTFIX — an episode context is bounded or it does not exist.
 *
 * `EpisodeContext.scope` used to read `startedAt ? query.gte(…) : query`. The
 * false branch is the whole leak: a context built from a falsy boundary applied
 * no filter, so every episode-scoped read quietly became a full-thread read and
 * nothing anywhere failed. These tests hold the two properties that replace it
 * — the bound is unconditional, and a resolution that yields no start yields no
 * context — and the one structural rule that keeps the escape hatch out of the
 * reply path.
 */

const resolveConversationEpisode = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  resolveConversationEpisode: (...args: unknown[]) => resolveConversationEpisode(...args),
  closeConversationEpisode: vi.fn(),
  createClinicScopedAdminClient: vi.fn(),
}));

import {
  episodeContextFromBoundary,
  episodeContextFromResolvedEpisode,
  resolveCurrentEpisode,
  unboundedThreadScopeForStaffHistory,
} from "@/lib/ai/episode";

/** A query builder that records whether a bound was ever applied. */
function recordingQuery() {
  const applied: [string, string][] = [];
  const query = {
    applied,
    gte(column: string, value: string) {
      applied.push([column, value]);
      return query;
    },
  };
  return query;
}

describe("P11T-HOTFIX — EpisodeContext.scope is never a pass-through", () => {
  it("applies the bound for a context built from a resolved episode", () => {
    const context = episodeContextFromResolvedEpisode({
      episodeId: "episode-1",
      startedAt: "2026-09-01T13:16:47.071Z",
      opened: true,
    });
    const inbound = recordingQuery();
    const outbound = recordingQuery();
    context.scope(inbound, "received_at");
    context.scope(outbound, "created_at");

    expect(inbound.applied).toEqual([["received_at", "2026-09-01T13:16:47.071Z"]]);
    expect(outbound.applied).toEqual([["created_at", "2026-09-01T13:16:47.071Z"]]);
  });

  it("applies the bound for a context built from the P11O boundary alone", () => {
    const context = episodeContextFromBoundary("2026-09-01T13:16:47.071Z");
    const query = recordingQuery();
    context.scope(query, "created_at");

    // No episode identity, but the cut is the same instant it always was.
    expect(context.episodeId).toBe("");
    expect(query.applied).toHaveLength(1);
  });
});

describe("P11T-HOTFIX — an episode with no start is not an episode", () => {
  it("resolves to null when the RPC returns no started_at", async () => {
    resolveConversationEpisode.mockResolvedValue({
      data: [{ episode_id: "episode-1", started_at: null, opened: true }],
      error: null,
    });
    await expect(
      resolveCurrentEpisode({ clinicId: "clinic-1", conversationId: "conv-1" }),
    ).resolves.toBeNull();
  });

  it("resolves to null when the RPC errors", async () => {
    resolveConversationEpisode.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(
      resolveCurrentEpisode({ clinicId: "clinic-1", conversationId: "conv-1" }),
    ).resolves.toBeNull();
  });

  it("returns the RPC's own start, not the caller's hint", async () => {
    resolveConversationEpisode.mockResolvedValue({
      data: [{ episode_id: "episode-1", started_at: "2026-09-01T13:16:47.071Z", opened: false }],
      error: null,
    });
    const episode = await resolveCurrentEpisode({
      clinicId: "clinic-1",
      conversationId: "conv-1",
      // A stale snapshot. The resolver re-read the row; this loses.
      startedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(episode?.startedAt).toBe("2026-09-01T13:16:47.071Z");
  });
});

describe("P11T-HOTFIX — the unbounded read is separate and stays out of the reply path", () => {
  it("is not an EpisodeContext", () => {
    const scope = unboundedThreadScopeForStaffHistory();
    expect(scope.unbounded).toBe(true);
    expect(scope).not.toHaveProperty("startedAt");
    expect(scope).not.toHaveProperty("episodeId");
  });

  it("is never named by lib/ai/patient-reply.ts", () => {
    const source = readFileSync(
      path.join(process.cwd(), "lib/ai/patient-reply.ts"),
      "utf8",
    );
    expect(source).not.toContain("unboundedThreadScopeForStaffHistory");
    expect(source).not.toContain("UnboundedThreadScope");
  });

  /**
   * The regression itself, stated as source: the ternary that made a missing
   * boundary mean "read everything" must not come back.
   */
  it("leaves no conditional bound in lib/ai/episode.ts", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/ai/episode.ts"), "utf8");
    expect(source).not.toContain("startedAt ? query.gte");
  });
});
