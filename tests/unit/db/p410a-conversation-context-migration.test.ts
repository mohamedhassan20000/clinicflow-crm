import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260725120000_p410a_conversation_context.sql",
  "utf8",
);
// Executable SQL only, with `--` comment lines removed, so scope assertions
// below cannot be tripped by prose in the header comment.
const migrationSql = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");
const types = readFileSync("types/database.ts", "utf8");

describe("P4.10A conversation-context migration", () => {
  it("adds a session-scoped active_context jsonb column bounded to a JSON object", () => {
    expect(migration).toContain("alter table public.agent_conversations");
    expect(migration).toContain("add column active_context jsonb not null default '{}'::jsonb");
    expect(migration).toContain("check (jsonb_typeof(active_context) = 'object')");
  });

  it("clears the context when the conversation ends (archive), covering the session-scoped guarantee", () => {
    expect(migration).toContain(
      "create or replace function public.clear_agent_conversation_context()",
    );
    expect(migration).toContain("new.active_context := '{}'::jsonb");
    expect(migration).toContain("new.status = 'archived' and old.status is distinct from 'archived'");
    expect(migration).toContain("create trigger trg_agent_conversations_clear_context");
    expect(migration).toContain("before update on public.agent_conversations");
  });

  it("adds no new table, RLS policy, grant, or entitlement (rides on existing owner scope)", () => {
    expect(migrationSql).not.toMatch(/create table/i);
    expect(migrationSql).not.toMatch(/create policy/i);
    expect(migrationSql).not.toMatch(/enable row level security/i);
    expect(migrationSql).not.toMatch(/\bgrant\b/i);
  });

  it("stays inside P4.10A scope — no P4.10B entity types, no P4.11 workflow objects", () => {
    // P4.10A ships patients only; the other entity types and workflow ledger are
    // later phases and must not appear here.
    expect(migrationSql).not.toMatch(/ai_workflow_runs|ai\.workflows/i);
    expect(migrationSql).not.toMatch(/appointment_context|invoice_context|staff_context/i);
  });
});

describe("P4.10A generated database types", () => {
  it("exposes active_context on agent_conversations Row/Insert/Update", () => {
    const start = types.indexOf("agent_conversations: {");
    expect(start).toBeGreaterThan(-1);
    const block = types.slice(start, types.indexOf("Relationships:", start));

    const row = block.slice(block.indexOf("Row: {"), block.indexOf("Insert: {"));
    const insert = block.slice(block.indexOf("Insert: {"), block.indexOf("Update: {"));
    const update = block.slice(block.indexOf("Update: {"));

    // Non-nullable on Row (has a default), optional on Insert/Update.
    expect(row).toContain("active_context: Json");
    expect(insert).toContain("active_context?: Json");
    expect(update).toContain("active_context?: Json");
  });
});
