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
};

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
  return {
    port,
    workerId: process.env.WORKER_ID?.trim() || `worker-${randomUUID().slice(0, 8)}`,
    supabaseUrl: required("SUPABASE_URL"),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    credentialsKey,
    apiToken,
    callbackSecret,
    appUrl: appUrl.origin,
  };
}
