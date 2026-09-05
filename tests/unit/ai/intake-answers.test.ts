import { describe, expect, it } from "vitest";
import {
  buildBloodTypeQuestion,
  buildNameConfirmationQuestion,
  isBloodTypeDeclined,
  readLatinSpelling,
  readNameConfirmation,
} from "@/lib/ai/intake-answers";
import { proposeLatinName } from "@/lib/ai/name-transliteration";

describe("Arabic name → proposed English spelling", () => {
  it("proposes a Latin spelling for a simple Arabic name", () => {
    const proposal = proposeLatinName("أحمد علي");
    expect(proposal?.alreadyLatin).toBe(false);
    expect(proposal?.proposed).toMatch(/^[A-Za-z' -]+$/);
    expect(proposal?.original).toBe("أحمد علي");
  });

  it("proposes a Latin spelling for a difficult multi-part Arabic name", () => {
    const proposal = proposeLatinName("أنس طلال عبدالمقصود علي");
    expect(proposal).not.toBeNull();
    expect(proposal!.alreadyLatin).toBe(false);
    expect(proposal!.proposed.split(" ").length).toBeGreaterThanOrEqual(3);
    // The spelling is a proposal, never silently authoritative.
    expect(proposal!.needsConfirmation).toBe(true);
    expect(proposal!.original).toBe("أنس طلال عبدالمقصود علي");
  });

  it("leaves a Latin name alone apart from casing", () => {
    const proposal = proposeLatinName("anas TALAL ali");
    expect(proposal?.alreadyLatin).toBe(true);
    expect(proposal?.proposed).toBe("Anas Talal Ali");
  });

  it("shows the exact proposed spelling in the question it asks", () => {
    const question = buildNameConfirmationQuestion("ar", "Anas Talal Abdulmaqsoud Ali");
    expect(question).toContain("Anas Talal Abdulmaqsoud Ali");
    expect(question).toMatch(/[؀-ۿ]/);
    expect(buildNameConfirmationQuestion("en", "Anas Talal Ali")).toContain(
      "Anas Talal Ali",
    );
  });
});

describe("reading the patient's answer to the spelling question", () => {
  const proposed = "Anas Talal Abdulmaqsoud Ali";

  it.each(["نعم", "تمام", "صح", "أيوه", "correct", "yes", "ok"])(
    "treats %s as confirming the proposal exactly",
    (answer) => {
      expect(readNameConfirmation(answer, proposed)).toEqual({ status: "confirmed" });
    },
  );

  it("takes the patient's own Latin spelling as authoritative", () => {
    expect(readNameConfirmation("خليه Anas Talal Abdel Maksoud Ali", proposed)).toEqual({
      status: "corrected",
      name: "Anas Talal Abdel Maksoud Ali",
    });
  });

  it("reads a correction even when it is wrapped in an agreement", () => {
    const reading = readNameConfirmation("تمام بس خليه Anas Talal Ali", proposed);
    expect(reading).toEqual({ status: "corrected", name: "Anas Talal Ali" });
  });

  it("treats the same spelling written back as agreement, not a correction", () => {
    expect(readNameConfirmation(proposed, proposed)).toEqual({ status: "confirmed" });
  });

  it("asks again when the patient says no with nothing to replace it", () => {
    expect(readNameConfirmation("لا", proposed)).toEqual({ status: "rejected" });
  });

  it("does not read an unrelated message as an answer", () => {
    expect(readNameConfirmation("عايز أعرف مواعيد العيادة", proposed).status).toBe(
      "unclear",
    );
  });

  it("never reads an Arabic re-spelling as a Latin correction", () => {
    expect(readLatinSpelling("خليه أنس طلال")).toBeNull();
  });
});

describe("blood type is optional and declining it is an answer", () => {
  it("asks in a way that says declining is allowed", () => {
    expect(buildBloodTypeQuestion("ar")).toContain("فصيلة الدم");
    expect(buildBloodTypeQuestion("ar")).toContain("لا أعرف");
  });

  it.each(["لا أعرف", "مش عارف", "معرفش", "unknown", "skip", "I don't know"])(
    "treats %s as a decline",
    (answer) => {
      expect(isBloodTypeDeclined(answer)).toBe(true);
    },
  );

  it("does not treat a real blood type or an unreadable value as a decline", () => {
    expect(isBloodTypeDeclined("O+")).toBe(false);
    expect(isBloodTypeDeclined("زائد")).toBe(false);
  });
});
