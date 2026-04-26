import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/types/database";

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Match the server: implicit flow avoids the PKCE verifier cookie that
      // can fail to round-trip across deployment URLs.
      auth: { flowType: "implicit" },
    },
  );
}
