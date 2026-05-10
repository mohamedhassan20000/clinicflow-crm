import { describe, expect, it } from "vitest";
import { formatDoctorFirstName, formatDoctorName } from "@/lib/format-doctor";

describe("doctor name formatting", () => {
  it("adds a Dr. prefix only when one is not already present", () => {
    expect(formatDoctorName("Sara Emad")).toBe("Dr. Sara Emad");
    expect(formatDoctorName("Dr. Sara Emad")).toBe("Dr. Sara Emad");
    expect(formatDoctorName("dr Sara Emad")).toBe("Dr. Sara Emad");
    expect(formatDoctorName("Dr. Dr. Sara Emad")).toBe("Dr. Sara Emad");
    expect(formatDoctorName("dr. dr Sara Emad")).toBe("Dr. Sara Emad");
  });

  it("formats first-name labels without double-prefixing", () => {
    expect(formatDoctorFirstName("Sara Emad")).toBe("Dr. Sara");
    expect(formatDoctorFirstName("Dr. Sara Emad")).toBe("Dr. Sara");
  });
});
