import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Item #3 — the identity rule that finds a beneficiary's existing file.
 *
 * This is the highest-risk change in the pass: a lookup that turns an id and a
 * name into somebody's patient record. These tests are the guard on the three
 * properties that make it safe — the id is exact, the name must confirm it,
 * and anything ambiguous or unmatched discloses nothing — plus the two that
 * keep it inside its tenant and out of reach of the browser.
 */
const PATH =
  "supabase/migrations/20260911120000_existing_patient_identity_discovery.sql";
const raw = readFileSync(PATH, "utf8");
const code = raw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n")
  .toLowerCase();

function functionBody(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}`);
  expect(start, `${name} is defined here`).toBeGreaterThanOrEqual(0);
  const open = code.indexOf("as $$", start);
  return code.slice(open, code.indexOf("$$;", open));
}

const LOOKUP = "find_clinic_patient_by_identity";
const STAGE = "stage_matched_third_party_intake";

describe("the identity lookup", () => {
  it("matches on the folded id, exactly, and never on a similarity score", () => {
    const body = functionBody(LOOKUP);
    expect(body).toContain("public.fold_national_id(p.national_id) = v_folded_id");
    // The vocabulary of fuzzy matching must not appear anywhere in it.
    for (const fuzzy of ["similarity", "levenshtein", "ilike", "%'", "soundex", "trigram", "<->"]) {
      expect(body).not.toContain(fuzzy);
    }
  });

  it("requires the name to confirm the id", () => {
    const body = functionBody(LOOKUP);
    expect(body).toContain("public.fold_patient_name(v_match.full_name)");
    expect(body).toContain("is distinct from public.fold_patient_name(p_full_name)");
  });

  it("fails closed on ambiguity rather than picking one", () => {
    expect(functionBody(LOOKUP)).toContain("if v_match_count <> 1 then return; end if;");
  });

  it("only ever considers live patients of the one clinic", () => {
    const body = functionBody(LOOKUP);
    expect(body).toContain("p.clinic_id = p_clinic_id");
    expect(body).toContain("not p.is_deleted");
    expect(body).toContain("p.deleted_at is null");
  });

  it("names only bookable doctors and active departments", () => {
    const body = functionBody(LOOKUP);
    expect(body).toContain("d.is_active");
    expect(body).toContain("doc.role = 'doctor'::public.user_role");
    expect(body).toContain("doc.is_active");
    expect(body).toContain("not doc.is_deleted");
  });

  it("returns no contact detail and nothing about anybody else", () => {
    // The `returns table (...)` clause only — the id and the name are *inputs*,
    // which the caller already holds; what matters is what comes back out.
    const start = code.indexOf(`create or replace function public.${LOOKUP}`);
    const open = code.indexOf("returns table (", start);
    const returns = code.slice(open, code.indexOf(")", code.indexOf("is_primary", open)));
    for (const column of ["phone", "email", "national_id", "file_number", "date_of_birth"]) {
      expect(returns).not.toContain(column);
    }
    // What it does return: the person, and where they are known.
    for (const column of ["patient_id", "full_name", "department_id", "doctor_id"]) {
      expect(returns).toContain(column);
    }
  });
});

describe("both functions are service-role only", () => {
  it.each([LOOKUP, STAGE])("%s is revoked from the browser roles", (name) => {
    const revoke = code.slice(code.indexOf(`revoke all on function public.${name}`));
    expect(revoke.slice(0, 200)).toContain("from public, anon, authenticated;");
  });

  it.each([LOOKUP, STAGE])("%s checks the service role itself", (name) => {
    expect(functionBody(name)).toContain("auth.role()");
    expect(functionBody(name)).toContain("patient_ai_service_role_required");
  });

  it.each([LOOKUP, STAGE])("%s pins its search path", (name) => {
    const start = code.indexOf(`create or replace function public.${name}`);
    expect(code.slice(start, code.indexOf("as $$", start))).toContain("set search_path = ''");
  });
});

describe("staging a matched intake", () => {
  it("re-proves the identity instead of trusting a patient id argument", () => {
    const start = code.indexOf(`create or replace function public.${STAGE}`);
    const signature = code.slice(start, code.indexOf("as $$", start));
    // No caller may name the patient this intake points at.
    expect(signature).not.toContain("p_patient_id");
    expect(functionBody(STAGE)).toContain(`public.${LOOKUP}(p_clinic_id, p_national_id, p_full_name)`);
  });

  it("refuses a conversation under human takeover, like every other write", () => {
    expect(functionBody(STAGE)).toContain("human_takeover_active");
  });

  it("files the clinic's own stored details, not the sender's version of them", () => {
    const body = functionBody(STAGE);
    expect(body).toContain("v_patient.date_of_birth");
    expect(body).toContain("v_patient.email");
    expect(body).toContain("v_patient.national_id");
  });

  it("validates the department and the doctor against this clinic", () => {
    const body = functionBody(STAGE);
    expect(body).toContain("d.clinic_id = p_clinic_id");
    expect(body).toContain("pr.department_id = p_department_id");
    expect(body).toContain("invalid_intake_assignment");
  });

  it("marks the row as a pointer, never as a staff approval", () => {
    const body = functionBody(STAGE);
    expect(body).toContain("matched_patient_id");
    expect(body).not.toContain("approved_patient_id");
  });

  it("writes an audit row naming the match", () => {
    expect(functionBody(STAGE)).toContain("ai_patient_intake_matched_existing");
  });
});

const APPROVE = "approve_ai_patient_intake";

describe("the matched-patient foreign key", () => {
  it("carries the clinic with it, exactly as approved_patient_id does", () => {
    // Defence in depth: the database refuses a cross-tenant match even if
    // every RPC above it were wrong.
    expect(code).toContain(
      "foreign key (matched_patient_id, clinic_id)",
    );
    expect(code).toContain("references public.patients(id, clinic_id) on delete restrict");
  });

  it("declares the column with no weaker single-column reference of its own", () => {
    // The old shape — `references public.patients(id) on delete set null` —
    // would let a row point at another clinic's patient.
    expect(code).not.toContain("references public.patients(id) on delete set null");
    expect(code).toContain("add column if not exists matched_patient_id uuid;");
  });

  it("adds the constraint only when it is missing, and drops nothing", () => {
    expect(code).toContain("ai_patient_intakes_matched_patient_clinic_fkey");
    expect(code).toContain("if not exists (");
    expect(code).not.toMatch(/drop\s+constraint/);
  });
});

describe("approving a matched intake", () => {
  it("branches on the column instead of ignoring it", () => {
    const body = functionBody(APPROVE);
    expect(body).toContain("if v_intake.matched_patient_id is not null then");
  });

  it("re-proves the match rather than trusting the stored uuid", () => {
    const body = functionBody(APPROVE);
    const branch = body.slice(body.indexOf("if v_intake.matched_patient_id is not null then"));
    // The same three rules discovery applies: exact folded id, confirming
    // folded name, and a single live candidate.
    expect(branch).toContain(
      "public.fold_national_id(v_matched.national_id)",
    );
    expect(branch).toContain("is distinct from v_intake.national_id_folded");
    expect(branch).toContain("public.fold_patient_name(v_matched.full_name)");
    expect(branch).toContain("is distinct from public.fold_patient_name(v_intake.full_name)");
    expect(branch).toContain("if v_id_count <> 1 then");
    // And the same id bound, so the two cannot disagree about what an id is.
    expect(branch).toContain("char_length(v_intake.national_id_folded) not between 5 and 32");
  });

  it("only ever reuses a live patient of the same clinic", () => {
    const body = functionBody(APPROVE);
    const branch = body.slice(
      body.indexOf("if v_intake.matched_patient_id is not null then"),
      body.indexOf("v_patient_id := v_matched.id;"),
    );
    expect(branch).toContain("p.id = v_intake.matched_patient_id");
    expect(branch).toContain("p.clinic_id = v_intake.clinic_id");
    expect(branch).toContain("not p.is_deleted");
    expect(branch).toContain("p.deleted_at is null");
  });

  it("reuses the file instead of creating a second one", () => {
    const body = functionBody(APPROVE);
    const branch = body.slice(
      body.indexOf("if v_intake.matched_patient_id is not null then"),
      body.indexOf("v_patient_id := v_matched.id;"),
    );
    // No file-number allocation and no patient insert anywhere in the branch:
    // the only assignment it makes is the existing patient's own id.
    expect(branch).not.toContain("insert into public.patients");
    expect(branch).not.toContain("file_number");
    expect(functionBody(APPROVE)).toContain("v_patient_id := v_matched.id;");
  });

  it("never reaches the sender-phone duplicate arithmetic", () => {
    // The beneficiary is booked from somebody else's handset by definition, so
    // the phone/id counts are the wrong question. They must sit in the *else*.
    const body = functionBody(APPROVE);
    const matchedAt = body.indexOf("if v_intake.matched_patient_id is not null then");
    const elseAt = body.indexOf("v_patient_id := v_matched.id;");
    const phoneCountAt = body.indexOf("into v_phone_count");
    expect(matchedAt).toBeGreaterThanOrEqual(0);
    expect(phoneCountAt).toBeGreaterThan(elseAt);
    const branch = body.slice(matchedAt, elseAt);
    expect(branch).not.toContain("intake_duplicate_review_required");
  });

  it("fails closed on one deterministic error, disclosing nothing else", () => {
    const body = functionBody(APPROVE);
    const branch = body.slice(
      body.indexOf("if v_intake.matched_patient_id is not null then"),
      body.indexOf("v_patient_id := v_matched.id;"),
    );
    const raises = branch.match(/raise exception '[a-z_]+'/g) ?? [];
    expect(raises.length).toBeGreaterThanOrEqual(3);
    // Clinic mismatch, deleted patient, identity drift and ambiguity are one
    // and the same answer to the reviewer: no oracle, no cross-clinic hint.
    for (const raised of raises) {
      expect(raised).toBe("raise exception 'intake_matched_patient_review_required'");
    }
    // And no branch of it falls through to creating a patient.
    expect(branch).not.toContain("insert into public.patients");
  });

  it("approves the reused patient exactly as it approves a created one", () => {
    const body = functionBody(APPROVE);
    // One approval write, fed by the one v_patient_id both branches set.
    expect(body).toContain("approved_patient_id = v_patient_id");
    expect(body.match(/approved_patient_id = v_patient_id/g) ?? []).toHaveLength(1);
    // And one linked-appointment path, likewise shared.
    expect(body.match(/insert into public.appointments/g) ?? []).toHaveLength(1);
  });

  it("leaves the already-approved short circuit untouched", () => {
    const body = functionBody(APPROVE);
    expect(body).toContain("if v_intake.review_status = 'approved' then");
    // It still returns the recorded patient and the linked appointment, and
    // still returns *before* any of the resolution logic runs.
    expect(body).toContain("return query select v_intake.approved_patient_id, v_appointment_id, true;");
    expect(body.indexOf("if v_intake.review_status = 'approved' then")).toBeLessThan(
      body.indexOf("if v_intake.matched_patient_id is not null then"),
    );
  });

  it("keeps the unmatched path byte-identical to the certified one", () => {
    // The whole safety argument for replacing a reviewed function is that an
    // intake without a match takes the code it already took. Compare the else
    // branch against the P10 function it came from, ignoring indentation.
    const p10 = readFileSync(
      "supabase/migrations/20260824120000_p10_assistant_style_and_booking_identity.sql",
      "utf8",
    );
    const normalize = (text: string) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("--"))
        .join("\n");
    const slice = (whole: string) => {
      const text = whole.slice(whole.indexOf(`function public.${APPROVE}`));
      const start = text.indexOf("select count(*)::integer into v_phone_count");
      const end = text.indexOf("returning id into v_patient_id;", start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return normalize(text.slice(start, end));
    };
    expect(slice(raw)).toBe(slice(p10));
  });

  it("stays staff-only and is never handed to the browser roles", () => {
    const revoke = code.slice(code.indexOf(`revoke all on function public.${APPROVE}`));
    expect(revoke.slice(0, 200)).toContain("from public, anon;");
    expect(revoke.slice(0, 300)).toContain("to authenticated;");
    // The review gate itself is unchanged.
    expect(functionBody(APPROVE)).toContain("intake_review_forbidden");
    expect(functionBody(APPROVE)).toContain("'admin', 'manager', 'receptionist'");
  });
});

describe("the migration's blast radius", () => {
  it("adds one nullable column, its clinic-scoped key, and nothing else", () => {
    const alters = code.match(/alter table [^;]+;/g) ?? [];
    expect(alters).toHaveLength(2);
    expect(alters[0]).toContain("add column if not exists matched_patient_id uuid");
    expect(alters[1]).toContain("add constraint ai_patient_intakes_matched_patient_clinic_fkey");
  });

  it("replaces exactly one existing function, and it is the approval one", () => {
    const replaced = code.match(/create or replace function public\.(\w+)/g) ?? [];
    expect(replaced).toHaveLength(3);
    expect(replaced.at(-1)).toContain(APPROVE);
  });

  it("leaves the certified new-file staging path untouched", () => {
    expect(code).not.toContain("stage_patient_intake_from_conversation");
  });

  it("reads, writes, backfills and drops no data at migration time", () => {
    expect(code).not.toMatch(/\bdelete\s+from\b/);
    expect(code).not.toMatch(/\bdrop\s+(table|column|constraint|policy)\b/);
    // The only INSERTs are inside the staging function body, never at the top
    // level of the migration.
    const topLevel = code.slice(0, code.indexOf(`create or replace function public.${STAGE}`));
    expect(topLevel).not.toMatch(/\binsert\s+into\b/);
  });
});
