import type { Server } from "node:http";
import pino from "pino";
import { loadConfig } from "./config.ts";
import { createWorkerServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

/** Keeps the session rows this instance owns visibly alive to any other. */
const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * How often the worker re-checks that it is holding every session a clinic
 * asked for. This is what makes a platform redeploy self-healing: the new
 * instance may boot while the old one still owns the rows, and this sweep picks
 * them up as soon as the old one lets go.
 */
const RECONCILE_INTERVAL_MS = 60_000;
/** A shutdown that cannot finish must still not hang the platform's redeploy. */
const SHUTDOWN_GRACE_MS = 10_000;

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config);
  const sessions = new SessionManager(config, store);
  const server = createWorkerServer(config, sessions, store);

  // Bind on every interface: the platform routes to the container from outside
  // its own loopback, and an implicit bind is the classic reason a healthy
  // process still fails its health check. `::` is dual-stack, which is what
  // Railway's private network needs and still answers IPv4; a host without
  // IPv6 falls back rather than failing to boot.
  await listen(server, config.port, "::").catch(() => listen(server, config.port, "0.0.0.0"));
  logger.info({ port: config.port, workerId: config.workerId }, "whatsapp worker listening");

  // Sessions come back before anything else happens, so a redeploy restores
  // every clinic's connection without a single new scan.
  await sessions.restoreAll();

  const heartbeat = setInterval(() => {
    void store.heartbeat(sessions.clinicIds()).catch((error: unknown) => {
      logger.warn({ error }, "heartbeat failed");
    });
  }, HEARTBEAT_INTERVAL_MS);

  const reconcile = setInterval(() => {
    void sessions.reconcile().catch((error: unknown) => {
      logger.warn({ error }, "reconcile failed");
    });
  }, RECONCILE_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    // A platform that sends SIGTERM twice must not restart the teardown.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    clearInterval(heartbeat);
    clearInterval(reconcile);
    // Never hang a deploy on a socket that will not close. Armed before the
    // teardown starts so a hung release cannot outlast it either.
    const failsafe = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
    failsafe.unref();
    void sessions
      .shutdown()
      .catch((error: unknown) => {
        logger.warn({ error }, "session shutdown failed");
      })
      .finally(() => {
        server.close(() => process.exit(0));
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  // `err`, not `error`: pino only applies its error serializer to that key, and
  // a boot failure logged as `error={}` tells an operator nothing at all. The
  // messages thrown here are configuration diagnostics ("PORT must be a valid
  // TCP port"), never secret values.
  logger.fatal({ err: error }, "worker failed to start");
  process.exit(1);
});
