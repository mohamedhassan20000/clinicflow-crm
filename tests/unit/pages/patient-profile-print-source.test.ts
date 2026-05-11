import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("patient profile print page wiring", () => {
  it("does not render the removed patient profile print button or print-only document", () => {
    const pageSource = readFileSync(
      join(process.cwd(), "app/(protected)/patients/[id]/page.tsx"),
      "utf8",
    );

    expect(pageSource).not.toContain("PatientProfilePrintButton");
    expect(pageSource).not.toContain("PatientProfilePrintDocument");
    expect(pageSource).not.toContain("data-patient-profile-print-hide");
  });
});
