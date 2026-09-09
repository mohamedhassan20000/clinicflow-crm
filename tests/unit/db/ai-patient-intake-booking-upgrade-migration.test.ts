import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260822120000_ai_patient_intake_booking_upgrade.sql",
  "utf8",
);
const patientPage = readFileSync("app/(protected)/patients/page.tsx", "utf8");
const dashboard = readFileSync(
  "components/dashboard/ai-pending-appointments-section.tsx",
  "utf8",
);
const registerTool = readFileSync("lib/ai/tools/register-patient.ts", "utf8");
const bookingTool = readFileSync("lib/ai/tools/create-preliminary-booking.ts", "utf8");
const prompt = readFileSync("lib/ai/prompts/patient.ts", "utf8");
const patientMutations = readFileSync("lib/patients/mutations.ts", "utf8");
const adminClient = readFileSync("lib/supabase/admin.ts", "utf8");
const databaseTypes = readFileSync("types/database.ts", "utf8");

describe("AI patient intake + appointment booking upgrade", () => {
  it("stages unknown patients in tenant-scoped RLS tables instead of auto-creating a patient", () => {
    expect(migration).toContain("create table public.ai_patient_intakes");
    expect(migration).toContain("create table public.ai_appointment_requests");
    expect(migration).toContain("alter table public.ai_patient_intakes enable row level security");
    expect(migration).toContain("clinic_id = public.auth_clinic_id()");
    const staging = migration.slice(
      migration.indexOf("function public.stage_patient_intake_from_conversation"),
      migration.indexOf("function public.create_provisional_ai_appointment_request"),
    );
    expect(staging).toContain("insert into public.ai_patient_intakes");
    expect(staging).not.toContain("insert into public.patients");
    expect(registerTool).toContain("stagePatientIntakeFromConversation");
    expect(registerTool).not.toContain("registerPatientFromConversation");
  });

  it("keeps identity matching exact and non-disclosing", () => {
    expect(migration).toContain("p.phone = v_phone");
    expect(migration).toContain("public.fold_national_id");
    expect(migration).toContain("status := 'duplicate_review'");
    expect(registerTool).toContain("needs_staff_review");
  });

  it("makes approval transactional and retry-idempotent", () => {
    expect(migration).toContain("function public.approve_ai_patient_intake");
    expect(migration).toContain("for update");
    expect(migration).toContain("if v_intake.review_status = 'approved'");
    expect(migration).toContain("already_processed");
    expect(migration).toContain("insert into public.patients");
    expect(migration).toContain("set status = 'linked', appointment_id = v_appointment_id");
    expect(patientMutations).toContain("approveAiPatientIntakeMutation");
    expect(patientMutations).toContain("patientCreateSchema.safeParse");
  });

  it("uses an owner- and intake-bound internal approval context without weakening guards", () => {
    expect(migration).toContain("function public.ai_intake_approval_context_matches");
    expect(migration).toContain("current_user::text <> v_approval_owner");
    expect(migration).toContain("v_actor_id is distinct from auth.uid()");
    expect(migration).toContain("i.review_status = 'pending_review'");
    expect(migration).toContain("clinicflow.ai_intake_approval_id");
    expect(migration).toContain("PATIENT_AI_IDENTITY_STATE_SERVER_ONLY");
    expect(migration).toContain("AI_BOOKING_METADATA_SERVER_ONLY");
    expect(migration).toContain("new.ai_action_receipt_id is not null");
    expect(migration).toContain("AI_BOOKING_ACTION_RECEIPT_MISMATCH");
    expect(migration).toContain("HUMAN_TAKEOVER_ACTIVE");
    expect(migration).toContain("AI_BOOKING_CONVERSATION_IDENTITY_MISMATCH");
    expect(migration).toContain(
      "v_is_intake_approval or conversation.status = 'open'::public.conversation_status",
    );
  });

  it("expires stale provisional requests before insert and through maintenance", () => {
    const createRequest = migration.slice(
      migration.indexOf("function public.create_provisional_ai_appointment_request"),
      migration.indexOf("function public.expire_ai_appointment_requests"),
    );
    expect(createRequest).toContain("set status = 'expired'");
    expect(createRequest).toContain("r.expires_at <= clock_timestamp()");
    expect(migration).toContain("function public.expire_ai_appointment_requests");
    expect(migration).toContain("for update skip locked");
    expect(migration).toContain(
      "grant execute on function public.expire_ai_appointment_requests",
    );
  });

  it("preserves the entered national id and folds only the comparison key", () => {
    expect(migration).toContain("national_id_folded text generated always as");
    expect(migration).toContain("lower(btrim(p_email)), btrim(p_national_id)");
    expect(migration).toContain(
      "public.fold_national_id(p.national_id) = v_intake.national_id_folded",
    );
    expect(migration).toContain(
      "v_intake.clinic_id, v_intake.full_name, v_intake.national_id",
    );
  });

  it("makes the superseded direct patient-registration RPC unreachable", () => {
    expect(migration).toContain(
      "drop function if exists public.register_patient_from_conversation",
    );
    expect(adminClient).not.toContain("registerPatientFromConversation");
    expect(databaseTypes).not.toContain("register_patient_from_conversation:");
  });

  it("uses only real availability, pending status, and race-safe takeover guards", () => {
    expect(migration).toContain("function public.ai_requested_slot_is_available");
    expect(migration).toContain("doctor_schedules");
    expect(migration).toContain("doctor_unavailability");
    expect(migration).toContain("'pending'::public.appointment_status");
    expect(migration).toContain("trg_appointments_block_paused_ai_insert");
    expect(migration).toContain("HUMAN_TAKEOVER_ACTIVE");
    expect(bookingTool).toContain("resolvePatientInput(identity, \"appointment_time\"");
  });

  it("records explicit AI provenance without a fake user", () => {
    expect(migration).toContain("add column if not exists actor_type text");
    expect(migration).toContain("'ai', 'ai_assistant'");
    expect(migration).toContain("created_by,\n            ai_patient_conversation_id");
    expect(migration).toContain("'pending'::public.appointment_status, null");
  });

  it("mounts localized Patients and Dashboard review surfaces", () => {
    expect(patientPage).toContain("AiIntakeReviewSection");
    expect(patientPage).toContain('.eq("review_status", "pending_review")');
    expect(dashboard).toContain("aiAppointmentsAwaitingConfirmation");
    const appointmentDetail = readFileSync(
      "components/appointments/appointment-detail-dialog.tsx",
      "utf8",
    );
    expect(appointmentDetail).toContain("ai_patient_conversation_id");
    expect(appointmentDetail).toContain('protectedT("aiAssistant")');
    expect(prompt).toContain("Your treating doctor is Dr X");
    expect(prompt).toContain("طبيبك المعالج");
  });

  it("enforces days-first booking and the minimum-lead-time rule in code and SQL", () => {
    const availability = readFileSync("lib/booking/patient.ts", "utf8");
    const tools = readFileSync("lib/ai/patient-tools.ts", "utf8");
    expect(tools).toContain('"list_available_days"');
    expect(prompt).toContain("offer only the returned DAYS");
    expect(prompt).toContain("الأيام التي أعادتها فقط");
    // The application-side rule is now a calendar-day floor rather than a
    // rolling `now + 24h` duration, and it lives in one module rather than in
    // three literals — see `lib/booking/lead-time.ts` for why. It is strictly
    // stricter than the SQL below, which stays exactly as it is: the database
    // remains the last line of defence at 24 hours and the assistant refuses
    // well before reaching it.
    expect(availability).toContain("earliestOnlineBookableInstant");
    expect(availability).toContain("isOnlineBookableDate");
    expect(migration).toContain("clock_timestamp() + interval '24 hours'");
    expect(migration).toContain("AI_BOOKING_MINIMUM_NOTICE");
  });

  it("treats a soft-deleted patient link as unlinked without weakening active identity links", () => {
    expect(migration).toContain("case when patient.id is null then null else conversation.patient_id end");
    expect(migration).toContain("patient.id is not null");
    expect(migration).toContain("and not patient.is_deleted and patient.deleted_at is null");
    expect(migration).toContain("set patient_id = null, patient_link_status = 'unlinked'");
  });

  it("allows managers to review staged intakes without granting general patient writes", () => {
    expect(migration).toContain("'manager'::public.user_role");
    const requestReadPolicy = migration.slice(
      migration.indexOf("create policy ai_appointment_requests_staff_read"),
      migration.indexOf("function public.resolve_patient_ai_context"),
    );
    expect(requestReadPolicy).not.toContain("'assistant'::public.user_role");
    expect(patientMutations).toContain(
      'AI_INTAKE_REVIEW_ROLES = ["admin", "manager", "receptionist"]',
    );
    expect(patientMutations).toContain(
      'PATIENT_WRITE_ROLES = ["admin", "receptionist"]',
    );
  });
});
