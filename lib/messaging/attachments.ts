import "server-only";
import * as Sentry from "@sentry/nextjs";
import {
  downloadWhatsAppAttachment,
  signWhatsAppAttachmentUrls,
} from "@/lib/supabase/admin";

/**
 * P8 — reaching the bytes a patient sent.
 *
 * The `whatsapp-inbound` bucket is private and, unlike the clinical buckets, has
 * no `authenticated` storage policy at all. That is deliberate: there is no
 * client-side path to it, so the only way anything is read is through this
 * module, which mints a short-lived signed URL for a path it has already checked
 * belongs to the calling clinic.
 *
 * Two checks, not one. The caller has proved the viewer's clinic through RLS on
 * `inbound_message_attachments` (the row would not have been read otherwise), and
 * the prefix check below refuses to sign anything outside `<clinicId>/` even if a
 * row somehow named a foreign path. A signed URL is a bearer token for a file:
 * one bad row must not be enough to mint one.
 */

/**
 * How long a signed link stays valid.
 *
 * Sized to a working session rather than to a click. These URLs are minted
 * during the *server render* of `/inbox`, which is a page staff keep open all
 * day; at five minutes every `<img>` in the thread started 404-ing and every
 * download link died a few minutes after load, with no expiry handling in the UI
 * to explain it. A `router.refresh()` re-mints them, but nothing guarantees one
 * fires. One hour bounds the bearer token to something a stolen URL cannot
 * usefully outlive while covering the way the page is actually used.
 */
const SIGNED_URL_TTL_SECONDS = 3_600;

/**
 * Signs a batch of storage paths for one clinic.
 *
 * Returns a map from path to URL, omitting anything that could not be signed —
 * a missing object, a storage outage, or a path that is not this clinic's. The
 * caller renders the attachment without a link rather than failing the page: a
 * file that cannot be fetched is still a fact staff should see.
 */
export async function createSignedAttachmentUrls(
  clinicId: string,
  paths: ReadonlyArray<string | null>,
): Promise<Map<string, string>> {
  const signed = new Map<string, string>();
  const prefix = `${clinicId}/`;
  const wanted = [
    ...new Set(
      paths.filter(
        (path): path is string =>
          typeof path === "string" && path.startsWith(prefix) && !path.includes(".."),
      ),
    ),
  ];
  if (wanted.length === 0) return signed;

  const result = await signWhatsAppAttachmentUrls({
    clinicId,
    paths: wanted,
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
  });
  if (result.error) {
    Sentry.captureException(result.error, { tags: { scope: "inbox-attachments" } });
    return signed;
  }
  for (const entry of result.data ?? []) {
    if (entry.error || !entry.signedUrl || !entry.path) continue;
    signed.set(entry.path, entry.signedUrl);
  }
  return signed;
}

/**
 * Reads one attachment's bytes for server-side inspection (the patient agent's
 * image/document reading).
 *
 * Deliberately separate from the signing path above: the agent never receives a
 * URL it could pass on, follow, or leak into a model's output — it gets the bytes
 * once, in memory, for the one turn that asked for them. `maxBytes` bounds what a
 * caller can pull into a prompt.
 */
export async function readAttachmentBytes(input: {
  clinicId: string;
  storagePath: string;
  maxBytes: number;
}): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (!input.storagePath.startsWith(`${input.clinicId}/`) || input.storagePath.includes("..")) {
    return null;
  }
  const result = await downloadWhatsAppAttachment({
    clinicId: input.clinicId,
    storagePath: input.storagePath,
  });
  if (result.error || !result.data) return null;
  const buffer = Buffer.from(await result.data.arrayBuffer());
  if (buffer.length === 0 || buffer.length > input.maxBytes) return null;
  return { bytes: buffer, mimeType: result.data.type || "application/octet-stream" };
}
