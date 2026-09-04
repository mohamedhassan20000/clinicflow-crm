import "server-only";

import { createClient as createSupabaseJs } from "@supabase/supabase-js";
import type { AuthedUser } from "@/lib/rbac";
import type { Database } from "@/types/database";

function createThrowawayAuthClient() {
  return createSupabaseJs<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
}

/** Verifies a fresh credential without replacing or refreshing the browser session. */
export async function verifyCurrentPasswordStepUp(
  user: AuthedUser,
  password: string,
): Promise<boolean> {
  const verifier = createThrowawayAuthClient();
  const result = await verifier.auth.signInWithPassword({
    email: user.email,
    password,
  });
  // `scope: "local"` is load-bearing, not a micro-optimization. supabase-js
  // defaults `signOut()` to `scope: "global"`, which asks GoTrue to revoke
  // *every* session for the user — including the browser session that is
  // mid-confirmation. Verifying a password would then sign the admin out and
  // bounce them to /login before the privileged action could report back.
  // "local" revokes only the throwaway session this function just created.
  if (!result.error) await verifier.auth.signOut({ scope: "local" });
  return !result.error && result.data.user?.id === user.id;
}
