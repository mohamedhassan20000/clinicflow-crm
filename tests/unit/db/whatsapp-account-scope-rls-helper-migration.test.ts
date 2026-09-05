import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The RLS boundary fix for WhatsApp account isolation.
 *
 * ## What broke
 *
 * The five `whatsapp_account_isolation_*` policies from 2026-09-07 chose their
 * account branch with `exists (select 1 from public.clinic_channels ...)`. A
 * policy subquery is planned as the *querying* role, and `clinic_channels` is
 * deny-all for `authenticated` on purpose — it holds channel credentials. So
 * that EXISTS was unconditionally false for every staff session, the CASE fell
 * to `else whatsapp_account_id is null`, and every row on the clinic's live
 * linked account became invisible to authenticated reads.
 *
 * These tests are the guard against the two ways this comes back: someone
 * re-adds a `clinic_channels` probe to a policy, or someone "fixes" the deny-all
 * by granting staff a read of the credentials table.
 */

const FIX_PATH = "supabase/migrations/20260909120000_whatsapp_account_scope_rls_helper.sql";
const ORIGIN_PATH =
  "supabase/migrations/20260907120000_whatsapp_linked_account_isolation.sql";

const raw = readFileSync(FIX_PATH, "utf8");
const sql = raw.toLowerCase();
const origin = readFileSync(ORIGIN_PATH, "utf8").toLowerCase();
/** The migration with `--` commentary stripped: the statements Postgres runs. */
const code = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

/** The five restrictive policies the 2026-09-07 migration got wrong. */
const AFFECTED_POLICIES = [
  "whatsapp_account_isolation_conversations",
  "whatsapp_account_isolation_inbound_messages",
  "whatsapp_account_isolation_outbound_messages",
  "whatsapp_account_isolation_inbound_attachments",
  "whatsapp_account_isolation_outbound_media",
] as const;

/** Everything from `create policy "<name>"` up to the statement's terminator. */
function policyBody(source: string, name: string): string {
  const start = source.indexOf(`create policy "${name}"`);
  expect(start, `${name} is not created`).toBeGreaterThan(-1);
  const end = source.indexOf("\ndrop policy", start);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("WhatsApp account-scope RLS helper migration", () => {
  it("names every policy the unreachable clinic_channels probe actually broke", () => {
    // The audit, pinned. Each of these probed `clinic_channels` in the original
    // migration and each is re-created here; if a sixth one is ever written the
    // same way, this list is where it has to be added.
    for (const name of AFFECTED_POLICIES) {
      expect(policyBody(origin, name)).toContain("from public.clinic_channels cc");
      expect(sql).toContain(`create policy "${name}"`);
    }
    // `inbox_staff_read_whatsapp_contacts` is the sixth policy in that migration
    // and is deliberately *not* here: it never probed `clinic_channels`, so it
    // does not carry this defect and is left exactly as it is.
    expect(policyBody(origin, "inbox_staff_read_whatsapp_contacts")).not.toContain(
      "clinic_channels",
    );
    expect(sql).not.toContain("inbox_staff_read_whatsapp_contacts");
  });

  it("leaves no policy reaching into clinic_channels", () => {
    for (const name of AFFECTED_POLICIES) {
      expect(policyBody(sql, name)).not.toContain("clinic_channels");
    }
    // The table is named exactly once in the whole migration: inside the
    // security-definer helper, which is the only context that can read it.
    // In the executable statements the table is named exactly once: inside the
    // security-definer helper, the only context that can read it. (The file's
    // header comment explains the defect and names it too, hence `code`.)
    const helperStart = code.indexOf(
      "create or replace function public.whatsapp_linked_device_active",
    );
    const helperEnd = code.indexOf("$$;", helperStart);
    expect(code.split("from public.clinic_channels").length - 1).toBe(1);
    expect(code.indexOf("from public.clinic_channels")).toBeGreaterThan(helperStart);
    expect(code.indexOf("from public.clinic_channels")).toBeLessThan(helperEnd);
  });

  it("exposes the boundary fact and nothing else", () => {
    expect(sql).toContain("create or replace function public.whatsapp_linked_device_active()");
    expect(sql).toContain("returns boolean");
    // No clinic argument: the tenant is always the caller's own, so the helper
    // cannot be aimed at another clinic.
    expect(sql).toMatch(/whatsapp_linked_device_active\(\)\s*\nreturns boolean/);
    expect(sql).toContain("cc.clinic_id = public.auth_clinic_id()");
    // Nothing that could carry a secret out of `clinic_channels` is selected.
    const helper = sql.slice(
      sql.indexOf("create or replace function public.whatsapp_linked_device_active"),
      sql.indexOf("$$;", sql.indexOf("create or replace function public.whatsapp_linked_device_active")),
    );
    for (const secret of [
      "credentials_encrypted",
      "sender_identity",
      "qr_payload",
      "authenticated_account_lid",
      "phone_number",
    ]) {
      expect(helper).not.toContain(secret);
    }
    expect(helper).not.toContain("select cc.");
    expect(helper).not.toContain("select s.");
  });

  it("is hardened the way a security-definer helper has to be", () => {
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain("stable");
    // Least privilege: never anon, never PUBLIC.
    expect(sql).toContain("revoke all on function public.whatsapp_linked_device_active() from public, anon");
    expect(sql).toContain(
      "grant execute on function public.whatsapp_linked_device_active()\n  to authenticated, service_role",
    );
    // Volatile would be wrong on a read helper, and a volatile function in a
    // policy is re-planned per row.
    expect(sql).not.toContain("volatile");
  });

  it("keeps clinic_channels unreadable to authenticated", () => {
    expect(sql).toContain("alter table public.clinic_channels enable row level security");
    expect(sql).not.toMatch(/create policy[^;]*on public\.clinic_channels/);
    expect(sql).not.toMatch(/grant[^;]*on\s+(table\s+)?public\.clinic_channels/);
    expect(sql).not.toContain("disable row level security");
  });

  it("preserves the legacy rule exactly rather than widening it", () => {
    for (const name of AFFECTED_POLICIES) {
      const body = policyBody(sql, name);
      expect(body).toContain("as restrictive for select to authenticated");
      expect(body).toContain("public.whatsapp_linked_device_active()");
      // An active account exposes that account and only that account...
      expect(body).toContain("public.current_whatsapp_linked_account_id()");
      // ...and with no linked device the legacy NULL scope comes back, exactly
      // as it did before. A comparison, never a coalesce: a legacy row is
      // never adopted into a linked account.
      expect(body).toMatch(/whatsapp_account_id is null end/);
      expect(body).not.toContain("coalesce(");
    }
  });

  it("changes only who can evaluate the branch, not the branch", () => {
    // The replacement predicate is the original with the unreachable EXISTS
    // swapped for the helper. Normalizing whitespace, every policy still reads
    // as the same CASE.
    const flat = (text: string) => text.replace(/\s+/g, " ");
    for (const name of AFFECTED_POLICIES) {
      expect(flat(policyBody(sql, name))).toContain(
        "case when public.whatsapp_linked_device_active() then",
      );
    }
  });

  it("touches no data and no shape", () => {
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdrop\s+table\b/);
    expect(sql).not.toMatch(/\bdrop\s+function\b/);
    expect(sql).not.toMatch(/\bupdate\s+public\./);
    expect(sql).not.toMatch(/\binsert\s+into\b/);
    expect(sql).not.toMatch(/add\s+column/);
    expect(sql).not.toMatch(/drop\s+column/);
    // Only the five broken policies are dropped, and each is immediately
    // re-created in the same file.
    const dropped = [...raw.matchAll(/drop policy if exists "([^"]+)"/g)].map((m) => m[1]);
    expect(dropped.sort()).toEqual([...AFFECTED_POLICIES].sort());
  });

  it("leaves service-role behaviour alone", () => {
    // These policies are `to authenticated`; service_role bypasses RLS and is
    // never named as a policy role here.
    expect(sql).not.toMatch(/for select to service_role/);
    expect(sql).not.toMatch(/revoke[^;]*from[^;]*service_role/);
    for (const name of AFFECTED_POLICIES) {
      expect(policyBody(sql, name)).toContain("to authenticated");
      expect(policyBody(sql, name)).not.toContain("service_role");
    }
  });
});
