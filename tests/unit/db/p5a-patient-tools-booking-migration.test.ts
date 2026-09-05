import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260727180000_p5a_patient_tools_booking.sql",
  "utf8",
);
const fixesMigration = readFileSync(
  "supabase/migrations/20260727200000_p5a_review_fixes.sql",
  "utf8",
);
const phase4Migration = readFileSync(
  "supabase/migrations/20260813160000_ai_assistant_phase4_orchestration.sql",
  "utf8",
);
const executable = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");
const types = readFileSync("types/database.ts", "utf8");
const workflowBooking = readFileSync("lib/booking/pending-workflow.ts", "utf8");

describe("P5A patient identity and booking migration", () => {
  it("adds conversation verification with patient-change invalidation and brute-force lockout", () => {
    expect(migration).toContain("add column identity_verified_at timestamptz");
    expect(migration).toContain("identity_verification_failures between 0 and 5");
    expect(migration).toContain("trg_conversations_clear_identity_on_patient_change");
    expect(migration).toContain("protect_patient_ai_identity_state");
    expect(migration).toContain("PATIENT_AI_IDENTITY_STATE_SERVER_ONLY");
    expect(migration).toContain("v_failures >= 5 then v_now + interval '15 minutes'");
  });

  it("enforces configurable TTL, one AI pending per patient, and the per-slot cap under a clinic lock", () => {
    expect(migration).toContain("ai_pending_booking_ttl_minutes integer not null default 1440");
    expect(migration).toContain("ai_pending_slot_cap smallint not null default 2");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("raise exception 'AI_PENDING_PATIENT_CAP'");
    expect(migration).toContain("raise exception 'AI_PENDING_SLOT_CAP'");
    expect(migration).toContain("protect_ai_booking_metadata");
    expect(migration).toContain("AI_BOOKING_METADATA_SERVER_ONLY");
    expect(migration).toContain("trg_appointments_ai_pending_policy");
  });

  it("keeps legacy provenance protected while using only Phase 4 action receipts for new bookings", () => {
    expect(migration).toMatch(
      /new\.ai_patient_conversation_id is not null[\s\S]*?or new\.ai_workflow_run_id is not null[\s\S]*?or new\.expires_at is not null/,
    );
    expect(workflowBooking).toContain("input.supabase.auth.getUser()");
    expect(workflowBooking).toContain(
      "createClinicScopedAdminClient(input.user.clinicId)",
    );
    expect(workflowBooking).toContain('.from("ai_action_receipts")');
    expect(workflowBooking).toContain('.eq("actor_id", input.user.id)');
    expect(workflowBooking).toContain('.eq("action_id", "appointments.create_pending")');
    expect(workflowBooking).toContain('.eq("phase", "execute")');
    expect(workflowBooking).not.toContain('.from("ai_workflow_runs")');
    expect(fixesMigration).toContain(
      "old.ai_workflow_step_id is distinct from new.ai_workflow_step_id",
    );
    expect(fixesMigration).toMatch(
      /update of\s+ai_patient_conversation_id,\s+ai_workflow_run_id,\s+ai_workflow_step_id,\s+expires_at/,
    );
    expect(phase4Migration).toContain(
      "old.ai_workflow_step_id is distinct from new.ai_workflow_step_id",
    );
    expect(phase4Migration).toMatch(
      /update of\s+ai_patient_conversation_id,\s+ai_workflow_run_id,\s+ai_workflow_step_id,\s+ai_action_receipt_id,\s+expires_at/,
    );
  });

  it("binds every patient RPC to clinic + conversation and grants only service_role", () => {
    for (const name of [
      "resolve_patient_ai_context",
      "verify_patient_conversation_dob",
      "create_patient_preliminary_booking",
      "list_patient_ai_appointments",
      "cancel_patient_ai_appointment",
      "search_patient_clinic_faq",
    ]) {
      expect(migration).toContain(`function public.${name}`);
      expect(migration).toMatch(
        new RegExp(`grant execute on function public\\.${name}[\\s\\S]*?to service_role`),
      );
    }
    expect(migration).toContain("coalesce(auth.role(), '') <> 'service_role'");
    expect(migration).toContain("conversation.clinic_id = p_clinic_id");
  });

  it("keeps patient cancellation pending-only and expiry transition-checked/audited", () => {
    expect(migration).toContain(
      "v_appointment.status <> 'pending'::public.appointment_status",
    );
    expect(migration).toContain("'AI_TOOL_CANCEL_MY_APPOINTMENT'");
    expect(migration).toContain("create or replace function public.expire_ai_pending_bookings");
    expect(migration).toContain("'AI_PENDING_BOOKING_EXPIRED'");
    expect(executable).not.toMatch(/delete\s+from\s+public\.appointments/i);
  });

  it("enables suggest + scheduling while keeping patient auto disabled", () => {
    expect(migration).toContain("'ai.patient_suggest', true");
    expect(migration).toContain("'ai.scheduling', true");
    expect(migration).toContain("'ai.patient_auto', false");
  });
});

describe("P5A generated type parity surface", () => {
  it("contains the new appointment, clinic, conversation, and RPC fields", () => {
    expect(types).toContain("ai_patient_conversation_id: string | null");
    expect(types).toContain("expires_at: string | null");
    expect(types).toContain("identity_verified_at: string | null");
    expect(types).toContain("ai_pending_booking_ttl_minutes: number");
    expect(types).toContain("create_patient_preliminary_booking: {");
    expect(types).toContain("resolve_patient_ai_context: {");
  });
});
