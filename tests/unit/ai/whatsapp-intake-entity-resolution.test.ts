import { describe, expect, it } from "vitest";
import { normalizeEntityText, resolveNamedEntity } from "@/lib/ai/entity-resolution";

const doctors = [
  { id: "1", name: "Dr Mohamed Hassan" },
  { id: "2", name: "Dr Ahmed Ali" },
  { id: "3", name: "Dr Ahmad Aly" },
];

describe("WhatsApp intake entity resolution", () => {
  it.each(["محمد حسن", "Mohamed Hassan", "Mohammad Hasan", "Muhammed Hassn"])(
    "resolves Arabic/transliteration/spelling variants without exact matching: %s",
    (written) => {
      expect(resolveNamedEntity(written, doctors)).toMatchObject({
        status: "resolved",
        entity: { id: "1" },
      });
    },
  );

  it("keeps similar doctor names ambiguous instead of guessing", () => {
    const result = resolveNamedEntity("Ahmd Ali", doctors);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates.map((candidate) => candidate.id)).toEqual(
        expect.arrayContaining(["2", "3"]),
      );
    }
  });

  it.each([
    ["second option", "2"],
    ["first available", "1"],
    ["أول موعد متاح", "1"],
    ["الثاني", "2"],
    ["٣", "3"],
  ])("understands natural and Arabic-digit option selections: %s", (written, id) => {
    expect(resolveNamedEntity(written, doctors)).toMatchObject({
      status: "resolved",
      entity: { id },
    });
  });

  it("maps common Arabic/English department semantics before fuzzy scoring", () => {
    const departments = [
      { id: "cardiology", name: "Cardiology" },
      { id: "dentistry", name: "Dentistry" },
    ];
    expect(resolveNamedEntity("عيادة القلب", departments)).toMatchObject({
      status: "resolved",
      entity: { id: "cardiology" },
    });
    expect(resolveNamedEntity("dentstry", departments)).toMatchObject({
      status: "resolved",
      entity: { id: "dentistry" },
    });
  });

  it("normalizes Arabic and Western digits consistently", () => {
    expect(normalizeEntityText("الخيار ٢")).toContain("2");
    expect(normalizeEntityText("option 2")).toContain("2");
  });
});
