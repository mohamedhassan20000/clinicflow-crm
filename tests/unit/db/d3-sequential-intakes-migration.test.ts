import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * D3 — the migration text itself.
 *
 * The integration suite proves the behaviour against a live PostgreSQL. These
 * are the properties that must hold in the *file*, because getting any of them
 * wrong is either silent or only fails in production:
 *
 *   * the `on conflict` inference clause must name the partial index's
 *     predicate. Omit it and PostgreSQL raises `42P10` at runtime — every
 *     staging call fails, and nothing catches it before deploy;
 *   * the supersede rule must key on the folded national id and must never
 *     consult `phone`;
 *   * a superseded row must be dismissed, not deleted and not rewritten;
 *   * only that intake's own appointment requests may be dismissed with it;
 *   * the approval/rejection/authorization surfaces must not appear in this
 *     migration at all — they were audited as already exact-intake-bound, and
 *     the smallest safe change leaves them alone.
 */
const PATH =
  "supabase/migrations/20260920120000_d3_multiple_sequential_intakes_per_conversation.sql";
const raw = readFileSync(PATH, "utf8");
const code = raw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n")
  .toLowerCase();

function functionBody(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}`);
  expect(start, `${name} is defined here`).toBeGreaterThanOrEqual(0);
  const open = code.indexOf("as $function$", start) >= 0
    ? Math.min(
        ...[code.indexOf("as $function$", start), code.indexOf("as $$", start)].filter(
          (index) => index >= 0,
        ),
      )
    : code.indexOf("as $$", start);
  const close = Math.min(
    ...[code.indexOf("$function$;", open + 5), code.indexOf("$$;", open + 5)]
      .filter((index) => index >= 0)
      .concat([code.length]),
  );
  return code.slice(open, close);
}

const STAGERS = [
  "stage_patient_intake_from_conversation",
  "stage_matched_third_party_intake",
] as const;

describe("the uniqueness model", () => {
  it("creates the pending-only partial unique index", () => {
    expect(code).toContain(
      "create unique index if not exists ai_patient_intakes_one_pending_per_conversation",
    );
    expect(code).toContain("on public.ai_patient_intakes (clinic_id, conversation_id)");
    expect(code).toContain("where review_status = 'pending_review'");
  });

  it("drops the lifetime unique index", () => {
    expect(code).toContain(
      "drop index if exists public.ai_patient_intakes_conversation_unique",
    );
  });

  it("creates the new index before dropping the old one", () => {
    expect(
      code.indexOf("create unique index if not exists ai_patient_intakes_one_pending"),
    ).toBeLessThan(
      code.indexOf("drop index if exists public.ai_patient_intakes_conversation_unique"),
    );
  });
});

describe("the review shape", () => {
  const constraint = code.slice(
    code.indexOf("add constraint ai_patient_intakes_review_shape_check"),
    code.indexOf("-- 3.") >= 0 ? code.indexOf("create or replace function") : code.length,
  );

  it("admits a system supersession: dismissed, no reviewer, no patient", () => {
    expect(constraint).toContain("review_status = 'dismissed'");
    expect(constraint).toContain("reviewed_at is not null and approved_patient_id is null");
  });

  it("does not weaken approved or rejected", () => {
    expect(constraint).toContain(
      "review_status in ('approved', 'rejected')\n      and reviewed_at is not null and reviewed_by is not null",
    );
  });

  it("leaves pending_review exactly as it was", () => {
    expect(constraint).toContain(
      "review_status = 'pending_review'\n      and reviewed_at is null and reviewed_by is null and approved_patient_id is null",
    );
  });
});

describe.each(STAGERS)("%s", (name) => {
  it("infers the partial index in its ON CONFLICT clause", () => {
    const body = functionBody(name);
    expect(body).toContain("on conflict (clinic_id, conversation_id)");
    // The inference predicate, without which this is a runtime 42P10.
    const conflict = body.slice(body.indexOf("on conflict (clinic_id, conversation_id)"));
    expect(conflict.slice(0, 120)).toContain("where review_status = 'pending_review'");
  });

  it("keeps the defensive assertion on DO UPDATE", () => {
    expect(functionBody(name)).toContain(
      "where ai_patient_intakes.review_status = 'pending_review'",
    );
  });

  it("supersedes on the folded national id and never on the phone", () => {
    const body = functionBody(name);
    const block = body.slice(
      body.indexOf("select i.id into v_superseded_id"),
      body.indexOf("insert into public.ai_patient_intakes ("),
    );
    expect(block).toContain("i.national_id_folded");
    expect(block).toContain("is distinct from public.fold_national_id(");
    expect(block).not.toContain("phone");
  });

  it("dismisses the displaced row rather than deleting or rewriting it", () => {
    const body = functionBody(name);
    const block = body.slice(
      body.indexOf("if v_superseded_id is not null then"),
      body.indexOf("insert into public.ai_patient_intakes ("),
    );
    expect(block).toContain("set review_status = 'dismissed'");
    expect(block).toContain("reviewed_by = null");
    expect(block).toContain("approved_patient_id = null");
    expect(block).toContain("review_reason = 'superseded_by_new_beneficiary'");
    // The identity columns of a superseded row are never touched.
    for (const column of ["full_name =", "national_id =", "date_of_birth ="]) {
      expect(block).not.toContain(column);
    }
    expect(block).not.toContain("delete from public.ai_patient_intakes");
  });

  it("dismisses only that intake's own appointment requests", () => {
    const body = functionBody(name);
    const block = body.slice(
      body.indexOf("update public.ai_appointment_requests r"),
      body.indexOf("get diagnostics"),
    );
    expect(block).toContain("r.intake_id = v_superseded_id");
    expect(block).toContain("r.status = 'pending'");
    // Never by thread: an approved beneficiary's request is a real booking.
    expect(block).not.toContain("conversation_id");
  });

  it("writes the supersession to the audit trail", () => {
    const body = functionBody(name);
    expect(body).toContain("'ai_patient_intake_superseded'");
  });

  it("supersedes only under the conversation's row lock", () => {
    const body = functionBody(name);
    expect(body.indexOf("from public.conversations c")).toBeLessThan(
      body.indexOf("select i.id into v_superseded_id"),
    );
    expect(body).toContain("for update");
  });

  it("supersedes nothing on a path that stages nothing", () => {
    const body = functionBody(name);
    // The supersede block sits immediately before the insert, after every
    // early return and every raise.
    const supersede = body.indexOf("select i.id into v_superseded_id");
    const insert = body.indexOf("insert into public.ai_patient_intakes (");
    expect(supersede).toBeGreaterThan(0);
    expect(insert).toBeGreaterThan(supersede);
    expect(body.slice(supersede, insert)).not.toContain("return next; return;");
  });
});

describe("the provisional request lookup", () => {
  const body = functionBody("create_provisional_ai_appointment_request");

  it("selects one pending intake deterministically", () => {
    expect(body).toContain("and i.review_status = 'pending_review'");
    expect(body).toContain("order by i.created_at desc, i.id desc");
    expect(body).toContain("limit 1");
  });

  it("keeps request ownership bound to that exact intake", () => {
    expect(body).toContain("r.intake_id = v_intake.id");
    expect(body).toContain("p_clinic_id, v_intake.id, p_conversation_id");
  });
});

describe("the blast radius", () => {
  it("does not touch the approval, rejection or authorization surfaces", () => {
    for (const untouched of [
      "function public.approve_ai_patient_intake",
      "function public.reject_ai_patient_intake",
      "function public.ai_conversation_booking_beneficiary_matches",
      "function public.ai_intake_approval_context_matches",
      "function public.enforce_ai_pending_booking_policy",
    ]) {
      expect(code).not.toContain(untouched);
    }
  });

  it("changes no row policy and drops no table", () => {
    expect(code).not.toContain("create policy");
    expect(code).not.toContain("drop policy");
    expect(code).not.toContain("drop table");
    expect(code).not.toContain("delete from");
  });

  it("replaces exactly the three audited functions", () => {
    expect(code.match(/create or replace function/g)).toHaveLength(3);
  });

  it("restates the service-role-only grants both stagers carry", () => {
    for (const name of STAGERS) {
      const grants = code.slice(code.indexOf(`grant execute on function public.${name}`));
      expect(grants.slice(0, 400)).toContain("to service_role");
    }
    expect(code).not.toContain("to authenticated, service_role;\n-- stage");
  });
});
