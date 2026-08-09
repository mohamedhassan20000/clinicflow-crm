import { describe, expect, it } from "vitest";
import { clinicSchema } from "@/lib/validations/settings";

const valid = {
  name: "ClinicFlow Clinic",
  phone: null,
  address: null,
  email: "documents@clinic.example",
  website: "https://clinic.example",
  license_no: "LIC-123",
  tax_id: "VAT-456",
  document_footer: "Private medical record",
  branding_metadata: '{"instagram":"@clinic"}',
  time_format: "24h" as const,
};

describe("P7-0 clinic branding validation", () => {
  it("accepts the complete branding payload", () => {
    expect(clinicSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects malformed URLs and non-object metadata", () => {
    expect(clinicSchema.safeParse({ ...valid, website: "clinic.example" }).success).toBe(false);
    expect(clinicSchema.safeParse({ ...valid, branding_metadata: "[]" }).success).toBe(false);
    expect(clinicSchema.safeParse({ ...valid, branding_metadata: "not-json" }).success).toBe(false);
  });

  it("normalizes optional branding strings to null", () => {
    const parsed = clinicSchema.parse({
      ...valid,
      email: "",
      website: "  ",
      license_no: "",
      tax_id: "",
      document_footer: "",
    });
    expect(parsed).toMatchObject({
      email: null,
      website: null,
      license_no: null,
      tax_id: null,
      document_footer: null,
    });
  });
});

