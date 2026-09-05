import { describe, expect, it } from "vitest";
import ar from "@/messages/ar.json";
import en from "@/messages/en.json";

/**
 * P11P — the words staff read, in both languages.
 *
 * The component tests run against a suite-wide English pin, so this is where
 * the Arabic half of this feature is actually asserted. It matters more than
 * usual here: the whole point of the change is that a receptionist stops seeing
 * `[image]` and starts seeing a sentence, and a sentence that exists only in
 * English would leave an Arabic clinic exactly where it started.
 */
describe("P11P — inbox copy exists and says the right thing in both languages", () => {
  const attachmentKeys = [
    "historicalImage",
    "historicalVideo",
    "historicalAudio",
    "historicalDocument",
    "historicalUnavailable",
    "videoLabel",
  ] as const;

  const badgeKeys = [
    "aiHandling",
    "done",
    "needsReview",
    "newContact",
    "humanHandling",
    "waitingPatient",
    "problem",
  ] as const;

  it("defines every new attachment string in English and Arabic", () => {
    for (const key of attachmentKeys) {
      expect(en.inbox.attachments[key], `en.${key}`).toBeTruthy();
      expect(ar.inbox.attachments[key], `ar.${key}`).toBeTruthy();
    }
  });

  it("defines every badge label in English and Arabic", () => {
    for (const key of badgeKeys) {
      expect(en.inbox.statusBadge[key], `en.${key}`).toBeTruthy();
      expect(ar.inbox.statusBadge[key], `ar.${key}`).toBeTruthy();
    }
  });

  it("uses the agreed Arabic wording for an unrecoverable old image", () => {
    expect(ar.inbox.attachments.historicalImage).toBe("صورة قديمة غير متاحة");
  });

  const arabicScript = /[؀-ۿ]/;

  it("writes the Arabic strings in Arabic, not as untranslated English", () => {
    for (const key of attachmentKeys) {
      expect(arabicScript.test(ar.inbox.attachments[key]), `ar.${key}`).toBe(true);
    }
    for (const key of badgeKeys) {
      expect(arabicScript.test(ar.inbox.statusBadge[key]), `ar.${key}`).toBe(true);
    }
  });

  /**
   * P12 raised this from two words to three.
   *
   * Two was not a layout limit, it was a habit; "Needs review" and "محتاج
   * مراجعة" both left out the word that carries the meaning — that the review
   * is a *person's*, not the assistant's re-reading its own work. Three fits
   * the chip beside a truncating name and buys the distinction. It is still a
   * hard cap: the full sentence belongs in `statusBadgeDescription`, which is
   * where the states that need one keep theirs.
   */
  it("keeps every badge label to the three words the badge can show", () => {
    for (const key of badgeKeys) {
      expect(en.inbox.statusBadge[key].trim().split(/\s+/).length, `en.${key}`)
        .toBeLessThanOrEqual(3);
      expect(ar.inbox.statusBadge[key].trim().split(/\s+/).length, `ar.${key}`)
        .toBeLessThanOrEqual(3);
    }
  });

  /**
   * P11T — the badge is two words; the state it names is not. The description
   * is where the full product wording lives (title + aria-label), so a state
   * that is legible at a glance is also unambiguous to anyone who hovers or
   * uses a screen reader. A missing one silently degrades the badge to a label
   * with no explanation, which is how "تمت" and "بانتظار المريض" start looking
   * like the same kind of thing.
   */
  it("defines a full description for every badge state in both languages", () => {
    for (const key of badgeKeys) {
      expect(en.inbox.statusBadgeDescription[key], `en.${key}`).toBeTruthy();
      expect(ar.inbox.statusBadgeDescription[key], `ar.${key}`).toBeTruthy();
      expect(arabicScript.test(ar.inbox.statusBadgeDescription[key]), `ar.${key}`).toBe(true);
      // The description exists to say more than the badge already does.
      expect(
        en.inbox.statusBadgeDescription[key].length,
        `en.${key} should be more than a restatement of the label`,
      ).toBeGreaterThan(en.inbox.statusBadge[key].length);
    }
  });

  /**
   * The old video copy said videos are never stored. That stopped being true
   * when the worker started storing them, and stale copy on a permanent-sounding
   * refusal is how staff learn to distrust the rest of these sentences.
   */
  it("no longer claims videos are never stored", () => {
    expect(en.inbox.attachments.kindNotStored).not.toMatch(/Videos are not stored/i);
    expect(en.inbox.attachments.kindNotStored).toMatch(/video/i);
  });
});
