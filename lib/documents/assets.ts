import "server-only";
import { downloadClinicianSignatureAsset } from "@/lib/supabase/admin";

const MAX_INLINE_LOGO_BYTES = 5 * 1024 * 1024;
const ALLOWED_LOGO_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/svg+xml",
]);

/**
 * Canonical PDFs cannot load remote assets. Clinic logos are therefore fetched
 * only from this project's public clinic-assets bucket and frozen as a data URI
 * in the issue-time snapshot. Invalid or unavailable optional logos degrade to
 * the existing clinic-initial fallback.
 */
export async function inlineClinicLogo(
  logoUrl: string | null,
  clinicId: string,
): Promise<string | null> {
  if (!logoUrl) return null;
  if (logoUrl.startsWith("data:image/")) return logoUrl;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!supabaseUrl) return null;

  let source: URL;
  let trustedOrigin: URL;
  try {
    source = new URL(logoUrl);
    trustedOrigin = new URL(supabaseUrl);
  } catch {
    return null;
  }

  const expectedPrefix =
    `/storage/v1/object/public/clinic-assets/clinics/${clinicId}/`;
  if (
    source.protocol !== "https:"
    || source.origin !== trustedOrigin.origin
    || !source.pathname.startsWith(expectedPrefix)
  ) {
    return null;
  }

  try {
    const response = await fetch(source, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (!contentType || !ALLOWED_LOGO_TYPES.has(contentType)) return null;

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_INLINE_LOGO_BYTES) return null;
    return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Reviewed service-role asset read for clinical issuance. The path comes from
 * the already RLS-resolved responsible physician profile and is constrained to
 * that exact clinic/physician signature directory before storage is accessed.
 */
export async function inlineClinicianSignature(
  signaturePath: string | null,
  clinicId: string,
  physicianId: string,
): Promise<string | null> {
  if (!signaturePath) return null;
  try {
    const { data, error } = await downloadClinicianSignatureAsset({
      clinicId,
      physicianId,
      signaturePath,
    });
    if (error || !data || data.size === 0 || data.size > 2 * 1024 * 1024) return null;
    const mime = data.type.split(";", 1)[0];
    if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(mime)) return null;
    return `data:${mime};base64,${Buffer.from(await data.arrayBuffer()).toString("base64")}`;
  } catch {
    return null;
  }
}
