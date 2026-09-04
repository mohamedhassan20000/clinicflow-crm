import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260912120000_p18_admin_audit_trail.sql"),
  "utf8",
);

/** The migration minus its commentary, for assertions about what it *does*. */
const executable = sql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("P18 — administrative audit trail migration contract", () => {
  it("creates the canonical table with the documented shape", () => {
    expect(sql).toContain("create table if not exists public.admin_audit_events");
    for (const column of [
      "clinic_id uuid not null references public.clinics(id) on delete cascade",
      "occurred_at timestamptz not null default clock_timestamp()",
      "actor_type text not null",
      "actor_user_id uuid references public.profiles(id) on delete set null",
      "actor_role public.user_role",
      "actor_display text",
      "module text not null",
      "action text not null",
      "entity_type text not null",
      "entity_id uuid",
      "entity_ref text",
      "before jsonb",
      "after jsonb",
      "changed_fields text[] not null default '{}'::text[]",
      "source text not null",
      "outcome text not null default 'success'",
      "failure_code text",
      "correlation_id uuid",
      "metadata jsonb not null default '{}'::jsonb",
    ]) {
      expect(sql).toContain(column);
    }
  });

  it("keeps a non-staff actor from carrying a human identity", () => {
    expect(sql).toContain("constraint admin_audit_events_actor_shape_check");
    expect(sql).toContain("check (actor_type = 'staff' or actor_user_id is null)");
  });

  it("constrains the vocabularies rather than accepting free text", () => {
    expect(sql).toContain("check (actor_type in ('staff', 'system', 'integration'))");
    expect(sql).toContain("check (source in ('staff_web', 'system', 'whatsapp'))");
    expect(sql).toContain("check (outcome in ('success', 'failure'))");
    expect(sql).toMatch(/action text not null check \(action ~ '\^\[a-z\]/);
  });

  it("indexes exactly the four queries the feed and entity history run", () => {
    expect(sql).toContain("admin_audit_events_feed_idx");
    expect(sql).toContain("(clinic_id, occurred_at desc, id desc)");
    expect(sql).toContain("admin_audit_events_module_idx");
    expect(sql).toContain("(clinic_id, module, occurred_at desc)");
    expect(sql).toContain("admin_audit_events_actor_idx");
    expect(sql).toContain("admin_audit_events_entity_idx");
    // The merged feed also reads the pre-existing operational trail newest-first,
    // which had no (clinic, time) index of its own.
    expect(sql).toContain("activity_events_clinic_time_idx");
  });

  it("is append-only for every authenticated role", () => {
    expect(sql).toContain("alter table public.admin_audit_events enable row level security");
    expect(sql).toContain(
      "revoke all on table public.admin_audit_events from anon, authenticated",
    );
    expect(sql).toContain("grant select on table public.admin_audit_events to authenticated");
    // A single SELECT policy and no others: inserts, updates and deletes have no
    // policy to satisfy and are refused outright.
    expect(sql.match(/create policy "admin_audit_events_[a-z_]+"/g)).toHaveLength(1);
    expect(sql).not.toMatch(/on public\.admin_audit_events\s+for (insert|update|delete)/);
  });

  it("scopes reads to the clinic, and AI configuration to admins", () => {
    expect(sql).toContain("clinic_id = public.auth_clinic_id()");
    expect(sql).toContain("public.auth_role() = 'admin'::public.user_role");
    expect(sql).toContain("public.auth_role() = 'manager'::public.user_role");
    expect(sql).toContain("and module <> 'ai'");
  });

  it("stamps identity in one SECURITY DEFINER writer that no caller can reach", () => {
    expect(sql).toContain("create or replace function public.write_admin_audit_event");
    expect(sql).toContain("v_actor uuid := auth.uid()");
    expect(sql).toContain("select p.role, p.full_name");
    expect(sql).toMatch(
      /revoke all on function public\.write_admin_audit_event\([\s\S]*?\) from public, anon, authenticated;/,
    );
    // No exception handler: a rejected audit row aborts the mutation that caused it.
    expect(sql).not.toMatch(/write_admin_audit_event[\s\S]*?exception\s+when/);
  });

  it("covers the high-value mutations with in-transaction row triggers", () => {
    for (const [trigger, table] of [
      ["trg_admin_audit_departments", "public.departments"],
      ["trg_admin_audit_services", "public.services"],
      ["trg_admin_audit_insurance_providers", "public.insurance_providers"],
      ["trg_admin_audit_profiles", "public.profiles"],
      ["trg_admin_audit_page_permissions", "public.user_page_permissions"],
      ["trg_admin_audit_report_permissions", "public.user_report_permissions"],
      ["trg_admin_audit_ai_permissions", "public.user_ai_permissions"],
      ["trg_admin_audit_clinics", "public.clinics"],
      ["trg_admin_audit_linked_device", "public.whatsapp_linked_device_sessions"],
    ] as const) {
      expect(sql).toContain(`create trigger ${trigger}`);
      expect(sql).toContain(`on ${table}`);
    }
    expect(sql.match(/for each row execute function public\.audit_/g)).toHaveLength(9);
    expect(sql).not.toContain("for each statement");
  });

  it("records money as an exact decimal string with its currency", () => {
    expect(sql).toContain("jsonb_build_object('price', old.price::text, 'currency', v_currency)");
    expect(sql).toContain("jsonb_build_object('price', new.price::text, 'currency', v_currency)");
    expect(sql).toContain("'price' = any (v_changed) then 'service.price_changed'");
  });

  it("emits nothing for a save that changed nothing", () => {
    // Every UPDATE branch returns before writing when the allowlisted diff is empty.
    expect(sql.match(/if array_length\(v_changed, 1\) is null then\s+return new;/g)).toHaveLength(3);
  });

  it("never reads a secret, a pairing payload or clinical content", () => {
    // Comments name the things this trail must not touch; the executable half
    // must not mention them at all.
    for (const forbidden of [
      "qr_payload",
      "credentials_encrypted",
      "whatsapp_linked_device_auth",
      "national_id",
      "medical_notes",
      "last_error",
      "worker_id",
    ]) {
      expect(executable).not.toContain(forbidden);
    }
    // The WhatsApp number is stored as a four-digit suffix, never in full.
    expect(sql).toContain("'••••' || right(v_new_digits, 4)");
  });

  it("never writes a whole row — every snapshot goes through an allowlist", () => {
    const snapshots = executable.match(/to_jsonb\((new|old)\)/g) ?? [];
    expect(snapshots.length).toBeGreaterThan(0);
    for (const call of executable.matchAll(/([a-z_]*)\(\s*to_jsonb\((?:new|old)\)/g)) {
      expect(["admin_audit_pick", "admin_audit_diff"]).toContain(call[1]);
    }
  });

  it("records large or sensitive clinic settings as changed without their values", () => {
    expect(sql).toContain("v_named constant text[] := array[");
    for (const named of [
      "branding_metadata",
      "document_footer",
      "invoice_followup_email_body",
      "ai_style_instruction",
    ]) {
      expect(sql).toContain(`'${named}'`);
    }
  });

  it("restricts the one application-callable writer to administrative roles", () => {
    expect(sql).toContain("create or replace function public.record_admin_audit_event");
    expect(sql).toContain("v_clinic uuid := public.auth_clinic_id()");
    expect(sql).toContain("v_role public.user_role := public.auth_role()");
    expect(sql).toContain("raise exception 'ADMIN_AUDIT_FORBIDDEN' using errcode = '42501'");
    expect(sql).toMatch(
      /grant execute on function public\.record_admin_audit_event\([\s\S]*?\) to authenticated;/,
    );
  });

  // ── the P18 blocker: the RPC is not a general audit-authoring API ──────────

  it("closes the RPC to exactly the three scheduling tuples", () => {
    const rpc = executable.slice(
      executable.indexOf("create or replace function public.record_admin_audit_event"),
    );
    for (const tuple of [
      "= ('scheduling', 'clinic_hours.updated', 'clinic_hours')",
      "= ('scheduling', 'staff_schedule.updated', 'staff')",
      "= ('scheduling', 'shift_templates.updated', 'shift_templates')",
    ]) {
      expect(rpc).toContain(tuple);
    }
    // The tuple is matched as a whole. Three independent membership tests would
    // let `clinic_hours.updated` + `staff` through, so there must be none.
    expect(rpc).not.toMatch(/p_module\s+in\s*\(/);
    expect(rpc).not.toMatch(/p_action\s+in\s*\(/);
    expect(rpc).not.toMatch(/p_entity_type\s+in\s*\(/);
    expect(rpc).toContain("raise exception 'ADMIN_AUDIT_UNSUPPORTED_EVENT'");
  });

  it("validates before/after against the real scheduling summary shapes", () => {
    expect(sql).toContain(
      "create or replace function public.admin_audit_valid_shift_summary(p_value jsonb)",
    );
    expect(sql).toContain(
      "create or replace function public.admin_audit_valid_template_summary(p_value jsonb)",
    );

    // The exact keys auditShiftSummary / auditTemplateSummary emit, and an
    // exact-cardinality key check so an extra key is rejected, not stripped.
    for (const key of ["'shift_count'", "'shifts'", "'template_count'", "'templates'"]) {
      expect(sql).toContain(key);
    }
    expect(
      sql.match(/select count\(\*\) from jsonb_object_keys\(p_value\)\) = 2/g) ?? [],
    ).toHaveLength(2);

    // Element grammar: day 0-6 plus two HH:MM clocks; a named template plus two
    // HH:MM clocks and an optional disabled marker.
    expect(sql).toContain(
      "'^[0-6]:([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$'",
    );
    expect(sql).toContain(
      "'^[^[:cntrl:]]{1,60} ([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]( \\(disabled\\))?$'",
    );
    // No run of digits long enough to be a phone number or a civil ID.
    expect(sql).toContain("'[0-9]{5,}'");

    // Nothing but strings in the arrays, both arrays bounded, and the counter
    // pinned to the array length so it cannot carry data of its own.
    expect(
      sql.match(/jsonb_typeof\(element\.item\) <> 'string'/g) ?? [],
    ).toHaveLength(2);
    expect(sql).toContain("jsonb_array_length(p_value -> 'shifts') <= 28");
    expect(sql).toContain("jsonb_array_length(p_value -> 'templates') <= 10");
    expect(sql).toContain(
      "jsonb_array_length(p_value -> 'shifts') = (p_value ->> 'shift_count')::int",
    );
    expect(sql).toContain(
      "jsonb_array_length(p_value -> 'templates') = (p_value ->> 'template_count')::int",
    );

    const rpc = executable.slice(
      executable.indexOf("create or replace function public.record_admin_audit_event"),
    );
    expect(rpc).toContain("public.admin_audit_valid_shift_summary(p_before)");
    expect(rpc).toContain("public.admin_audit_valid_shift_summary(p_after)");
    expect(rpc).toContain("public.admin_audit_valid_template_summary(p_before)");
    expect(rpc).toContain("public.admin_audit_valid_template_summary(p_after)");
    expect(rpc).toContain("raise exception 'ADMIN_AUDIT_UNSUPPORTED_PAYLOAD'");
  });

  it("pins changed_fields and metadata and derives the entity itself", () => {
    const rpc = executable.slice(
      executable.indexOf("create or replace function public.record_admin_audit_event"),
    );
    expect(rpc).toContain(
      "array[case when v_kind = 'templates' then 'templates' else 'shifts' end]",
    );
    expect(rpc).toContain("coalesce(p_metadata, '{}'::jsonb) <> '{}'::jsonb");
    // The staff display name is read from the profile, in the caller's clinic.
    expect(rpc).toContain("from public.profiles p");
    expect(rpc).toContain("and p.clinic_id = v_clinic");
    // `p_entity_ref` is accepted for signature stability and never written.
    expect(rpc).not.toContain("p_entity_ref,");
    expect(rpc).toContain("v_entity_id, v_entity_ref");
  });

  it("gives every function it introduces an empty search_path", () => {
    expect(sql).not.toContain("set search_path = public");
    const definitions = sql.match(/^create or replace function public\.\w+/gm) ?? [];
    expect(definitions.length).toBeGreaterThanOrEqual(11);
    expect((sql.match(/^set search_path = ''$/gm) ?? []).length).toBe(definitions.length);

    // An empty search_path only works because every database object a body
    // touches is written schema-qualified. Scan the bodies only, with comments
    // and string literals removed so that `'departments'` as a CHECK value or
    // a trigger name is not mistaken for a table reference.
    const bodies = [...executable.matchAll(/as \$\$([\s\S]*?)\$\$;/g)].map((match) =>
      match[1].replace(/'[^']*'/g, "''"),
    );
    expect(bodies.length).toBe(definitions.length);

    const objects = [
      "profiles",
      "clinics",
      "departments",
      "admin_audit_events",
      "write_admin_audit_event",
      "admin_audit_diff",
      "admin_audit_pick",
      "admin_audit_valid_shift_summary",
      "admin_audit_valid_template_summary",
      "auth_clinic_id",
      "auth_role",
      "user_role",
    ];
    const unqualified: string[] = [];
    for (const body of bodies) {
      for (const name of objects) {
        // A name not preceded by `public.` (nor part of a longer identifier).
        const bare = new RegExp(`(?<!public\\.)(?<![\\w.])${name}\\b`, "g");
        unqualified.push(...(body.match(bare) ?? []));
      }
      // The only non-`public` object the bodies reach for is the session
      // helper, and it is qualified too.
      unqualified.push(...(body.match(/(?<!auth\.)(?<![\w.])uid\(\)/g) ?? []));
    }
    expect(unqualified).toEqual([]);
  });

  it("documents the deliberate insurance_providers overlap accurately", () => {
    expect(sql).toContain("trg_audit_insurance_providers");
    expect(sql).toMatch(/legacy raw insurance audit is left completely untouched/);
    expect(sql).toMatch(/adds the safe \*semantic\* administrative event/);
    expect(sql).toMatch(/raw legacy audit is NOT surfaced in the new Audit Log UI/);
    expect(sql).toMatch(/Nothing here rewrites,\s*--\s*backfills, deletes or re-shapes existing history/);
    // The old trigger is not removed in this pass.
    expect(sql).not.toMatch(/drop trigger[^\n]*trg_audit_insurance_providers/i);
    expect(sql).not.toMatch(/drop function[^\n]*write_audit_log/i);
  });

  it("adds nothing destructive and rewrites no existing trail", () => {
    expect(sql).not.toMatch(/drop table/i);
    expect(sql).not.toMatch(/delete from/i);
    expect(sql).not.toMatch(/truncate/i);
    expect(sql).not.toMatch(/alter table public\.(audit_logs|activity_events)\b/i);
  });
});
