import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { checkRateLimit } from "@/lib/rate-limit";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("rate limiter failure posture", () => {
  it("fails closed for anonymous signup surfaces", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", ""); vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    await expect(checkRateLimit("signup", "ip", { limit: 1, windowSeconds: 60, failureMode: "closed" })).resolves.toMatchObject({ allowed: false, backendAvailable: false });
  });
  it("keeps auth recovery available during backend failure", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", ""); vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    await expect(checkRateLimit("login", "ip", { limit: 1, windowSeconds: 60, failureMode: "open" })).resolves.toMatchObject({ allowed: true, backendAvailable: false });
  });
  it("blocks a flooding identifier", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.test"); vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: [0, 5, Date.now()] }), { status: 200 })));
    await expect(checkRateLimit("signup", "ip", { limit: 5, windowSeconds: 60, failureMode: "closed" })).resolves.toMatchObject({ allowed: false, backendAvailable: true });
  });
});
