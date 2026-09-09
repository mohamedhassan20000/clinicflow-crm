/**
 * The third-pass migration, read as a contract.
 *
 * It carries two additive schema needs, one new child table with its own RLS,
 * and — unusually for this repository — two replaced `security definer`
 * functions. The properties asserted here are the ones a reviewer would
 * otherwise have to hold in their head while reading eleven hundred lines of
 * SQL:
 *
 *   1. **additive and empty.** Four new columns, all nullable, no default, no
 *      backfill; one new table, created empty. A transliterated value written
 *      into a patient-facing name column is indistinguishable a week later from
 *      one a person authored, and an item row invented for an existing package
 *      is a price nobody at the clinic agreed to.
 *   2. **canonical columns untouched.** `patients.full_name`,
 *      `ai_patient_intakes.full_name` and `package_templates.department_id`
 *      remain what search, billing, the audit trail and every identity check
 *      read. `patients.phone` and `ai_patient_intakes.phone` stay NOT NULL.
 *   3. **a package is a basket, not a field.** The contents live in
 *      `package_template_items` — one row per service — and never in a
 *      `service_id` on the header, repeated columns, or a JSON blob.
 *   4. **the database enforces the tenancy and the department.** Both of the
 *      item table's foreign keys carry `clinic_id` *and* `department_id`, so a
 *      cross-clinic or cross-department line is unrepresentable rather than
 *      merely filtered out of a dropdown.
 *   5. **`clinic_id` is never nulled.** There is no `on delete set null`
 *      anywhere in this file, and therefore no delete action that could take
 *      `clinic_id` with it.
 *   6. **phone is a contact detail, not an identity.** No unique constraint is
 *      added to it, the approval function no longer consults it at all, and a
 *      shared family number neither merges two patients nor blocks a
 *      legitimate new file.
 *   7. **the identity firewall is unchanged.** The functions still fold
 *      `full_name` against an exact national id, and neither display name is
 *      an argument to any comparison.
 *   8. **the security posture is restated, not widened.**
 *
 * The application half is asserted too, because the migration is applied on
 * the clinic's own schedule and the assistant has to keep working until then.
 * The *behaviour* of the schema — that a cross-department line really is
 * refused, that deleting a service really does not delete a package — is
 * proved against a live PostgreSQL in
 * `tests/unit/integration/package-template-items.test.ts`; this file pins the
 * text so a future edit cannot quietly remove a rule that suite would then
 * stop exercising.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DISPLAY_NAME_KEYS,
  PATIENT_DISPLAY_COLUMNS,
  stripBlankDisplayNames,
} from "@/lib/settings/display-names";
import {
  packageItemSubtotal,
  packageItemsSessions,
  packageItemsTotal,
} from "@/lib/validations/package-template";

const MIGRATION =
  "supabase/migrations/20260918120000_bilingual_patient_names_and_package_service.sql";

const raw = readFileSync(MIGRATION, "utf8");

/**
 * The migration with its `--` commentary removed.
 *
 * Every "this does not happen" assertion runs against this rather than the raw
 * file: the file's own comments explain in prose exactly the things asserted
 * absent ("no backfill", "`set null` cannot apply to a column the package's
 * integrity depends on"), and a negative regex over the whole text would match
 * the explanation and fail on a correct migration.
 */
const sql = raw
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n")
  .toLowerCase();

/** The body of one `create ... function` statement, commentary stripped. */
function functionBody(name: string): string {
  const start = sql.indexOf(`function public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf("$function$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

const staging = functionBody("stage_patient_intake_from_conversation");
const approval = functionBody("approve_ai_patient_intake");

describe("the columns are additive and nullable", () => {
  it("adds the patient display names", () => {
    expect(sql).toContain("alter table public.patients");
    expect(sql).toContain("add column if not exists full_name_ar text");
    expect(sql).toContain("add column if not exists full_name_en text");
  });

  it("adds the same pair to the staging table", () => {
    expect(sql).toContain("alter table public.ai_patient_intakes");
  });

  it("declares no default and no not-null on any new column", () => {
    expect(sql).not.toMatch(/add column if not exists \w+ [\w ]*default/);
    expect(sql).not.toMatch(/add column if not exists \w+ [\w ]*not null/);
  });

  it("backfills nothing", () => {
    // The only UPDATE-shaped statements in this file are inside function
    // bodies. Nothing at the top level writes a row.
    const topLevel = sql.split("create or replace function")[0] ?? "";
    expect(topLevel).not.toContain("update public.");
    expect(topLevel).not.toContain("insert into public.");
  });

  it("renames and drops nothing", () => {
    expect(sql).not.toContain("drop column");
    expect(sql).not.toContain("rename column");
    expect(sql).not.toContain("rename to");
    expect(sql).not.toContain("drop table");
  });

  it("touches no existing policy", () => {
    // The only policies in this file are the four on the new table, and each is
    // dropped only to be recreated so the migration is re-runnable.
    const created = sql.match(/create policy/g) ?? [];
    expect(created).toHaveLength(4);
    for (const policy of created) expect(policy).toBe("create policy");
    expect(sql).not.toContain("alter policy");
    const dropped = sql.match(/drop policy if exists "[a-z_]+" on public\.(\w+)/g) ?? [];
    expect(dropped).toHaveLength(4);
    for (const statement of dropped) {
      expect(statement).toContain("on public.package_template_items");
    }
  });
});

describe("a package's contents are a child table, not a column", () => {
  it("puts no service on the package header", () => {
    // The design this replaced. One `service_id` on the header can hold a
    // package's first line and silently loses every other one.
    expect(sql).not.toContain("add column if not exists service_id");
    expect(sql).not.toContain("package_templates_service_fk");
    expect(sql).not.toMatch(/alter table public\.package_templates[\s\S]{0,200}service_id/);
  });

  it("creates the item table", () => {
    expect(sql).toContain("create table if not exists public.package_template_items");
    for (const column of [
      "clinic_id uuid not null",
      "package_template_id uuid not null",
      "department_id uuid not null",
      "service_id uuid not null",
      "sessions integer not null",
      "price_per_session numeric(12,2) not null",
      "sort_order integer not null",
    ]) {
      expect(sql).toContain(column);
    }
  });

  it("models neither repeated columns nor a JSON blob", () => {
    expect(sql).not.toMatch(/service_[123]_id/);
    // The only `jsonb` in this file is the *argument* to the write function,
    // never a stored column: the rows it writes are rows.
    expect(sql).not.toMatch(/add column if not exists \w+ jsonb/);
    const columns = sql.slice(
      sql.indexOf("create table if not exists public.package_template_items"),
      sql.indexOf("create index if not exists package_template_items_template_idx"),
    );
    expect(columns).not.toContain("jsonb");
  });

  it("uses the repository's money type, matching services.price", () => {
    expect(sql).toContain("price_per_session numeric(12,2) not null");
    expect(sql).not.toMatch(/price_per_session\s+(float|double|real|money)/);
  });

  it("allows a package to hold zero lines", () => {
    // Nothing requires a package to have items: no NOT NULL on the parent
    // pointing at a child, no trigger asserting a count, no check.
    expect(sql).not.toMatch(/package_templates[\s\S]{0,120}item_count/);
    expect(sql).not.toMatch(/must have at least one/i);
    // And the write function leaves an item-less package's own numbers alone.
    const write = functionBody("set_package_template_items");
    expect(write).toContain("if v_count > 0 then");
  });

  it("permits one line per service and no more", () => {
    expect(sql).toContain("unique (package_template_id, service_id)");
  });
});

describe("the database enforces the clinic and the department, not the dropdown", () => {
  it("makes the package and the service referenceable by clinic and department", () => {
    expect(sql).toContain(
      "create unique index if not exists services_clinic_department_id_key\n  on public.services (clinic_id, department_id, id)",
    );
    expect(sql).toContain(
      "create unique index if not exists package_templates_clinic_department_id_key\n  on public.package_templates (clinic_id, department_id, id)",
    );
  });

  it("carries the clinic and the department in both foreign keys", () => {
    expect(sql).toContain(
      "foreign key (clinic_id, department_id, package_template_id)\n    references public.package_templates (clinic_id, department_id, id)",
    );
    expect(sql).toContain(
      "foreign key (clinic_id, department_id, service_id)\n    references public.services (clinic_id, department_id, id)",
    );
  });

  it("never keys a line by service alone, which would allow another department's", () => {
    expect(sql).not.toMatch(/foreign key \(service_id\)/);
    expect(sql).not.toMatch(/foreign key \(clinic_id, service_id\)/);
  });

  it("re-checks the two things a key cannot express, and names the error", () => {
    const write = functionBody("set_package_template_items");
    expect(write).toContain("s.clinic_id = v_template.clinic_id");
    expect(write).toContain("s.department_id = v_template.department_id");
    expect(write).toContain("s.is_active");
    expect(write).toContain("s.deleted_at is null");
    expect(write).toContain("package_item_service_invalid");
  });
});

describe("deleting a service is safe, and clinic_id is never nulled", () => {
  it("declares no set-null delete action anywhere in the file", () => {
    // The whole class of defect. `on delete set null` on a composite key nulls
    // *every* referencing column in PostgreSQL unless a column list is given,
    // so a key carrying `clinic_id` would null the tenant. There is no such
    // action here at all, which is a stronger guarantee than a column list.
    expect(sql).not.toContain("on delete set null");
    expect(sql).not.toMatch(/set null\s*\(/);
  });

  it("never places clinic_id in a delete action of any kind", () => {
    const actions = sql.match(/on (delete|update) [a-z ]+/g) ?? [];
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action).not.toContain("clinic_id");
      expect(action).not.toContain("set null");
      expect(action).not.toContain("set default");
    }
  });

  it("refuses to delete a service a package still contains", () => {
    expect(sql).toContain(
      "references public.services (clinic_id, department_id, id)\n    on update restrict\n    on delete restrict",
    );
  });

  it("never cascades from a service into a package's lines", () => {
    // `cascade` here would silently delete a priced line and quietly change a
    // package's total. The one cascade in this table is from the *package*,
    // which is the package taking its own lines with it.
    const table = sql.slice(
      sql.indexOf("create table if not exists public.package_template_items"),
      sql.indexOf("create index if not exists package_template_items_template_idx"),
    );
    const serviceKey = table.slice(table.indexOf("package_template_items_service_fkey"));
    expect(serviceKey).not.toContain("cascade");
    expect(table).toContain(
      "references public.package_templates (clinic_id, department_id, id)\n    on update cascade\n    on delete cascade",
    );
  });

  it("deletes no package, ever", () => {
    expect(sql).not.toContain("delete from public.package_templates");
  });
});

describe("a package price is stored, and never written back to the catalogue", () => {
  it("never writes services.price", () => {
    expect(sql).not.toContain("update public.services");
    expect(sql).not.toMatch(/set\s+price\s*=/);
  });

  it("never reads services.price into a package's own price", () => {
    const write = functionBody("set_package_template_items");
    expect(write).not.toContain("s.price");
    // The line's price comes from the payload the clinic sent, and nowhere else.
    expect(write).toContain("(e.item ->> 'price_per_session')::numeric");
  });

  it("derives the header from the lines and never the reverse", () => {
    const write = functionBody("set_package_template_items");
    // One writer, one direction. Nothing reads `total_price` to compute a line.
    expect(write).toContain("update public.package_templates t");
    expect(write).toContain("total_sessions = v_sessions");
    expect(write).toContain("total_price = v_total");
    expect(write).not.toMatch(/price_per_session\s*=\s*[^v\n]*total_price/);
    expect(write).not.toContain("update public.package_template_items");
  });
});

describe("the item table is protected exactly as its parent is", () => {
  it("enables row level security", () => {
    expect(sql).toContain(
      "alter table public.package_template_items enable row level security",
    );
  });

  it("lets a clinic member read and only an admin write", () => {
    const policies = sql.slice(sql.indexOf("enable row level security"));
    expect(policies).toContain("clinic_id = public.auth_clinic_id()");
    expect(policies).toContain("public.auth_role() = 'admin'::public.user_role");
    for (const verb of ["for select", "for insert", "for update", "for delete"]) {
      expect(policies).toContain(verb);
    }
  });

  it("grants no access to anon", () => {
    expect(sql).toContain("revoke all on table public.package_template_items from anon");
    expect(sql).toContain("grant all on table public.package_template_items to authenticated");
  });

  it("writes items through a security INVOKER function, so RLS is the check", () => {
    // A definer here would bypass the four policies above and then have to
    // re-implement them in PL/pgSQL, which is how the copy drifts.
    expect(sql).toContain("security invoker");
    const write = functionBody("set_package_template_items");
    expect(write).not.toContain("security definer");
    expect(write).toContain("set search_path to ''");
    expect(sql).toContain(
      "revoke all on function public.set_package_template_items(uuid, jsonb)\n  from public, anon, service_role",
    );
  });

  it("grants the item writer to authenticated and to nothing else", () => {
    // The service role bypasses RLS, and RLS is this function's entire
    // authorization. Granting it EXECUTE would turn "RLS is the authorization"
    // into "RLS is the authorization unless you hold the service key".
    const grants = (sql.match(/grant execute on function public\.set_package_template_items[^;]*/g) ?? []);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain("to authenticated");
    expect(grants[0]).not.toContain("service_role");
    expect(grants[0]).not.toContain("anon");
  });

  it("refuses a malformed service_id by name rather than by casting it", () => {
    const write = functionBody("set_package_template_items");
    // The uuid text form is matched before anything casts. `'abc'::uuid` raises
    // a raw type error that names a type rather than a field.
    const shapeCheck = write.slice(0, write.indexOf("package_item_invalid"));
    expect(shapeCheck).toContain(
      "!~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'",
    );
    // And the check precedes every cast of that field.
    expect(shapeCheck.indexOf("[0-9a-f]{8}")).toBeLessThan(
      write.indexOf("(e.item ->> 'service_id')::uuid"),
    );
  });

  it("refuses a duplicate service by name, before the delete runs", () => {
    const write = functionBody("set_package_template_items");
    expect(write).toContain("package_item_duplicate_service");
    expect(write).toContain("count(distinct e.item ->> 'service_id')");
    // Named *before* the existing lines are removed, so a refused write leaves
    // the package exactly as it was.
    expect(write.indexOf("package_item_duplicate_service")).toBeLessThan(
      write.indexOf("delete from public.package_template_items i"),
    );
    // The constraint stays: this is the message, that is the guarantee.
    expect(sql).toContain("unique (package_template_id, service_id)");
  });

  it("replaces a package's lines in one statement", () => {
    const write = functionBody("set_package_template_items");
    expect(write).toContain("for update");
    expect(write).toContain("delete from public.package_template_items i");
    expect(write).toContain("insert into public.package_template_items");
  });

  it("audits the item table the way it audits the parent", () => {
    expect(sql).toContain("trg_audit_package_template_items");
    expect(sql).toContain("execute function public.write_audit_log()");
    expect(sql).toContain("trg_package_template_items_updated_at");
  });
});

describe("phone is a contact detail, and the schema is not changed to say otherwise", () => {
  it("leaves both phone columns not-null", () => {
    expect(sql).not.toMatch(/alter column phone/);
    expect(sql).not.toContain("drop not null");
  });

  it("adds no unique constraint on phone, because families share a number", () => {
    expect(sql).not.toMatch(/unique[\s\S]{0,40}\bphone\b/);
    expect(sql).not.toMatch(/\bphone\b[\s\S]{0,40}unique/);
  });

  it("keeps the third-party contact fallback the deployed function has", () => {
    // A parent booking for a child and giving no separate number: the parent's
    // phone is genuinely how the clinic reaches that child. Retained
    // deliberately, and it is a contact detail rather than a claim of identity.
    expect(staging).toContain("when coalesce(p_for_third_party, false)");
    expect(staging).toContain("nullif(btrim(coalesce(p_phone, '')), '')");
    expect(staging).toContain(
      "nullif(btrim(coalesce(v_conversation.participant_address, '')), '')",
    );
  });

  it("never links a third-party intake to a patient by phone", () => {
    // The whole phone-matching block is gated on the intake being for the
    // sender themselves. A third party is never matched, linked or verified on
    // a number.
    const gate = staging.indexOf("if not coalesce(p_for_third_party, false) then");
    const phoneMatch = staging.indexOf("into v_phone_count");
    expect(gate).toBeGreaterThan(-1);
    expect(phoneMatch).toBeGreaterThan(gate);
    expect(staging).not.toMatch(/p_for_third_party[\s\S]{0,200}patient_link_status/);
  });

  it("does not consult phone at all when approving an intake", () => {
    // The defect this corrects: the approval counted the patients on the
    // intake's phone and, at a count of one, reused that patient's file on a
    // national-id-and-dob match with no name check — and raised otherwise,
    // which made a third-party approval impossible because the requester's own
    // file always sat on that number.
    expect(approval).not.toContain("v_phone_count");
    expect(approval).not.toContain("p.phone = v_intake.phone");
    expect(approval).not.toContain("v_existing");
  });

  it("decides an approval on the folded national id alone", () => {
    expect(approval).toContain(
      "public.fold_national_id(p.national_id) = v_intake.national_id_folded",
    );
    expect(approval).toContain("if v_id_count > 0 then");
    expect(approval).toContain("intake_duplicate_review_required");
  });

  it("chooses the patient by national id, never by how many share a number", () => {
    // The deployed body branched on `count(patients on this number)`: two
    // returned `duplicate_ambiguous` and one drove the identity comparison. Both
    // refused a legitimate caller for somebody else's record.
    expect(staging).toContain("if v_id_count = 1 then");
    expect(staging).toContain("where p.id = v_id_match_id");
    expect(staging).not.toContain("duplicate_ambiguous");
    expect(staging).not.toContain("if v_phone_count = 1 then");
    expect(staging).not.toContain("if v_phone_count > 1 then");
  });

  it("still requires the file's own number before linking automatically", () => {
    // The protection the phone was really providing. An automatic link hands a
    // sender access to a patient's record, so proven identity alone is not
    // enough — but how many relatives share the number is irrelevant.
    expect(staging).toContain("if v_phone_match.phone is not distinct from v_phone then");
    expect(staging).toContain("patient_link_status = 'automatic'");
  });

  it("does not punish a new patient for staging from a relative's number", () => {
    expect(staging).toContain("v_phone_is_other_person");
    // The lockout is reached on the impersonation shape and on nothing else:
    // the clinic holds no patient under the national id given, and somebody on
    // this number already carries the caller's folded name.
    expect(staging).toContain("elsif v_id_count = 0 and v_phone_count > 0 and exists (");
    expect(staging).toContain(
      "public.fold_patient_name(p.full_name)\n            = public.fold_patient_name(p_full_name)",
    );
  });

  it("keeps the anti-impersonation lockout for the case it was built for", () => {
    expect(staging).toContain("identity_verification_failures");
    expect(staging).toContain("interval '30 minutes'");
    expect(staging).toContain("identity_locked");
    expect(staging).toContain("identity_mismatch");
  });

  it("records a shared-number staging in the audit trail", () => {
    expect(staging).toContain("'shared_contact_phone', v_phone_is_other_person");
  });
});

describe("the replaced functions keep their posture and their identity rules", () => {
  it("drops exactly one old signature, and only to re-create it", () => {
    // Adding arguments with defaults changes the signature, so `create or
    // replace` would leave a second overload and PostgREST could not choose.
    const drops = raw.match(/^drop function/gim) ?? [];
    expect(drops).toHaveLength(1);
    expect(sql).toContain("drop function if exists public.stage_patient_intake_from_conversation");
    expect(sql).toContain("create or replace function public.stage_patient_intake_from_conversation");
  });

  it("keeps both replaced functions security definer with an empty search path", () => {
    expect(staging).toContain("security definer");
    expect(approval).toContain("security definer");
    expect(staging).toContain("set search_path to ''");
    expect(approval).toContain("set search_path to ''");
  });

  it("keeps the staging function's service-role-only gate and grant", () => {
    expect(staging).toContain("patient_ai_service_role_required");
    const grants = sql.slice(
      sql.indexOf("revoke all on function public.stage_patient_intake"),
      sql.indexOf("create or replace function public.approve"),
    );
    expect(grants).toContain("to service_role");
    // The staging function is never granted to a signed-in user.
    expect(grants).not.toContain("to authenticated");
  });

  it("keeps the approval function's actor and role checks and grants", () => {
    expect(approval).toContain("p_actor_id is distinct from auth.uid()");
    expect(approval).toContain("intake_review_forbidden");
    expect(approval).toContain("'admin', 'manager', 'receptionist'");
    expect(sql).toContain("grant execute on function public.approve_ai_patient_intake(uuid, uuid) to authenticated");
    expect(sql).toContain("grant execute on function public.approve_ai_patient_intake(uuid, uuid) to service_role");
  });

  it("still folds the canonical name for identity, and never a display name", () => {
    expect(staging).toContain("public.fold_patient_name(v_phone_match.full_name)");
    expect(approval).toContain("public.fold_patient_name(v_matched.full_name)");
    expect(sql).not.toContain("fold_patient_name(v_intake.full_name_ar");
    expect(sql).not.toContain("fold_patient_name(v_intake.full_name_en");
    // Neither display name appears in a comparison. The one place either is
    // assigned is the staging upsert, where a re-stage must not erase a name an
    // earlier turn collected.
    expect(sql).not.toMatch(/full_name_(ar|en)[^,\n)]*is distinct from/);
    expect(sql).not.toMatch(/=\s*public\.fold_patient_name\([^)]*full_name_(ar|en)/);
  });

  it("carries a display name through a re-stage rather than erasing it", () => {
    expect(staging).toContain(
      "full_name_ar = coalesce(excluded.full_name_ar, ai_patient_intakes.full_name_ar)",
    );
    expect(staging).toContain(
      "full_name_en = coalesce(excluded.full_name_en, ai_patient_intakes.full_name_en)",
    );
  });

  it("copies the display names onto the file the approval creates", () => {
    expect(approval).toContain("v_intake.full_name_ar, v_intake.full_name_en");
  });

  it("leaves a matched existing file's name alone", () => {
    // The `matched_patient_id` branch reuses a row and writes nothing to it:
    // overwriting a name a person at the clinic curated with one a conversation
    // produced is not something an approval should do silently.
    const matched = approval.slice(
      approval.indexOf("if v_intake.matched_patient_id is not null then"),
    );
    const branch = matched.slice(0, matched.indexOf("v_patient_id := v_matched.id;"));
    expect(branch).not.toContain("update public.patients");
  });

  it("does not redefine the identity discovery function", () => {
    // Section 8 *calls* it — that is how the matched-staging path re-proves an
    // identity rather than trusting an argument — and must not redefine it.
    expect(sql).not.toContain("function public.find_clinic_patient_by_identity(");
  });
});

/**
 * The third writer, and the invariant that made it part of this migration.
 *
 * `stage_matched_third_party_intake` carries no bilingual work at all; it is
 * here because it is the other function that can write a row with
 * `is_third_party = true`, and an invariant enforced by one of two writers is
 * not enforced. Its body terminates with `$$;` rather than `$function$;`, so it
 * is sliced separately from the two above.
 */
const matchedStaging = (() => {
  const start = sql.indexOf("function public.stage_matched_third_party_intake(");
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", sql.indexOf("as $$", start));
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
})();

describe("a third-party intake names the patient who asked for it", () => {
  it("guards both writers with the same refusal", () => {
    for (const body of [staging, matchedStaging]) {
      expect(body).toContain("third_party_requester_not_linked");
      expect(body).toContain("and not p.is_deleted and p.deleted_at is null");
      expect(body).toContain("and p.clinic_id = p_clinic_id");
    }
    // Raised, never returned: the v2 `stageIntake` boundary reads only the
    // error, so a new status value would be read as a successful staging.
    expect(sql).not.toMatch(/status\s*:=\s*'third_party_requester_not_linked'/);
  });

  it("refuses only a third-party staging, leaving self-intake alone", () => {
    // The guard in the new-file path is gated on the flag; the matched path
    // writes nothing but third-party rows, so its guard is unconditional.
    const guard = staging.slice(
      staging.indexOf("if coalesce(p_for_third_party, false) and ("),
    );
    expect(guard.slice(0, guard.indexOf("end if;"))).toContain(
      "v_conversation.patient_id is null",
    );
    expect(staging).toContain("when coalesce(p_for_third_party, false) then v_conversation.patient_id");
    expect(staging).toContain("else null");
  });

  it("does not make archived a rejection condition", () => {
    for (const body of [staging, matchedStaging]) expect(body).not.toContain("is_archived");
  });

  it("writes the requester on the conflict path too", () => {
    // A row flipped to `is_third_party` by an upsert must gain its requester in
    // the same statement, or an earlier self-intake keeps a null one.
    expect(matchedStaging).toContain("is_third_party = true");
    expect(matchedStaging).toContain(
      "requested_by_patient_id = excluded.requested_by_patient_id",
    );
  });

  it("keeps the matched-staging function's posture and grants", () => {
    expect(matchedStaging).toContain("security definer");
    expect(matchedStaging).toContain("set search_path = ''");
    expect(matchedStaging).toContain("patient_ai_service_role_required");
    const grants = sql.slice(sql.indexOf("revoke all on function public.stage_matched_third_party_intake"));
    expect(grants).toContain("to service_role");
    expect(grants).not.toMatch(/grant execute on function public\.stage_matched[^;]*to authenticated/);
  });

  it("re-proves the beneficiary's identity rather than trusting an argument", () => {
    expect(matchedStaging).toContain(
      "from public.find_clinic_patient_by_identity(p_clinic_id, p_national_id, p_full_name) f",
    );
    expect(matchedStaging).not.toContain("p_patient_id");
  });
});

/**
 * The ownership audit: which of the approval's writes are the beneficiary's.
 *
 * A third-party intake is approved *for* somebody who never messaged the
 * clinic. The appointment and the file are theirs; the conversation, its
 * verification state and its inbound messages belong to the sender who asked,
 * and the deployed body handed all of them to the beneficiary.
 */
const beneficiaryGuard = (() => {
  const start = approval.indexOf("if not v_third_party then");
  expect(start).toBeGreaterThan(-1);
  return approval.slice(start, approval.indexOf("end if;", start));
})();

const bookingPredicate = (() => {
  const start = sql.indexOf(
    "function public.ai_conversation_booking_beneficiary_matches(",
  );
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", sql.indexOf("as $$", start));
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
})();

describe("approval keeps the thread with the sender who asked", () => {
  it("classifies the third-party case from the intake, not from the conversation", () => {
    expect(approval).toContain("v_third_party := coalesce(v_intake.is_third_party, false);");
    // "Still linked to that requester", not merely "has a requester".
    expect(approval).toContain(
      "v_conversation.patient_id = v_intake.requested_by_patient_id",
    );
  });

  it("puts every requester-scoped write behind the guard", () => {
    for (const write of [
      "set patient_id = v_patient_id, patient_link_status = 'manual'",
      "set identity_verified_at = clock_timestamp(), identity_verification_failures = 0,",
      "update public.inbound_messages m set patient_id = v_patient_id",
      "update public.inbound_message_attachments a set patient_id = v_patient_id",
    ]) {
      expect(beneficiaryGuard).toContain(write);
      // ...and nowhere else in the function.
      expect(approval.split(write)).toHaveLength(2);
    }
  });

  it("leaves the beneficiary-scoped writes on the beneficiary", () => {
    // The appointment is the whole point of a third-party booking.
    expect(approval).toContain(
      "v_request.clinic_id, v_patient_id, v_request.doctor_id,",
    );
    expect(approval).toContain("approved_patient_id = v_patient_id,");
    expect(approval).toContain("return query select v_patient_id, v_appointment_id, false;");
  });

  it("never writes an approved_patient_id onto a row still pending review", () => {
    // `ai_patient_intakes_review_shape_check` forbids it, so the booking guard
    // cannot be given a pre-written beneficiary to read.
    const pending = approval.split("review_status = 'approved'")[0] ?? "";
    expect(pending).not.toContain("approved_patient_id");
  });

  it("dismisses a booking whose requester no longer holds the thread", () => {
    expect(approval).toContain("elsif v_third_party and not v_requester_linked then");
    const branch = approval.slice(
      approval.indexOf("elsif v_third_party and not v_requester_linked then"),
    );
    expect(branch.slice(0, branch.indexOf("else"))).toContain("status = 'dismissed'");
  });

  it("keeps the durable exemption on the reviewed beneficiary", () => {
    // Durable rather than context-bound, so the trigger still passes when it
    // runs again on a later edit of the row the approval created.
    expect(bookingPredicate).toContain("i.is_third_party");
    expect(bookingPredicate).toContain("c.patient_id = i.requested_by_patient_id");
    expect(bookingPredicate).toContain("i.approved_patient_id = p_patient_id");
  });

  it("binds the in-review exemption to the approval of that exact intake", () => {
    // The whole authorization of the pending branch: the existing capability
    // check, plus the marker pinning the row. A pending intake and a matching
    // national id are not sufficient, and must never be.
    const pendingBranch = bookingPredicate.slice(bookingPredicate.indexOf("or ("));
    expect(pendingBranch).toContain("v_in_approval");
    expect(pendingBranch).toContain("i.id = v_marked_intake");
    expect(pendingBranch).toContain("i.review_status = 'pending_review'");
    expect(bookingPredicate).toContain("public.ai_intake_approval_context_matches(");
    // The folded id is a consistency check *inside* that branch, never a grant.
    const fold = pendingBranch.indexOf(
      "public.fold_national_id(p.national_id) = i.national_id_folded",
    );
    expect(fold).toBeGreaterThan(pendingBranch.indexOf("v_in_approval"));
    expect(fold).toBeGreaterThan(pendingBranch.indexOf("i.id = v_marked_intake"));
  });

  it("reads the marker rather than trusting an argument for the intake id", () => {
    expect(bookingPredicate).toContain("'clinicflow.ai_intake_approval_id'");
    // A malformed marker is a false, not an error raised out of a trigger.
    expect(bookingPredicate).toContain("when invalid_text_representation then");
  });

  it("keeps the trigger's other refusals exactly as deployed", () => {
    const trigger = sql.slice(
      sql.indexOf("function public.enforce_ai_pending_booking_policy()"),
    );
    for (const rule of [
      "ai_booking_minimum_notice",
      "ai_booking_clinic_unavailable",
      "ai_booking_action_receipt_mismatch",
      "ai_booking_invalid_expiry",
      "ai_pending_patient_cap",
      "ai_pending_slot_cap",
      "or new.created_by is not null then",
    ]) {
      expect(trigger).toContain(rule);
    }
    // The trigger itself is not re-created; it already points at this
    // function, and no trigger on appointments changes shape here.
    expect(sql).not.toMatch(/create trigger[^;]*on public\.appointments/);
    expect(sql).not.toMatch(/create trigger[^;]*enforce_ai_pending_booking_policy/);
  });

  it("grants the predicate no wider than the trigger needs", () => {
    // anon cannot write public.appointments under any policy, so it never
    // reaches the trigger and is not given a security-boundary helper.
    const start = sql.indexOf(
      "revoke all on function public.ai_conversation_booking_beneficiary_matches",
    );
    const grantStart = sql.indexOf(
      "grant execute on function public.ai_conversation_booking_beneficiary_matches",
      start,
    );
    expect(grantStart).toBeGreaterThan(start);
    const revoke = sql.slice(start, grantStart);
    const grant = sql.slice(grantStart, sql.indexOf(";", grantStart));
    expect(revoke).toContain("from public, anon;");
    expect(grant).toContain("to authenticated, service_role");
    expect(grant).not.toContain("anon");
  });
});

describe("the application does not require the migration to have run", () => {
  it("knows the patient display columns as an optional pair", () => {
    expect([...PATIENT_DISPLAY_COLUMNS]).toEqual(["full_name_ar", "full_name_en"]);
    for (const column of PATIENT_DISPLAY_COLUMNS) {
      expect(DISPLAY_NAME_KEYS).toContain(column);
    }
  });

  it("drops a blank patient display name from a write entirely", () => {
    // Not `""` — a clinic that authored nothing must send byte-for-byte the
    // payload it sent before these columns existed.
    const written = stripBlankDisplayNames({
      full_name: "Ali Alzahrani",
      full_name_ar: "   ",
      full_name_en: null as unknown as string,
    });
    expect(written).toEqual({ full_name: "Ali Alzahrani" });
  });

  it("keeps an authored one, trimmed", () => {
    expect(
      stripBlankDisplayNames({ full_name_ar: "  علي الزهراني  ", full_name_en: "" }),
    ).toEqual({ full_name_ar: "علي الزهراني" });
  });
});

describe("the arithmetic the schema and the form share", () => {
  const rehab = { sessions: 5, price_per_session: 1300 };
  const sports = { sessions: 3, price_per_session: 1800 };

  it("computes a line's subtotal as sessions x price", () => {
    expect(packageItemSubtotal(rehab)).toBe(6500);
    expect(packageItemSubtotal(sports)).toBe(5400);
  });

  it("sums the package total from the line subtotals", () => {
    expect(packageItemsTotal([rehab, sports])).toBe(11900);
  });

  it("sums the session count from the lines", () => {
    expect(packageItemsSessions([rehab, sports])).toBe(8);
  });

  it("has no derived total for a package with no lines", () => {
    // Null, not zero: a department-only package's total is whatever the clinic
    // typed, and zero is a price.
    expect(packageItemsTotal([])).toBeNull();
    expect(packageItemsSessions([])).toBeNull();
  });

  it("rounds to the cent rather than accumulating float error", () => {
    expect(packageItemSubtotal({ sessions: 3, price_per_session: 0.1 })).toBe(0.3);
    expect(
      packageItemsTotal([
        { sessions: 3, price_per_session: 0.1 },
        { sessions: 7, price_per_session: 0.1 },
      ]),
    ).toBe(1);
  });
});
