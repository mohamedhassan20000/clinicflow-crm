import { createHmac } from "node:crypto";
import type { WorkerConfig } from "./config.ts";

/**
 * The one way traffic leaves this worker for ClinicFlow.
 *
 * The application's /api/webhooks/whatsapp/linked-device route is the same
 * pipeline Cloud API traffic goes through, so nothing here writes to the inbox
 * itself: it hands over normalized events and lets the application decide what
 * they mean. Each request is signed with HMAC-SHA256 over `timestamp.body` so
 * the receiver can prove both origin and integrity, and reject a replay.
 */

export type CallbackEvent =
  | {
      kind: "inbound";
      providerMessageId: string;
      sender: string;
      body: string;
      receivedAt: string;
    }
  | {
      kind: "outbound_echo";
      providerMessageId: string;
      recipient: string;
      body: string;
      occurredAt: string;
    }
  | {
      kind: "status";
      providerMessageId: string;
      status: "sent" | "delivered" | "read" | "failed";
      occurredAt: string;
    };

const TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;

export class CallbackClient {
  // Not a constructor parameter property: `node --experimental-strip-types`
  // runs this source directly in development and cannot desugar those.
  private readonly config: WorkerConfig;

  constructor(config: WorkerConfig) {
    this.config = config;
  }

  async post(clinicId: string, sessionPhone: string, events: readonly CallbackEvent[]): Promise<boolean> {
    if (events.length === 0) return true;
    const body = JSON.stringify({ clinicId, sessionPhone, events });

    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      // The timestamp is re-signed per attempt so a slow retry cannot fall
      // outside the receiver's replay window.
      const timestamp = String(Date.now());
      const signature = createHmac("sha256", this.config.callbackSecret)
        .update(`${timestamp}.${body}`, "utf8")
        .digest("hex");
      try {
        const response = await fetch(
          new URL("/api/webhooks/whatsapp/linked-device", this.config.appUrl),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-clinicflow-signature": signature,
              "x-clinicflow-timestamp": timestamp,
            },
            body,
            signal: AbortSignal.timeout(TIMEOUT_MS),
          },
        );
        if (response.ok) return true;
        // 4xx is a decision, not a hiccup: retrying an unauthorized or
        // malformed callback would only repeat it.
        if (response.status < 500) return false;
      } catch {
        // Network failure — fall through to the backoff below.
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
    return false;
  }
}
