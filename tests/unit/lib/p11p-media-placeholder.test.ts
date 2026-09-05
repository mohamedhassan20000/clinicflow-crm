import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MEDIA_PLACEHOLDER_BODIES,
  isMediaPlaceholderBody,
} from "@/lib/messaging/media-placeholder";

/**
 * P11P — the `[image]` bubble.
 *
 * Historical and live media messages both carry a bracketed marker in `body`,
 * written by the worker when a media message arrives with no caption. It is a
 * conversation-list preview that leaked into the thread, where it reads as
 * though the patient typed the characters `[image]`.
 *
 * The bodies themselves are not rewritten — they are the record of what the
 * worker observed — so the guarantee has to be a rendering one, and this is the
 * predicate the rendering depends on.
 */
describe("P11P — telling the worker's media marker apart from a patient's text", () => {
  it("recognises every marker the worker can write as a whole body", () => {
    for (const marker of MEDIA_PLACEHOLDER_BODIES) {
      expect(isMediaPlaceholderBody(marker)).toBe(true);
    }
  });

  it("tolerates the whitespace a stored body may carry around the marker", () => {
    expect(isMediaPlaceholderBody("  [image]  ")).toBe(true);
    expect(isMediaPlaceholderBody("\n[voice message]\n")).toBe(true);
  });

  it("never swallows a message a person actually wrote", () => {
    // The failure mode that matters most: a caption is the patient's words and
    // must survive, even when it mentions the same word.
    expect(isMediaPlaceholderBody("صورة الأشعة")).toBe(false);
    expect(isMediaPlaceholderBody("[image] من فضلك شوف ده")).toBe(false);
    expect(isMediaPlaceholderBody("here is the [image] you asked for")).toBe(false);
    expect(isMediaPlaceholderBody("image")).toBe(false);
    expect(isMediaPlaceholderBody("[IMAGE]")).toBe(false);
  });

  it("treats an absent body as absent, not as a placeholder", () => {
    expect(isMediaPlaceholderBody(null)).toBe(false);
    expect(isMediaPlaceholderBody(undefined)).toBe(false);
    expect(isMediaPlaceholderBody("")).toBe(false);
  });

  /**
   * The application cannot import from the worker package, so the marker set is
   * duplicated by necessity. This is the test that stops the duplicate from
   * drifting: add a marker to the worker and forget this set, and the Inbox
   * starts showing the new one as text — silently, and only in production.
   */
  it("stays in sync with the marker table the worker actually writes", () => {
    const source = readFileSync("services/whatsapp-worker/src/inbound.ts", "utf8");
    const table = source.match(/const MEDIA_MARKERS[^{]*\{([\s\S]*?)\n\};/);
    expect(table).toBeTruthy();
    const workerMarkers = [...table![1]!.matchAll(/"(\[[^"]+\])"/g)].map((match) => match[1]!);
    expect(workerMarkers.length).toBeGreaterThan(0);
    for (const marker of workerMarkers) {
      expect(
        isMediaPlaceholderBody(marker),
        `worker writes ${marker} but the Inbox would render it as patient text`,
      ).toBe(true);
    }

    // The two audio markers live outside the table, in `messageText`'s ptt
    // branch, so they are asserted against the same source explicitly.
    for (const marker of ["[voice message]", "[audio]"]) {
      expect(source).toContain(`"${marker}"`);
      expect(isMediaPlaceholderBody(marker)).toBe(true);
    }
  });
});
