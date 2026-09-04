import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASSISTANT_LAUNCHER_REGISTRY } from "@/lib/ai/launchers";
import { buildAssistantPageContextPrompt } from "@/lib/ai/page-context";

describe("P4.9B patient-details Ask Assistant regression", () => {
  it("keeps patient placement on the doctor clinical launcher, with assistant supported but default OFF", () => {
    const patient = ASSISTANT_LAUNCHER_REGISTRY.find(
      (definition) => definition.area === "patient",
    );
    expect(patient).toMatchObject({
      contextType: "patient",
      pageSlug: "patients",
      roles: ["doctor", "assistant"],
    });
    // Doctor stays enabled by default; the assistant (scoped) is supported but OFF.
    expect(patient?.defaultEnabledByRole).toEqual({ doctor: true, assistant: false });
  });

  it("attaches the already-authorized patient id and immediately explains this-patient references", () => {
    const patientId = "22222222-2222-4222-8222-222222222222";
    const prompt = buildAssistantPageContextPrompt(
      { type: "patient", patientId },
      "en",
    );

    expect(prompt).toContain("opened this chat from a patient profile");
    expect(prompt).toContain(`internal patient id "${patientId}"`);
    expect(prompt).toContain("this patient");
    expect(prompt).toContain("context grants no access");
  });

  it("renders only after patient-page authorization and re-authorizes again when opened", () => {
    const page = readFileSync(
      "app/(protected)/patients/[id]/page.tsx",
      "utf8",
    );
    const launchers = readFileSync("lib/ai/launchers.ts", "utf8");

    expect(page.indexOf("if (!patient) notFound()"))
      .toBeLessThan(page.indexOf("const assistantPromise"));
    expect(page.indexOf("if (isDoctor && !doctorCanAccessPatient) notFound()"))
      .toBeLessThan(page.indexOf("const assistantPromise"));
    expect(page).toContain('type: "patient", patientId: patient.id');
    expect(page).toContain("contextLabel={patient.full_name}");

    // The re-authorization must still come first. What it now gates is the
    // server-derived context seed for the new conversation the launcher opens,
    // rather than the read of an existing conversation's history.
    const reauthorization = launchers.indexOf(
      "await assertDoctorPatientContextAccess",
    );
    expect(reauthorization).toBeGreaterThan(-1);
    const seed = launchers.indexOf("resolvePageContextSeed({", reauthorization);
    expect(seed).toBeGreaterThan(reauthorization);
    // The launcher must not resume the caller's latest conversation any more.
    expect(launchers).not.toContain("loadAssistantConversationForSurface");
  });
});

describe("P4.9B phase boundary", () => {
  // P4.11A now owns the read-only workflow engine and ledger. This regression
  // guard tracks the still-unstarted P4.11B action/confirmation surface.
  it("does not add P4.11B action execution or workflow UI", () => {
    const databaseTypes = readFileSync("types/database.ts", "utf8");
    const commercialPolicy = readFileSync("lib/ai/commercial-policy.ts", "utf8");

    expect(databaseTypes).toContain("ai_workflow_runs");
    expect(commercialPolicy).toContain('"ai.workflows"');
    expect(commercialPolicy).not.toContain('"ai.workflow_actions"');
    expect(databaseTypes).not.toContain("workflow_action_steps");
  });
});
