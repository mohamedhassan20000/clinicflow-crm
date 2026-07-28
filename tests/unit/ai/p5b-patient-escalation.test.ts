import { describe, expect, it } from "vitest";
import {
  detectPatientEscalation,
  emergencyNumberForCountry,
} from "@/lib/ai/patient-escalation";
import {
  normalizeClinicAiReplyMode,
  resolveEffectiveAiReplyMode,
} from "@/lib/ai/patient-reply-mode";
import { patientEscalationCopy } from "@/lib/messaging/patient-copy";
import { resolveEntitlements, type Entitlements } from "@/lib/entitlements";

function proAi(features: Record<string, boolean>): Entitlements {
  return resolveEntitlements({
    clinicId: "clinic",
    planSlug: "pro_ai",
    planFeatures: { ai_assistant: true, ...features },
    subscriptionAllowed: true,
  });
}

describe("P5B — deterministic escalation detection (§6.5)", () => {
  it("flags emergencies in English and Arabic and routes them to the safety response", () => {
    for (const text of [
      "I have severe chest pain and can't breathe",
      "this is an emergency please help",
      "عندي ألم في الصدر ولا أستطيع التنفس",
      "أحتاج إسعاف الآن",
    ]) {
      const detection = detectPatientEscalation(text);
      expect(detection).toMatchObject({ escalate: true, reason: "emergency", emergency: true });
    }
  });

  it("flags explicit human-handoff requests without the emergency path", () => {
    for (const text of [
      "I want to talk to a human",
      "can I speak with a receptionist",
      "أريد التحدث مع موظف",
      "ممكن تحويلي لموظف",
    ]) {
      const detection = detectPatientEscalation(text);
      expect(detection).toMatchObject({ escalate: true, reason: "human_requested", emergency: false });
    }
  });

  it("flags medical questions and complaints for a human", () => {
    expect(detectPatientEscalation("what dosage of the medication should I take")).toMatchObject({
      escalate: true,
      reason: "medical",
    });
    expect(detectPatientEscalation("I want to file a complaint, this is unacceptable")).toMatchObject({
      escalate: true,
      reason: "complaint",
    });
  });

  it("does not escalate ordinary logistics questions", () => {
    for (const text of [
      "what are your opening hours",
      "I want to book an appointment tomorrow",
      "كم سعر الكشف",
      "أريد حجز موعد",
    ]) {
      expect(detectPatientEscalation(text).escalate).toBe(false);
    }
  });

  it("prioritizes emergency over a human request in the same message", () => {
    const detection = detectPatientEscalation("emergency! I need to talk to a person");
    expect(detection.reason).toBe("emergency");
  });

  it("maps clinic country to a local emergency number with a safe default", () => {
    expect(emergencyNumberForCountry("KW")).toBe("112");
    expect(emergencyNumberForCountry("SA")).toBe("997");
    expect(emergencyNumberForCountry("eg")).toBe("123");
    expect(emergencyNumberForCountry(null)).toBe("112");
    expect(emergencyNumberForCountry("ZZ")).toBe("112");
  });
});

describe("P5B — effective reply-mode resolution (§6.2 safety gate)", () => {
  it("normalizes unknown column values to off", () => {
    expect(normalizeClinicAiReplyMode(undefined)).toBe("off");
    expect(normalizeClinicAiReplyMode("nonsense")).toBe("off");
    expect(normalizeClinicAiReplyMode("suggest")).toBe("suggest");
    expect(normalizeClinicAiReplyMode("auto")).toBe("auto");
  });

  it("stays off without the patient-suggest entitlement even when the clinic asks for it", () => {
    const entitlements = resolveEntitlements({
      clinicId: "clinic",
      planSlug: "pro",
      planFeatures: {},
      subscriptionAllowed: true,
    });
    expect(resolveEffectiveAiReplyMode({ clinicMode: "auto", entitlements })).toBe("off");
  });

  it("downgrades auto to suggest without ai.patient_auto", () => {
    const entitlements = proAi({ "ai.patient_suggest": true, "ai.patient_auto": false });
    expect(resolveEffectiveAiReplyMode({ clinicMode: "auto", entitlements })).toBe("suggest");
    expect(resolveEffectiveAiReplyMode({ clinicMode: "suggest", entitlements })).toBe("suggest");
  });

  it("honors auto only with ai.patient_auto", () => {
    const entitlements = proAi({ "ai.patient_suggest": true, "ai.patient_auto": true });
    expect(resolveEffectiveAiReplyMode({ clinicMode: "auto", entitlements })).toBe("auto");
  });

  it("off column is always off", () => {
    const entitlements = proAi({ "ai.patient_suggest": true, "ai.patient_auto": true });
    expect(resolveEffectiveAiReplyMode({ clinicMode: "off", entitlements })).toBe("off");
  });
});

describe("P5B — canned escalation copy carries no PHI", () => {
  it("emergency copy surfaces the local emergency number and clinic phone in both locales", () => {
    const en = patientEscalationCopy("emergency", {
      locale: "en",
      clinicName: "Smile Clinic",
      clinicPhone: "+96500000000",
      emergencyNumber: "112",
    });
    expect(en).toContain("112");
    expect(en).toContain("+96500000000");
    const ar = patientEscalationCopy("emergency", {
      locale: "ar",
      clinicName: "عيادة",
      clinicPhone: "+96500000000",
      emergencyNumber: "997",
    });
    expect(ar).toContain("997");
  });

  it("handoff copy omits a missing phone gracefully", () => {
    const en = patientEscalationCopy("handoff", {
      locale: "en",
      clinicName: "Smile Clinic",
      clinicPhone: null,
      emergencyNumber: "112",
    });
    expect(en).toContain("Smile Clinic");
    expect(en).not.toContain("null");
  });
});
