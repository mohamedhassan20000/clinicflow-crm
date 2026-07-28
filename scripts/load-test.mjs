#!/usr/bin/env node
/**
 * P6B — Load test harness for the webhook + agent routes.
 *
 * Zero-dependency concurrent HTTP driver (Node ≥ 18, global fetch). Drives one
 * or more named scenarios at a fixed concurrency for a fixed duration, then
 * reports throughput, latency percentiles (p50/p95/p99), and error rate against
 * per-scenario targets. Exits non-zero if any enabled scenario misses its
 * target, so the run doubles as a CI/manual gate.
 *
 * Plan reference: docs/AI_AGENT_PLAN.md §P6B — "load tests on webhook + agent
 * routes; ... load-test results documented against targets". The scenarios cover
 * the two hot server routes:
 *   - webhook   → POST /api/webhooks/whatsapp   (inbound message ingestion)
 *   - agent     → POST /api/agent/chat          (staff/patient agent turn)
 * plus a webhook-verify GET handshake that needs no credentials.
 *
 * Usage:
 *   node scripts/load-test.mjs --base=http://localhost:3100 --duration=30 --concurrency=25
 *   node scripts/load-test.mjs --scenario=webhook-verify           # single scenario
 *
 * Auth/payloads are environment-specific (signed webhooks, session cookies), so
 * request headers/bodies are read from env when present:
 *   LOAD_WEBHOOK_SIGNATURE, LOAD_WEBHOOK_BODY, LOAD_AGENT_COOKIE, LOAD_AGENT_BODY
 * Scenarios without the required env are skipped (reported), never faked.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "true"];
  }),
);

const BASE = args.base ?? process.env.LOAD_BASE_URL ?? "http://localhost:3100";
const DURATION_S = Number(args.duration ?? 20);
const CONCURRENCY = Number(args.concurrency ?? 20);
const ONLY = args.scenario ?? null;

/**
 * Targets are deliberately conservative for a single dev instance; production
 * (Fluid Compute) clears them comfortably. Tune per environment.
 */
const scenarios = [
  {
    name: "webhook-verify",
    method: "GET",
    path: "/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=probe&hub.challenge=1",
    headers: () => ({}),
    body: () => undefined,
    // 401/403/200 are all "handled fast" — we measure the route, not the token.
    acceptStatus: (status) => status < 500,
    target: { p95Ms: 400, errorRatePct: 1, minRps: 50 },
    ready: () => true,
  },
  {
    name: "webhook",
    method: "POST",
    path: "/api/webhooks/whatsapp",
    headers: () => ({
      "content-type": "application/json",
      ...(process.env.LOAD_WEBHOOK_SIGNATURE
        ? { "x-hub-signature-256": process.env.LOAD_WEBHOOK_SIGNATURE }
        : {}),
    }),
    body: () => process.env.LOAD_WEBHOOK_BODY ?? JSON.stringify({ entry: [] }),
    acceptStatus: (status) => status < 500,
    target: { p95Ms: 800, errorRatePct: 2, minRps: 25 },
    ready: () => true, // runs unsigned → exercises the signature-reject fast path
  },
  {
    name: "agent",
    method: "POST",
    path: "/api/agent/chat",
    headers: () => ({
      "content-type": "application/json",
      ...(process.env.LOAD_AGENT_COOKIE ? { cookie: process.env.LOAD_AGENT_COOKIE } : {}),
    }),
    body: () =>
      process.env.LOAD_AGENT_BODY ??
      JSON.stringify({ messages: [{ role: "user", parts: [{ type: "text", text: "ping" }] }] }),
    acceptStatus: (status) => status < 500,
    target: { p95Ms: 2500, errorRatePct: 5, minRps: 5 },
    // Needs an authenticated session to exercise the agent; otherwise it only
    // measures the auth-reject path, still useful but flagged.
    ready: () => Boolean(process.env.LOAD_AGENT_COOKIE),
  },
];

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

async function runScenario(scenario) {
  const deadline = Date.now() + DURATION_S * 1000;
  const latencies = [];
  let ok = 0;
  let errors = 0;

  const worker = async () => {
    while (Date.now() < deadline) {
      const started = performance.now();
      try {
        const response = await fetch(`${BASE}${scenario.path}`, {
          method: scenario.method,
          headers: scenario.headers(),
          body: scenario.method === "GET" ? undefined : scenario.body(),
        });
        // Drain body so the connection is reusable and timing is honest.
        await response.arrayBuffer();
        latencies.push(performance.now() - started);
        if (scenario.acceptStatus(response.status)) ok += 1;
        else errors += 1;
      } catch {
        latencies.push(performance.now() - started);
        errors += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  latencies.sort((a, b) => a - b);
  const total = ok + errors;
  const rps = total / DURATION_S;
  const errorRatePct = total === 0 ? 100 : (errors / total) * 100;
  const result = {
    total,
    rps: Number(rps.toFixed(1)),
    p50Ms: Math.round(percentile(latencies, 50)),
    p95Ms: Math.round(percentile(latencies, 95)),
    p99Ms: Math.round(percentile(latencies, 99)),
    errorRatePct: Number(errorRatePct.toFixed(2)),
  };
  const pass =
    result.p95Ms <= scenario.target.p95Ms &&
    result.errorRatePct <= scenario.target.errorRatePct &&
    result.rps >= scenario.target.minRps;
  return { ...result, pass };
}

async function main() {
  const selected = scenarios.filter((s) => !ONLY || s.name === ONLY);
  console.log(
    `Load test → base=${BASE} duration=${DURATION_S}s concurrency=${CONCURRENCY}\n`,
  );
  let anyFail = false;
  for (const scenario of selected) {
    if (!scenario.ready()) {
      console.log(`⏭  ${scenario.name}: skipped (missing required env; not faked)`);
      continue;
    }
    const result = await runScenario(scenario);
    if (!result.pass) anyFail = true;
    console.log(
      `${result.pass ? "✅" : "❌"} ${scenario.name}: ` +
        `${result.rps} rps, p50=${result.p50Ms}ms p95=${result.p95Ms}ms p99=${result.p99Ms}ms, ` +
        `err=${result.errorRatePct}%  ` +
        `(target: p95≤${scenario.target.p95Ms}ms err≤${scenario.target.errorRatePct}% rps≥${scenario.target.minRps})`,
    );
  }
  if (anyFail) {
    console.error("\nOne or more scenarios missed their target.");
    process.exit(1);
  }
  console.log("\nAll enabled scenarios met their targets.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
