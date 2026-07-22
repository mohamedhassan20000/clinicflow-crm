import "server-only";

import { createClient } from "@/lib/supabase/server";

const READINESS_TTL_MS = 60_000;

let cachedReadiness: { value: boolean; expiresAt: number } | null = null;
let readinessInFlight: Promise<boolean> | null = null;

async function probeAssistantPersistence(): Promise<boolean> {
  try {
    const supabase = await createClient();
    // Read at most one identifier from each RLS-protected table. This verifies
    // deployment readiness without loading conversation history or messages.
    const [conversations, messages] = await Promise.all([
      supabase.from("agent_conversations").select("id").limit(1),
      supabase.from("agent_messages").select("id").limit(1),
    ]);
    return !conversations.error && !messages.error;
  } catch {
    return false;
  }
}

/**
 * Lightweight deployment-level persistence signal used by closed launchers.
 * The short module cache avoids repeating the same schema probe across pages
 * and nested launchers while still recovering quickly after a migration lands.
 */
export async function isAssistantPersistenceReady(): Promise<boolean> {
  const now = Date.now();
  if (cachedReadiness && cachedReadiness.expiresAt > now) {
    return cachedReadiness.value;
  }
  if (readinessInFlight) return readinessInFlight;

  readinessInFlight = probeAssistantPersistence()
    .then((value) => {
      cachedReadiness = { value, expiresAt: Date.now() + READINESS_TTL_MS };
      return value;
    })
    .finally(() => {
      readinessInFlight = null;
    });
  return readinessInFlight;
}
