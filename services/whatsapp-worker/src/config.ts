import { randomUUID } from "node:crypto";

/**
 * Every value this worker needs, resolved once at boot and never read from the
 * environment again. A missing value is a startup failure, not a runtime
 * surprise in the middle of a clinic's pairing.
 */
export type WorkerConfig = {
  port: number;
  /** Identifies this instance in the session rows it owns. */
  workerId: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  /** Base64 32 bytes — the same key the application uses for channel secrets. */
  credentialsKey: Buffer;
  /** Bearer token the application must present to this worker. */
  apiToken: string;
  /** HMAC secret this worker signs its callbacks to the application with. */
  callbackSecret: string;
  /** Origin of the ClinicFlow application, e.g. https://clinicflow.fit */
  appUrl: string;
  /**
   * Whether an outgoing one-to-one message may be addressed by LID when this
   * session has a WhatsApp-asserted LID for the recipient (see
   * `selectSendTarget`). On by default, and settable to `0`/`false` to pin every
   * send to the phone-number path without a code change — the LID branch in
   * Baileys 6.7.24 is not exercised by any mapping store of its own, so this
   * stays revertible from the environment.
   */
  outboundLidRouting: boolean;
  /**
   * Whether to ask the phone for the larger history window on a fresh link.
   * Settable to `0`/`false` for a clinic that does not want prior chats
   * imported at all — the live path is unaffected either way.
   */
  historySync: boolean;
  /** Largest attachment this worker will download and store, in bytes. */
  attachmentMaxBytes: number;
  /** Private bucket the downloaded attachments are written to. */
  attachmentBucket: string;
  /** Largest outbound storage object loaded into memory for one send. */
  outboundMediaMaxBytes: number;
  /**
   * Whether this instance may ask another worker to hand a session over.
   *
   * Off unless `WHATSAPP_DEV_TAKEOVER` says otherwise, and it exists for exactly
   * one situation: a developer running this worker on their laptop against the
   * same database a deployed worker is serving. With it on, a session refused as
   * owned elsewhere is *asked for* (`handoff_to`) instead of merely logged; the
   * holder releases it on its next heartbeat tick and this instance wins it on
   * the next reconcile, through the same fenced claim every other adoption uses.
   *
   * It never weakens the single-owner invariant: it cannot write `worker_id`,
   * cannot shorten the stale window, and cannot open a socket the previous
   * holder has not already closed. What it changes is only whether ownership can
   * move *on purpose* rather than only by shutdown or crash.
   *
   * Never set in production. A deployed worker with this on would fight a
   * developer's laptop for a live clinic every sixty seconds.
   */
  devTakeover: boolean;
};

function positiveInteger(name: string, fallback: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be a positive integer no greater than ${max}`);
  }
  return value;
}

/**
 * Worker ids are interpolated into PostgREST filter expressions (see
 * `Store.claimSession`), where a comma, parenthesis or dot is syntax rather than
 * text. Restricting the alphabet is what keeps that interpolation from being an
 * injection, and it costs an operator nothing: every id in use is a slug.
 */
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

export function loadConfig(): WorkerConfig {
  const credentialsKey = Buffer.from(required("MESSAGING_CREDENTIALS_KEY"), "base64");
  if (credentialsKey.length !== 32) {
    throw new Error("MESSAGING_CREDENTIALS_KEY must be base64-encoded 32 bytes");
  }
  const appUrl = new URL(required("CLINICFLOW_APP_URL"));
  const apiToken = required("WHATSAPP_WORKER_TOKEN");
  const callbackSecret = required("WHATSAPP_WORKER_CALLBACK_SECRET");
  // Short shared secrets are the only thing standing between the public
  // internet and every clinic's WhatsApp, so they are refused outright.
  if (apiToken.length < 32 || callbackSecret.length < 32) {
    throw new Error(
      "WHATSAPP_WORKER_TOKEN and WHATSAPP_WORKER_CALLBACK_SECRET must each be at least 32 characters",
    );
  }
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("PORT must be a valid TCP port");
  }
  const configuredWorkerId = process.env.WORKER_ID?.trim();
  if (configuredWorkerId && !WORKER_ID_PATTERN.test(configuredWorkerId)) {
    throw new Error(
      "WORKER_ID must be 1-64 characters of letters, digits, dot, underscore or hyphen",
    );
  }
  const devTakeover = /^(1|true|yes|on)$/i.test(process.env.WHATSAPP_DEV_TAKEOVER?.trim() ?? "");
  // A generated id changes on every restart, which would leave a trail of
  // handoff requests from workers that no longer exist and make the ownership
  // log unreadable at exactly the moment an operator is reading it. Takeover is
  // a deliberate act; it gets a deliberate name.
  if (devTakeover && !configuredWorkerId) {
    throw new Error("WHATSAPP_DEV_TAKEOVER requires an explicit WORKER_ID");
  }
  return {
    port,
    workerId: configuredWorkerId || `worker-${randomUUID().slice(0, 8)}`,
    devTakeover,
    supabaseUrl: required("SUPABASE_URL"),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    credentialsKey,
    apiToken,
    callbackSecret,
    appUrl: appUrl.origin,
    outboundLidRouting: !/^(0|false|no|off)$/i.test(
      process.env.WHATSAPP_OUTBOUND_LID_ROUTING?.trim() ?? "",
    ),
    historySync: !/^(0|false|no|off)$/i.test(process.env.WHATSAPP_HISTORY_SYNC?.trim() ?? ""),
    // Ten megabytes: comfortably above a phone photo or a scanned report, and
    // below the bucket's own 16 MB ceiling so the cap is enforced before the
    // upload rather than by it.
    attachmentMaxBytes: positiveInteger("WHATSAPP_ATTACHMENT_MAX_BYTES", 10 * 1024 * 1024, 16 * 1024 * 1024),
    attachmentBucket: process.env.WHATSAPP_ATTACHMENT_BUCKET?.trim() || "whatsapp-inbound",
    outboundMediaMaxBytes: positiveInteger(
      "WHATSAPP_OUTBOUND_MEDIA_MAX_BYTES",
      10 * 1024 * 1024,
      100 * 1024 * 1024,
    ),
  };
}
