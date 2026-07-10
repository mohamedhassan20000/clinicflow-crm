import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizePhone(value: string): string {
  return value.trim();
}

export async function requestIp(): Promise<string> {
  const requestHeaders = await headers();
  // Vercel normalizes x-forwarded-for before it reaches the application. A
  // self-hosted deployment must configure a trusted proxy before relying on it.
  return (
    requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? requestHeaders.get("x-real-ip")
    ?? "unknown"
  );
}
