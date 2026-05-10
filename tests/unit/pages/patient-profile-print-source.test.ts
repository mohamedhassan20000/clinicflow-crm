import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("patient profile print page wiring", () => {
  it("keeps the interactive screen layout separate from the print document", () => {
    const pageSource = readFileSync(
      join(process.cwd(), "app/(protected)/patients/[id]/page.tsx"),
      "utf8",
    );
    const documentSource = readFileSync(
      join(process.cwd(), "components/patients/patient-profile-print-document.tsx"),
      "utf8",
    );

    expect(pageSource).toContain("<PatientProfilePrintDocument");
    expect(documentSource).toContain("data-patient-profile-print-document");
    expect(pageSource).toContain("data-patient-profile-print-hide");
    expect(pageSource).toContain("<PatientProfilePrintButton");
  });
});
