import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260828120000_p11j_exact_ai_review_notifications.sql",
  "utf8",
);

describe("P11J · exact AI review notification links", () => {
  it("links a provisional booking to its actual intake record", () => {
    expect(migration).toContain(
      "'/patients?review=1&intake=' || new.intake_id::text || '#ai-intakes'",
    );
  });

  it("notifies every authorized intake-review role only after an intake insert", () => {
    expect(migration).toContain("after insert on public.ai_patient_intakes");
    for (const role of ["admin", "manager", "receptionist"]) {
      expect(migration).toContain(`'${role}'::public.user_role`);
    }
    expect(migration).toContain("'ai_patient_intake'");
    expect(migration).toContain(
      "'/patients?review=1&intake=' || new.id::text || '#ai-intakes'",
    );
  });

  it("does not grant either trigger function to client roles", () => {
    expect(migration).toContain(
      "revoke all on function public.notify_staff_of_ai_booking_commit()",
    );
    expect(migration).toContain(
      "revoke all on function public.notify_staff_of_ai_intake_commit()",
    );
    expect(migration).not.toMatch(/grant execute/i);
  });
});
