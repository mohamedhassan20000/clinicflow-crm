import { describe, expect, it } from "vitest";
import {
  sanitizeProviderError,
  scrubMessagingSecrets,
  scrubSensitiveString,
} from "@/lib/messaging/scrub";

describe("messaging secret scrubbing", () => {
  it("filters credential-shaped keys at any depth", () => {
    const event = {
      message: "send failed",
      extra: {
        appSid: "raw-app-sid",
        webhookSecret: "raw-secret",
        credentials: { anything: "nested" },
        nested: { authorization: "Bearer abc123", safe: "keep-me" },
      },
    };
    const scrubbed = scrubMessagingSecrets(event);
    expect(JSON.stringify(scrubbed)).not.toContain("raw-app-sid");
    expect(JSON.stringify(scrubbed)).not.toContain("raw-secret");
    expect(JSON.stringify(scrubbed)).not.toContain("abc123");
    expect(scrubbed.extra.nested.safe).toBe("keep-me");
    expect(scrubbed.message).toBe("send failed");
  });

  it("filters secret-shaped strings under innocent keys", () => {
    expect(scrubSensitiveString("failed with whsec_c2VjcmV0 attached")).not.toContain(
      "whsec_",
    );
    expect(scrubSensitiveString("key re_1234567890abcdef used")).not.toContain(
      "re_1234567890abcdef",
    );
    expect(scrubSensitiveString("Anthropic rejected sk-ant-api03_supersecretvalue"))
      .not.toContain("sk-ant-api03_supersecretvalue");
    expect(scrubSensitiveString(`envelope \\x${"ab".repeat(30)} leaked`)).not.toContain(
      "ab".repeat(30),
    );
    expect(scrubSensitiveString("HTTP 500 from provider")).toBe(
      "HTTP 500 from provider",
    );
  });

  it("does not mutate the input event", () => {
    const event = { extra: { token: "keep-original" } };
    scrubMessagingSecrets(event);
    expect(event.extra.token).toBe("keep-original");
  });

  it("survives circular references without leaking", () => {
    const event: Record<string, unknown> = { apiKey: "secret-value" };
    event.self = event;
    const scrubbed = scrubMessagingSecrets(event) as Record<string, unknown>;
    expect(scrubbed.apiKey).toBe("[Filtered]");
  });

  it("sanitizes provider errors to short scrubbed strings", () => {
    const error = new Error(
      `Provider rejected Bearer super-secret-token for send: ${"x".repeat(600)}`,
    );
    const sanitized = sanitizeProviderError(error);
    expect(sanitized).not.toContain("super-secret-token");
    expect(sanitized.length).toBeLessThanOrEqual(500);
    expect(sanitizeProviderError(42)).toBe("Unknown provider error");
  });
});
