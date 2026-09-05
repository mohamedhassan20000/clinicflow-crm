import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The WhatsApp account boundary must not move when the linked device drops.
 *
 * ## The regression this pins
 *
 * Manual QA on a clinic with three live threads: disconnect the linked device
 * and the Inbox fills with old imported conversations; reconnect and they
 * disappear again. Both the list RPC and the five restrictive policies chose
 * their account branch from `clinic_channels ... status = 'active'` — the
 * *transport* row, which the worker deletes on teardown, which
 * `disconnectLinkedDeviceSession` deletes outright, and which is `pending` for
 * a moment on every re-pair. So a connection event silently re-decided an
 * identity question, and the legacy `whatsapp_account_id is null` fallback —
 * meant only for clinics that have never linked anything — was handed to a
 * clinic that merely had a socket down.
 *
 * These tests guard the two ways it comes back: someone re-introduces a
 * `status = 'active'` (or any other transport/session state) test into the
 * boundary, or someone widens the legacy fallback.
 */

const PATH =
  "supabase/migrations/20260910120000_whatsapp_account_boundary_is_identity.sql";
const raw = readFileSync(PATH, "utf8");
const sql = raw.toLowerCase();
/** The migration with `--` commentary stripped: the statements Postgres runs. */
const code = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const AFFECTED_POLICIES = [
  "whatsapp_account_isolation_conversations",
  "whatsapp_account_isolation_inbound_messages",
  "whatsapp_account_isolation_outbound_messages",
  "whatsapp_account_isolation_inbound_attachments",
  "whatsapp_account_isolation_outbound_media",
] as const;

function policyBody(name: string): string {
  const start = code.indexOf(`create policy "${name}"`);
  expect(start, `${name} is re-created here`).toBeGreaterThanOrEqual(0);
  const end = code.indexOf(";", start);
  return code.slice(start, end);
}

/** The body of a `create or replace function` statement, by name. */
function functionBody(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}`);
  expect(start, `${name} is defined here`).toBeGreaterThanOrEqual(0);
  const open = code.indexOf("as $$", start);
  const close = code.indexOf("$$;", open);
  return code.slice(open, close);
}

describe("the account boundary is identity, not connection", () => {
  it("resolves the boundary from the proved account, then the durable ledger", () => {
    const body = functionBody("current_whatsapp_account_boundary()");
    expect(body).toContain("whatsapp_linked_device_sessions");
    expect(body).toContain("authenticated_account_id");
    expect(body).toContain("whatsapp_linked_accounts");
    // Never from the socket, the desired state or the session status.
    expect(body).not.toContain("desired_state");
    expect(body).not.toContain("qr_payload");
    expect(body).not.toMatch(/\bs\.status\b/);
  });

  it("never lets a channel status decide which account is current", () => {
    // `whatsapp_account_boundary_required()` may look at `clinic_channels` —
    // that is how a clinic mid-pairing fails closed instead of falling back —
    // but it must not filter on the row's *status*, because that is exactly
    // the transport signal that flipped the boundary on every disconnect.
    const required = functionBody("whatsapp_account_boundary_required()");
    expect(required).toContain("clinic_channels");
    expect(required).not.toContain("clinic_channel_status");
    expect(required).not.toMatch(/cc\.status/);
  });

  it("keeps the boundary out of every policy's own predicate", () => {
    for (const name of AFFECTED_POLICIES) {
      const body = policyBody(name);
      expect(body).toContain("public.whatsapp_account_boundary_required()");
      expect(body).toContain("public.current_whatsapp_account_boundary()");
      // The two things a policy must never re-derive for itself.
      expect(body).not.toContain("clinic_channels");
      expect(body).not.toContain("whatsapp_linked_device_sessions");
    }
  });

  it("keeps every policy restrictive and select-only", () => {
    for (const name of AFFECTED_POLICIES) {
      const body = policyBody(name);
      expect(body).toContain("as restrictive for select to authenticated");
      expect(body).not.toContain("for all");
      expect(body).not.toContain("with check");
    }
  });

  it("keeps the legacy NULL scope as the only fallback, and only when no boundary applies", () => {
    for (const name of AFFECTED_POLICIES) {
      const body = policyBody(name);
      // Exactly one CASE, and its else-branch is the legacy scope.
      expect(body).toContain("else");
      expect(body).toMatch(/whatsapp_account_id is null end/);
    }
    // The list RPC applies the same shape.
    expect(code).toMatch(/else c\.whatsapp_account_id is null end/);
  });

  it("fails the list RPC closed when a boundary applies but no account is proved", () => {
    expect(code).toContain("if v_linked and v_account is null then return; end if;");
  });

  it("scopes the list RPC by the identity boundary rather than the active channel", () => {
    const start = code.indexOf(
      "create or replace function public.get_inbox_conversation_summaries",
    );
    const body = code.slice(start);
    expect(body).toContain("whatsapp_linked_accounts");
    expect(body).toContain("whatsapp_linked_device_sessions");
    // The exact predicate the regression was caused by.
    expect(body).not.toContain("clinic_channel_status");
    expect(body).not.toContain("cc.status = 'active'");
  });

  it("keeps the contact directory on the same boundary", () => {
    const start = code.indexOf('create policy "inbox_staff_read_whatsapp_contacts"');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = code.slice(start, code.indexOf(";", start));
    expect(body).toContain("public.current_whatsapp_account_boundary()");
    expect(body).toContain("public.auth_clinic_id()");
    expect(body).toContain("public.auth_role()");
  });

  it("grants the helpers to staff and to nobody else", () => {
    for (const fn of [
      "current_whatsapp_account_boundary()",
      "whatsapp_account_boundary_required()",
    ]) {
      expect(code).toContain(`revoke all on function public.${fn} from public, anon;`);
      expect(code).toContain(
        `grant execute on function public.${fn}\n  to authenticated, service_role;`,
      );
    }
  });

  it("takes no clinic argument, so it cannot be aimed at another tenant", () => {
    for (const fn of [
      "current_whatsapp_account_boundary",
      "whatsapp_account_boundary_required",
    ]) {
      expect(code).toContain(`create or replace function public.${fn}()`);
      expect(functionBody(`${fn}()`)).toContain("public.auth_clinic_id()");
    }
  });

  it("is additive: it reads, writes, backfills and drops no data", () => {
    expect(code).not.toMatch(/\bdelete\s+from\b/);
    expect(code).not.toMatch(/\bupdate\s+public\./);
    expect(code).not.toMatch(/\binsert\s+into\b/);
    expect(code).not.toMatch(/\bdrop\s+(table|column|constraint)\b/);
    expect(code).not.toMatch(/\balter\s+table\b/);
  });

  it("keeps both helpers stable and security definer with a pinned search path", () => {
    for (const fn of [
      "current_whatsapp_account_boundary",
      "whatsapp_account_boundary_required",
    ]) {
      const start = code.indexOf(`create or replace function public.${fn}()`);
      const header = code.slice(start, code.indexOf("as $$", start));
      expect(header).toContain("stable");
      expect(header).toContain("security definer");
      expect(header).toContain("set search_path = ''");
    }
  });
});
