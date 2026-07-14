import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import en from "@/messages/en.json";
import ar from "@/messages/ar.json";
import { clinicFlowErrorMap, translateFieldErrors } from "@/lib/validations/error-map";

const schema = z.object({
  name: z.string().min(2),
  email: z.email(),
  age: z.number().max(120),
});

// Exercise the map the way it is actually consumed — as zod's `customError`. The `input` that
// separates "missing" from "wrong type" is present on the issue handed to the map, and is stripped
// from the issues on a parsed result, so asserting against parsed issues would test a shape that
// production never sees.
z.config({ customError: clinicFlowErrorMap });
afterAll(() => z.config({ customError: undefined }));

/** The message keys the map produced, by field. */
function keysFor(input: unknown): Record<string, string> {
  const result = schema.safeParse(input);
  if (result.success) throw new Error("expected the schema to reject this input");
  return Object.fromEntries(result.error.issues.map((issue) => [String(issue.path[0]), issue.message]));
}

describe("P2A zod message keys (§4.1)", () => {
  it("maps a missing field to `required`", () => {
    expect(keysFor({ email: "a@b.com", age: 1 }).name).toBe("validation.required");
  });

  it("distinguishes a wrong type from a missing value", () => {
    expect(keysFor({ name: 42, email: "a@b.com", age: 1 }).name).toBe("validation.invalidType");
  });

  it("maps bounds and formats to their own keys", () => {
    const keys = keysFor({ name: "a", email: "nope", age: 999 });

    expect(keys.name).toBe("validation.tooSmall");
    expect(keys.email).toBe("validation.invalidEmail");
    expect(keys.age).toBe("validation.tooBig");
  });

  it("emits keys, never English sentences — that is what makes a schema renderable in Arabic", () => {
    for (const message of Object.values(keysFor({ name: "a", email: "nope", age: 999 }))) {
      expect(message).toMatch(/^validation\./);
    }
  });

  it("resolves every key it can emit in both locales", () => {
    const keys = ["required", "invalidType", "tooSmall", "tooBig", "invalidFormat", "invalidEmail", "unrecognizedKeys"];
    for (const key of keys) {
      expect(en.validation).toHaveProperty(key);
      expect(ar.validation).toHaveProperty(key);
      expect((ar.validation as Record<string, string>)[key]).not.toBe("");
      // The Arabic message must actually be Arabic, not an untranslated English string.
      expect((ar.validation as Record<string, string>)[key]).toMatch(/[؀-ۿ]/);
    }
  });
});

describe("P2A translateFieldErrors", () => {
  const t = (key: string) => (en.validation as Record<string, string>)[key] ?? key;

  it("translates message keys through the active locale", () => {
    const output = translateFieldErrors({ name: ["validation.required"] }, t);
    expect(output.name).toEqual(["This field is required."]);
  });

  it("passes literal messages through untouched, so un-migrated schemas keep their copy", () => {
    // This is what lets P2A land the mechanism without rewriting a single existing schema.
    const output = translateFieldErrors({ phone: ["Enter a valid Kuwaiti number."] }, t);
    expect(output.phone).toEqual(["Enter a valid Kuwaiti number."]);
  });

  it("drops undefined entries", () => {
    const output = translateFieldErrors({ name: undefined, email: ["validation.invalidEmail"] }, t);
    expect(output).not.toHaveProperty("name");
    expect(output.email).toEqual(["Enter a valid email address."]);
  });
});
