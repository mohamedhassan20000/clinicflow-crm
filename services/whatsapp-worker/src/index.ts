import type { Server } from "node:http";
import pino from "pino";
import { loadConfig } from "./config.ts";
import { installConsoleGuard } from "./log-guard.ts";
import { createWorkerServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

// Before anything else runs. `libsignal`, underneath Baileys, prints Signal
// session records — private keys, root keys, the remote identity key — to the
// global console during ordinary message traffic, and there is no setting that
// turns it off. Installed at module scope rather than inside `main()` so a
// failure to boot cannot leave the process running unguarded. See log-guard.ts.
installConsoleGuard();

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
  logger.info(
    { port: config.port, workerId: config.workerId, devTakeover: config.devTakeover },
    "whatsapp worker listening",
  );

  // Two processes sharing one `WORKER_ID` is the single configuration mistake
  // the ownership check cannot survive: each reads the other's stamp as its own,
  // both admit themselves, and both open a socket on the same linked device.
  // Nothing this process has written yet, so a *fresh* heartbeat under our own
  // id can only have come from somebody else.
  const collisions = await store.listLiveSessionsOwnedByThisWorkerId().catch((error: unknown) => {
    logger.warn({ err: error }, "could not check for a worker id collision");
    return [] as string[];
  });
  if (collisions.length > 0) {
    // Fatal only when takeover is on. A production worker restarted hard —
    // SIGKILL, an OOM, a platform-level replacement — legitimately finds its own
    // stamp still fresh on rows nobody released, and refusing to boot there
    // would turn a crash into an outage. With takeover on, the operator is
    // deliberately running a second worker and the collision is the mistake this
    // check exists to catch.
    const detail = { workerId: config.workerId, clinics: collisions.length };
    if (config.devTakeover) {
      throw new Error(
        `WORKER_ID "${config.workerId}" is already held by a live worker. ` +
          "Development takeover needs its own id — reusing the deployed worker's id would let both open the same session.",
      );
    }
    logger.warn(
      detail,
      "sessions already carry this worker id with a fresh heartbeat; assuming a hard restart, but a second live worker with the same WORKER_ID would be split brain",
    );
  }

  // Sessions come back before anything else happens, so a redeploy restores
  // every clinic's connection without a single new scan.
  await sessions.restoreAll();

  const heartbeat = setInterval(() => {
    // The tick is the manager's now rather than the store's, because it does two
    // things that have to happen together: it refreshes the rows this worker
    // still owns, and it acts on the ones it *no longer* owns. The scoped
    // `UPDATE` answers both questions in one statement — see
    // `SessionManager.heartbeat` — and a clinic that fails to renew is fenced
    // off locally on the spot rather than waiting for a sweep to notice.
    void sessions
      .heartbeat()
      .catch((error: unknown) => {
        logger.warn({ err: error }, "heartbeat failed");
      })
      // On the same tick, and after it: a session this worker is about to give
      // away should not have had its heartbeat refreshed a moment later by a
      // concurrent pass. Every worker runs this, which is what lets ownership
      // move on purpose rather than only by shutdown or crash.
      .then(() =>
        sessions.honorHandoffs().catch((error: unknown) => {
          logger.warn({ err: error }, "handoff sweep failed");
        }),
      );
  }, HEARTBEAT_INTERVAL_MS);

  const reconcile = setInterval(() => {
    void sessions.reconcile().catch((error: unknown) => {
      logger.warn({ err: error }, "reconcile failed");
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
        logger.warn({ err: error }, "session shutdown failed");
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
