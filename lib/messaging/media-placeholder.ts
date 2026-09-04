/**
 * P11P — telling a patient's words apart from the worker's stand-in for them.
 *
 * When a media message arrives with no caption there is no text to store, so the
 * worker writes a bracketed marker into `body` instead — `[image]`, `[video]`,
 * `[document]`, `[voice message]` and friends (see the worker's
 * `MEDIA_MARKERS`). That marker exists to give the *conversation list* a preview
 * line, and for that it works.
 *
 * Inside the thread it does not. A marker rendered as a message bubble tells a
 * receptionist that the patient typed the literal characters `[image]`, which
 * they did not, and it sits there looking like content even when the real photo
 * is displayed directly underneath it.
 *
 * So the thread asks this module one question — *is this body the patient's text
 * or the worker's placeholder?* — and renders the attachment instead whenever
 * the answer is "placeholder".
 *
 * ### Why matching text rather than fixing the data
 *
 * The marker is already persisted in `outbound_messages`/`inbound_messages` for
 * every media message a clinic has ever received, historical imports included.
 * Rewriting those rows would be destroying the only record of what the worker
 * observed, to fix something that is purely a presentation decision. The bodies
 * stay exactly as they are; the thread simply stops treating them as prose.
 *
 * ### Why this cannot swallow a real message
 *
 * The match is exact, case-sensitive, and against a closed set — a patient who
 * genuinely types "[image]" and nothing else is the only false positive
 * available, and for them the thread still renders their attachment or the
 * explicit "no preview" line rather than losing the turn. Any surrounding text,
 * including a caption, means the body is the patient's and is shown untouched.
 */

/**
 * Every marker the worker can write as a whole message body.
 *
 * Kept in sync by test rather than by import: the worker is a separate package
 * with its own build, and the application must not take a source dependency on
 * it. `tests/unit/lib/p12-media-placeholder.test.ts` asserts this set still
 * covers the worker's own table, so drift fails CI instead of reaching staff.
 */
export const MEDIA_PLACEHOLDER_BODIES: ReadonlySet<string> = new Set([
  "[image]",
  "[video]",
  "[video note]",
  "[document]",
  "[sticker]",
  "[contact]",
  "[location]",
  "[audio]",
  "[voice message]",
]);

/**
 * True when this body is the worker's stand-in for media rather than something
 * a person wrote.
 *
 * Whitespace is trimmed because the marker is the entire body by construction;
 * anything else around it means a human contributed text.
 */
export function isMediaPlaceholderBody(body: string | null | undefined): boolean {
  if (typeof body !== "string") return false;
  return MEDIA_PLACEHOLDER_BODIES.has(body.trim());
}

/**
 * The marker a caption-less *outbound* media message is stored under.
 *
 * P16. A file staff send from the Inbox carries no text, so `body` and
 * `body_preview` were written empty and every such message read "No message
 * preview" — in the conversation list, where the clinic's own photo or PDF is
 * the newest thing on the thread, and in the bubble itself. Storing the same
 * marker the worker already writes for inbound media makes one rule cover both
 * directions: the thread suppresses it (it is not something a person typed) and
 * renders the attachment, and the list renders it as a localized label.
 *
 * A caption is never replaced. Only a message whose entire text is absent gets
 * a marker, which is exactly the case that had nothing to show.
 */
export function outboundMediaPlaceholderBody(media: {
  kind: "image" | "document" | "audio";
  voiceNote: boolean;
}): string {
  if (media.kind === "image") return "[image]";
  if (media.kind === "document") return "[document]";
  return media.voiceNote ? "[voice message]" : "[audio]";
}

/**
 * The media kind a placeholder body stands for, or null when the body is a
 * person's own words.
 *
 * The Inbox uses this to pick the localized label a conversation-list preview
 * shows — "Photo", "صورة" — instead of either the raw marker or the
 * last-resort "No message preview".
 */
export type MediaPlaceholderKind =
  | "image"
  | "video"
  | "videoNote"
  | "document"
  | "sticker"
  | "contact"
  | "location"
  | "audio"
  | "voiceMessage";

const PLACEHOLDER_KINDS: ReadonlyMap<string, MediaPlaceholderKind> = new Map([
  ["[image]", "image"],
  ["[video]", "video"],
  ["[video note]", "videoNote"],
  ["[document]", "document"],
  ["[sticker]", "sticker"],
  ["[contact]", "contact"],
  ["[location]", "location"],
  ["[audio]", "audio"],
  ["[voice message]", "voiceMessage"],
] as const);

export function mediaPlaceholderKind(
  body: string | null | undefined,
): MediaPlaceholderKind | null {
  if (typeof body !== "string") return null;
  return PLACEHOLDER_KINDS.get(body.trim()) ?? null;
}
