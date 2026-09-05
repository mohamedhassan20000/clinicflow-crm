import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260819120000_p8b_whatsapp_full_inbox_media.sql"),
  "utf8",
);

function functionBody(name: string): string {
  const match = migration.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "i"));
  if (!match) throw new Error(`missing function ${name}`);
  return match[0];
}

describe("P8B full Inbox/media migration", () => {
  it("opens a conversation without any patient insert path", () => {
    const body = functionBody("open_whatsapp_conversation");
    expect(body).toMatch(/p_participant !~ '\^\\\+\[1-9\]/);
    expect(body).not.toMatch(/insert\s+into\s+public\.patients/i);
    expect(migration).toContain("grant execute on function public.open_whatsapp_conversation");
    expect(migration).toMatch(/to service_role;/);
  });

  it("makes outbound media tenant-pinned, private, and unwritable by authenticated clients", () => {
    expect(migration).toContain("foreign key (conversation_id, clinic_id)");
    expect(migration).toContain("storage_path like clinic_id::text || '/%'");
    expect(migration).toContain("'whatsapp-outbound',\n  'whatsapp-outbound',\n  false");
    expect(migration).toContain("grant select on table public.outbound_message_media to authenticated");
    expect(migration).not.toMatch(/create policy[\s\S]{0,200}outbound_message_media[\s\S]{0,200}for (insert|update|delete)/i);
  });

  it("claims a draft exactly once and carries provenance for send-time reauthorization", () => {
    const body = functionBody("claim_outbound_media");
    expect(body).toContain("source_record_id uuid");
    expect(body).toContain("m.status = 'draft'");
    expect(body).toContain("set status = 'sending'");
    expect(body).toContain("m.source_record_id");
  });

  it("does not grant contact writes or media state changes to Inbox staff", () => {
    expect(migration).toContain("grant select on table public.whatsapp_contacts to authenticated");
    expect(migration).toContain("grant all on table public.whatsapp_contacts to service_role");
    expect(migration).not.toMatch(/grant (insert|update|delete|all) on table public\.whatsapp_contacts to authenticated/i);
    expect(migration).not.toMatch(/grant (insert|update|delete|all) on table public\.outbound_message_media to authenticated/i);
  });
});
