/**
 * Findings 8, 9 and 10 — the V2 migration must mean what it says.
 *
 * These are text assertions over SQL that no test here can execute, which is
 * precisely why they are worth pinning: all three defects were *comments*
 * describing predicates and guarantees the SQL did not implement, and a comment
 * is exactly the kind of thing that drifts back without a check.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PATH = "supabase/migrations/20260913120000_v2_patient_assistant_flow_state.sql";
const migration = readFileSync(join(process.cwd(), PATH), "utf8");

/** The body of one `create or replace function`, up to its terminating `$$;`. */
function functionBody(name: string): string {
  const start = migration.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const end = migration.indexOf("$$;", start);
  return migration.slice(start, end);
}

describe("finding 8: issued documents are filtered on a real predicate", () => {
  const body = functionBody("list_patient_ai_documents");

  it("requires an issuer, not just an issued status", () => {
    // The contract in the migration header and in `lib/ai/v2/tools.ts` both
    // cite `issued_by` as the guarantee that nothing the AI produced is
    // reachable. It was only ever a comment.
    expect(body).toContain("d.issued_by is not null");
  });

  it("keeps the rest of the retrieval-only shape", () => {
    expect(body).toContain("d.status = 'issued'");
    expect(body).toContain("d.voided_at is null");
    expect(body).toContain("d.pdf_storage_path is not null");
    // Patient comes from the conversation's linkage, never from an argument.
    expect(body).toContain("c.patient_id");
    expect(body).not.toContain("p_patient_id");
  });

  it("cannot write", () => {
    for (const verb of ["insert into", "update public.documents", "delete from"]) {
      expect(body.toLowerCase()).not.toContain(verb);
    }
  });
});

describe("finding 9: the idempotency rationale names the index that provides it", () => {
  it("cites appointments_patient_active_slot_key", () => {
    const header = migration.slice(
      migration.indexOf("create_patient_preliminary_booking_v2") - 3000,
      migration.indexOf("create or replace function public.create_patient_preliminary_booking_v2("),
    );
    expect(header).toContain("appointments_patient_active_slot_key");
  });

  it("no longer claims a per-conversation pending-booking uniqueness", () => {
    // There is no such constraint; `create_patient_preliminary_booking`
    // inserts unconditionally.
    expect(migration).not.toContain(
      "Idempotency is the conversation's pending-booking uniqueness",
    );
  });

  it("still rolls the decrement back when the booking fails", () => {
    const body = functionBody("create_patient_preliminary_booking_v2");
    expect(body).toContain("for update");
    expect(body).toContain("PACKAGE_EXHAUSTED");
    expect(body).toContain("BOOKING_FAILED");
    // The decrement precedes the insert inside one transaction, which is what
    // makes the rollback total.
    expect(body.indexOf("used_sessions = used_sessions + 1")).toBeLessThan(
      body.indexOf("BOOKING_FAILED"),
    );
  });
});

describe("finding 10: every new function guards on the service role", () => {
  const functions = [
    "set_conversation_flow_state",
    "reset_conversation_flow_state",
    "list_clinic_public_packages",
    "list_patient_ai_packages",
    "create_patient_preliminary_booking_v2",
    "list_patient_ai_documents",
  ];

  it.each(functions)("%s raises for a non-service role", (name) => {
    const body = functionBody(name);
    expect(body).toContain("coalesce(auth.role(), '') <> 'service_role'");
    expect(body).toContain("PATIENT_AI_SERVICE_ROLE_REQUIRED");
  });

  it.each(functions)("%s is revoked from public, anon and authenticated", (name) => {
    const revoke = migration.slice(migration.indexOf(`revoke all on function public.${name}(`));
    expect(revoke.slice(0, 400)).toContain("from public, anon, authenticated");
  });

  it("pins search_path on every one of them", () => {
    for (const name of functions) {
      expect(functionBody(name), name).toContain("set search_path = ''");
    }
  });
});
