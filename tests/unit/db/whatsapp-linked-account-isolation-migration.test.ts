import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260907120000_whatsapp_linked_account_isolation.sql",
  "utf8",
).toLowerCase();

describe("linked WhatsApp account-isolation migration", () => {
  it("creates stable account boundaries and account-scoped identities", () => {
    expect(sql).toContain("create table if not exists public.whatsapp_linked_accounts");
    expect(sql).toContain("primary key (clinic_id, authenticated_account_id)");
    expect(sql).toContain("add column if not exists whatsapp_account_id");
    expect(sql).toContain("unique nulls not distinct (clinic_id, authenticated_account_id, participant_address)");
    expect(sql).toContain("unique nulls not distinct (clinic_id, authenticated_account_id, lid_jid)");
    expect(sql).toContain(
      "then coalesce(v_session.inbound_active_from, p_proposed_boundary, pg_catalog.now())",
    );
  });

  it("preserves ambiguous legacy rows and old-account spools", () => {
    expect(sql).toContain("deliberately not backfilled");
    expect(sql).toContain("'superseded'");
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdrop\s+table\b/);
    expect(sql).not.toMatch(/update\s+public\.conversations\s+set\s+whatsapp_account_id/);
  });

  it("fails closed in Inbox selection and scopes new conversation persistence", () => {
    expect(sql).toContain("if v_linked and v_account is null then return");
    expect(sql).toContain("c.whatsapp_account_id = v_account");
    expect(sql).toContain("public.persist_linked_device_inbound");
    expect(sql).toContain("public.open_linked_device_conversation");
    expect(sql).toContain("public.upsert_linked_device_history_chat");
    expect(sql).toContain("channel <> 'whatsapp'::public.message_channel");
    const contactsStart = sql.indexOf("public.upsert_linked_device_contacts");
    const contactsEnd = sql.indexOf("public.upsert_linked_device_lid_mappings", contactsStart);
    expect(sql.slice(contactsStart, contactsEnd)).not.toContain("public.conversations");
  });

  it("keeps rolling-deploy contact RPCs valid under the scoped constraints", () => {
    expect(sql).toContain("create or replace function public.upsert_whatsapp_contacts");
    expect(sql).toContain("create or replace function public.upsert_whatsapp_lid_mappings");
    expect(sql).toContain("on conflict on constraint whatsapp_contacts_account_unique");
    expect(sql).toContain(
      "on conflict on constraint whatsapp_lid_mappings_account_identity_unique",
    );
  });

  it("hides legacy NULL-scoped rows from the Inbox while an account is linked", () => {
    // The product decision this encodes: legacy rows are mixed across accounts
    // with no trustworthy provenance, so once a real account is linked they are
    // simply not this account's traffic. They are kept, not shown, and never
    // adopted — which is why the branch is a comparison, not a coalesce.
    const branch = "then whatsapp_account_id = public.current_whatsapp_linked_account_id()";
    expect(sql).toContain(branch);
    // ...and only when no linked-device channel is active does the NULL scope
    // become visible again, so a clinic that has never paired is unaffected.
    expect(sql).toContain("else whatsapp_account_id is null end");
    expect(sql).not.toContain("coalesce(whatsapp_account_id");
  });

  it("scopes every account-bearing surface, not only conversations", () => {
    // Metadata leaks through the edges: an attachment row, a media row, a
    // contact label or a LID alias read across accounts is the same disclosure
    // as the message itself.
    for (const policy of [
      "whatsapp_account_isolation_conversations",
      "whatsapp_account_isolation_inbound_messages",
      "whatsapp_account_isolation_outbound_messages",
      "whatsapp_account_isolation_inbound_attachments",
      "whatsapp_account_isolation_outbound_media",
      "inbox_staff_read_whatsapp_contacts",
    ]) {
      expect(sql).toContain(`create policy "${policy}"`);
    }
    expect(sql).toContain(
      "and authenticated_account_id = public.current_whatsapp_linked_account_id()",
    );
    // The isolation policies are restrictive: they intersect with the existing
    // tenant policies rather than offering an alternative way in.
    expect(sql.match(/as restrictive for select to authenticated/g)?.length).toBeGreaterThanOrEqual(5);
  });
});
