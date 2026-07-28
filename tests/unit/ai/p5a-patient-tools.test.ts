import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  entitlements: vi.fn(),
  resolveContext: vi.fn(),
  verifyDob: vi.fn(),
  listAppointments: vi.fn(),
  cancelAppointment: vi.fn(),
  searchFaq: vi.fn(),
  availability: vi.fn(),
  createBooking: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: mocks.entitlements,
  hasFeature: (
    entitlements: { subscriptionAllowed: boolean; features: Record<string, boolean> },
    feature: string,
  ) => entitlements.subscriptionAllowed && entitlements.features[feature] === true,
}));
vi.mock("@/lib/supabase/admin", () => ({
  resolvePatientAiContext: mocks.resolveContext,
  verifyPatientConversationDob: mocks.verifyDob,
  listPatientAiAppointments: mocks.listAppointments,
  cancelPatientAiAppointment: mocks.cancelAppointment,
  searchPatientClinicFaq: mocks.searchFaq,
  logAgentToolCall: vi.fn().mockResolvedValue({ data: "audit", error: null }),
}));
vi.mock("@/lib/booking/patient", () => ({
  getPatientAvailableSlots: mocks.availability,
  createPatientPendingBooking: mocks.createBooking,
}));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: mocks.audit }));

import { buildPatientTools, PATIENT_TOOL_NAMES } from "@/lib/ai/patient-tools";
import { getTaskPolicy } from "@/lib/ai/platform/registry";
import { buildPatientSystemPrompt } from "@/lib/ai/prompts/patient";

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const DOCTOR = "44444444-4444-4444-8444-444444444444";
const APPOINTMENT = "55555555-5555-4555-8555-555555555555";
const opts = {} as never;

const context = {
  clinicId: CLINIC,
  conversationId: CONVERSATION,
  locale: "en" as const,
};

function resolved(overrides: Record<string, unknown> = {}) {
  return {
    clinic_id: CLINIC,
    conversation_id: CONVERSATION,
    patient_id: PATIENT,
    linked: true,
    identity_verified_at: "2026-07-27T10:00:00Z",
    identity_locked_until: null,
    clinic_name: "Clinic",
    clinic_locale: "en",
    clinic_timezone: "Asia/Kuwait",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.entitlements.mockResolvedValue({
    clinicId: CLINIC,
    planSlug: "pro_ai",
    subscriptionAllowed: true,
    features: {
      ai_assistant: true,
      "ai.patient_suggest": true,
      "ai.scheduling": true,
    },
    limits: {},
  });
  mocks.resolveContext.mockResolvedValue({ data: [resolved()], error: null });
  mocks.verifyDob.mockResolvedValue({
    data: [{
      verified: true,
      identity_verified_at: "2026-07-27T10:00:00Z",
      locked_until: null,
      attempts_remaining: 5,
    }],
    error: null,
  });
  mocks.listAppointments.mockResolvedValue({ data: [], error: null });
  mocks.cancelAppointment.mockResolvedValue({
    data: [{ cancelled: true, reason: "cancelled" }],
    error: null,
  });
  mocks.searchFaq.mockResolvedValue({ data: [], error: null });
  mocks.availability.mockResolvedValue({
    ok: true,
    doctorId: DOCTOR,
    doctorName: "Dr Test",
    date: "2026-08-01",
    availableSlots: ["09:00"],
  });
  mocks.createBooking.mockResolvedValue({
    ok: true,
    appointmentId: APPOINTMENT,
    expiresAt: "2026-07-28T10:00:00Z",
  });
  mocks.audit.mockResolvedValue(undefined);
});

describe("P5A patient tool mount", () => {
  it("mounts the complete patient booking allow-list and no staff tool", () => {
    const tools = buildPatientTools(context, "patient_booking");
    expect(Object.keys(tools)).toEqual([...PATIENT_TOOL_NAMES]);
    expect(tools).not.toHaveProperty("get_patient_summary");
    expect(tools).not.toHaveProperty("search_authorized_patients");
    expect(tools).not.toHaveProperty("execute_read_only_workflow");
    expect(tools).not.toHaveProperty("run_clinic_report");
  });

  it("narrows a FAQ task to the FAQ tool alone", () => {
    expect(Object.keys(buildPatientTools(context, "patient_faq"))).toEqual([
      "answer_clinic_faq",
    ]);
  });

  it("never exposes patient_id in any model-visible schema", () => {
    const tools = buildPatientTools(context, "patient_booking");
    for (const patientTool of Object.values(tools)) {
      const schema = patientTool.inputSchema as unknown as {
        shape?: Record<string, unknown>;
      };
      expect(Object.keys(schema.shape ?? {})).not.toContain("patient_id");
    }
  });
});

describe("P5A identity gating and tenant binding", () => {
  it("returns an identity challenge before listing appointment details", async () => {
    mocks.resolveContext.mockResolvedValue({
      data: [resolved({ identity_verified_at: null })],
      error: null,
    });
    const tools = buildPatientTools(context, "patient_booking");
    const result = await tools.list_my_appointments!.execute!({}, opts);
    expect(result).toMatchObject({
      permission_denied: true,
      reason: "identity_verification_required",
    });
    expect(mocks.listAppointments).not.toHaveBeenCalled();
  });

  it("fails closed when the RPC returns a different clinic/conversation pair", async () => {
    mocks.resolveContext.mockResolvedValue({
      data: [resolved({ clinic_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })],
      error: null,
    });
    const tools = buildPatientTools(context, "patient_booking");
    const result = await tools.list_my_appointments!.execute!({}, opts);
    expect(result).toMatchObject({
      permission_denied: true,
      reason: "lookup_failed",
    });
    expect(mocks.listAppointments).not.toHaveBeenCalled();
  });

  it("locks DOB retries without exposing the stored DOB", async () => {
    mocks.verifyDob.mockResolvedValue({
      data: [{
        verified: false,
        identity_verified_at: null,
        locked_until: "2026-07-27T10:15:00Z",
        attempts_remaining: 0,
      }],
      error: null,
    });
    const tools = buildPatientTools(context, "patient_booking");
    const result = await tools.verify_patient_identity!.execute!(
      { date_of_birth: "1990-01-01" },
      opts,
    ) as Record<string, unknown>;
    expect(result).toMatchObject({ verified: false, attempts_remaining: 0 });
    expect(JSON.stringify(result)).not.toContain(PATIENT);
    expect(mocks.verifyDob).toHaveBeenCalledWith({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      dateOfBirth: "1990-01-01",
    });
  });
});

describe("P5A booking, FAQ, and policy behavior", () => {
  it("creates only a pending, expiring booking from conversation identity", async () => {
    const tools = buildPatientTools(context, "patient_booking");
    const result = await tools.create_preliminary_booking!.execute!(
      {
        doctor_id: DOCTOR,
        scheduled_at: "2026-08-01T09:00:00+03:00",
        duration_minutes: 30,
      },
      opts,
    );
    expect(result).toMatchObject({
      created: true,
      appointment_id: APPOINTMENT,
      status: "pending",
      requires_staff_confirmation: true,
    });
    expect(mocks.createBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          clinicId: CLINIC,
          conversationId: CONVERSATION,
          patientId: PATIENT,
        }),
      }),
    );
  });

  it("uses only clinic-authored FAQ rows and admits no low-score answer", async () => {
    mocks.searchFaq.mockResolvedValue({
      data: [{
        faq_id: "66666666-6666-4666-8666-666666666666",
        question: "Unrelated",
        answer: "Do something medical",
        language: "en",
        score: 0.01,
      }],
      error: null,
    });
    const tools = buildPatientTools(context, "patient_faq");
    const result = await tools.answer_clinic_faq!.execute!(
      { question: "What are your hours?" },
      opts,
    );
    expect(result).toMatchObject({ found: false });
  });

  it("activates certified P5A patient policies and keeps medical/confirmation refusals in both locales", () => {
    expect(getTaskPolicy("patient_booking", "patient")).toMatchObject({
      version: "p5a-patient-booking-policy-v1",
      maxSteps: 6,
    });
    expect(getTaskPolicy("patient_faq", "patient")).toMatchObject({
      version: "p5a-patient-faq-policy-v1",
      maxSteps: 4,
    });
    expect(buildPatientSystemPrompt("en")).toContain("Never say it is confirmed");
    expect(buildPatientSystemPrompt("en")).toContain("Do not provide medical advice");
    expect(buildPatientSystemPrompt("ar")).toContain("لا تقدم نصيحة طبية");
    expect(buildPatientSystemPrompt("ar")).toContain("لا تقل أبدًا إنه مؤكد");
  });
});
