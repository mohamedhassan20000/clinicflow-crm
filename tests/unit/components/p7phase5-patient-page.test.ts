import { readFileSync } from "node:fs";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "@/messages/ar.json";
import en from "@/messages/en.json";

const patientPage = readFileSync(
  "app/(protected)/patients/[id]/page.tsx",
  "utf8",
);
const fullHistoryPage = readFileSync(
  "app/(protected)/patients/[id]/history/page.tsx",
  "utf8",
);
const appointmentCard = readFileSync(
  "components/patients/file/appointment-history-card.tsx",
  "utf8",
);

describe("Phase 5 patient page contract", () => {
  it("renders the required top-level section order", () => {
    const appointments = patientPage.indexOf("<AppointmentHistorySection");
    const deposits = patientPage.indexOf("<PatientDepositsSection");
    const packages = patientPage.indexOf("<PatientPackagesSection");
    const documents = patientPage.indexOf("<PatientDocumentsSection");

    expect(appointments).toBeGreaterThan(-1);
    expect(deposits).toBeGreaterThan(appointments);
    expect(packages).toBeGreaterThan(deposits);
    expect(documents).toBeGreaterThan(packages);
  });

  it("removes standalone notes/attachments while keeping appointment authoring", () => {
    expect(patientPage).not.toContain("<MedicalNotesList");
    expect(patientPage).not.toContain("<NoteComposer");
    expect(appointmentCard).toContain("<MedicalNotesList");
    expect(appointmentCard).toContain("<NoteComposer");
    expect(appointmentCard).toContain("appointmentId={appointment.id}");
  });

  it("keeps exactly five on the Patient File and an unbounded full-history route", () => {
    expect(patientPage).toContain(
      "limit: PATIENT_FILE_APPOINTMENT_PREVIEW_LIMIT",
    );
    expect(patientPage).toContain("${patientPath}/history");
    expect(fullHistoryPage).toContain("loadAppointmentHistory(supabase");
    expect(fullHistoryPage).not.toContain("limit:");
  });

  it("preserves note/attachment and financial role boundaries", () => {
    expect(patientPage).toContain(
      'const canManageMedicalNotes = isAdmin || isDoctor;',
    );
    expect(patientPage).toContain(
      'const canViewMedicalNotes = canManageMedicalNotes || isReceptionist;',
    );
    expect(patientPage).toContain("{!isScopedClinical && (");
    expect(patientPage).toContain("canUploadNoteAttachments={canManageMedicalNotes}");
    expect(patientPage).toContain("canViewNoteAttachments={canViewMedicalNotes}");
  });

  it("resolves every Phase 5 appointment surface in English and Arabic", () => {
    const keys = [
      "appointmentHistory",
      "medicalNotes",
      "relatedDocuments",
      "attachmentCount",
      "addNote",
      "attachFile",
      "deposits",
      "viewAllPackages",
      "viewFullHistory",
    ] as const;
    const english = createTranslator({ locale: "en", messages: en, namespace: "patients" });
    const arabic = createTranslator({ locale: "ar", messages: ar, namespace: "patients" });

    for (const key of keys) {
      const values = key === "attachmentCount" ? { count: 1 } : undefined;
      expect(english(key, values)).toMatch(/[A-Za-z]/);
      expect(arabic(key, values)).toMatch(/[\u0600-\u06ff]/);
      expect(arabic(key, values)).not.toBe(english(key, values));
    }
  });
});
