import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260718210000_p4_manual_testing_assistant_permissions.sql",
  ),
  "utf8",
);

describe("P4 manual Assistant permissions migration", () => {
  it("makes clinic page customization management admin-only", () => {
    expect(migration).toContain('create policy "Admins can manage clinic page permissions"');
    expect(migration).toContain("public.auth_role() = 'admin'::public.user_role");
    expect(migration).toContain('drop policy if exists "Admins and managers can manage clinic page permissions"');
  });

  it("registers Assistant for every active normal clinic role without overwriting saved choices", () => {
    for (const role of ["admin", "manager", "doctor", "receptionist"]) {
      expect(migration).toContain(`'${role}'::public.user_role`);
    }
    expect(migration).toContain("'assistant'");
    expect(migration).toContain("and p.is_active = true");
    expect(migration).toContain("on conflict (user_id, page_slug) do nothing");
  });

  it("allows owner-scoped general staff conversations but reserves patient context for doctors", () => {
    expect(migration).toContain("user_id = auth.uid()");
    expect(migration).toMatch(/patient_id is null\s+or public\.auth_role\(\) = 'doctor'/);
  });
});
