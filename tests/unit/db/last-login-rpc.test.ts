import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260511203000_record_own_last_login_rpc.sql",
  ),
  "utf8",
);

describe("record own last login RPC migration", () => {
  it("adds a security-definer RPC for last-login tracking", () => {
    expect(migration).toContain(
      "create or replace function public.record_own_last_login",
    );
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = public, pg_temp");
  });

  it("only updates the authenticated user's profile row", () => {
    expect(migration).toContain("v_actor_id uuid := auth.uid()");
    expect(migration).toContain("where id = v_actor_id");
    expect(migration).not.toContain("p_user_id");
  });

  it("does not update deleted or inactive profiles", () => {
    expect(migration).toContain("and is_active = true");
    expect(migration).toContain("and is_deleted = false");
    expect(migration).toContain("and deleted_at is null");
  });
});
