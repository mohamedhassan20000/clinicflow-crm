import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`${name} is required for integration tests`); return value; }
const serviceKey = required("LOCAL_SUPABASE_SECRET_KEY");
const anonKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");

describe("P1.5D applied schema and RLS", () => {
  const service = createClient<Database>(url, serviceKey, { auth: { persistSession: false } });
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });

  it.each([
    ["50003000", "KW", "+96550003000"],
    ["01012345678", "EG", "+201012345678"],
    ["4155552671", "US", "4155552671"],
    ["5551234567", "ZZ", "5551234567"],
    ["garbage-input", "KW", "garbage-input"],
  ])("backfills %s conservatively", async (value, country, expected) => {
    const result = await service.rpc("normalize_legacy_phone_e164", { value, default_country: country });
    expect(result.error).toBeNull();
    expect(result.data).toBe(expected);
  });

  it("denies anonymous FX reads", async () => {
    const result = await anon.from("fx_rates").select("currency_code, provider_timestamp, fetched_at");
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("42501");
  });
});
