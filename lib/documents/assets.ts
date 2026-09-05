import "server-only";
import { downloadClinicianSignatureAsset } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const MAX_INLINE_LOGO_BYTES = 5 * 1024 * 1024;
const ALLOWED_LOGO_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/svg+xml",
]);

const MAX_PROFILE_IMAGE_BYTES = 6 * 1024 * 1024;
const ALLOWED_PROFILE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type DocumentProfileImageBucket =
  | "patient-assets"
  | "clinic-assets"
  | "avatars";

export type DocumentProfileImageRef = {
  bucket: DocumentProfileImageBucket;
  path: string;
};

export type DocumentProfileImage = {
  imageSrc: string | null;
  imageBackgroundSrc: string | null;
};

function profileImageMime(path: string, blobType: string): string | null {
  const normalized = blobType.split(";", 1)[0]?.trim().toLowerCase();
  if (ALLOWED_PROFILE_IMAGE_TYPES.has(normalized)) return normalized;
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  return null;
}

/** A patient avatar path is already tenant-scoped by the RLS-resolved row. */
export function patientProfileImageRef(
  avatarPath: string | null | undefined,
): DocumentProfileImageRef | null {
  return avatarPath ? { bucket: "patient-assets", path: avatarPath } : null;
}

/**
 * Resolve only the two supported staff-photo storage layouts. Arbitrary remote
 * URLs never enter a canonical document snapshot.
 */
export function staffProfileImageRef(
  avatarUrl: string | null | undefined,
  clinicId: string,
  staffId: string,
): DocumentProfileImageRef | null {
  if (!avatarUrl) return null;
  try {
    const pathname = decodeURIComponent(new URL(avatarUrl).pathname);
    for (const access of ["public", "sign", "authenticated"] as const) {
      const avatarsMarker = `/storage/v1/object/${access}/avatars/`;
      const avatarsIndex = pathname.indexOf(avatarsMarker);
      if (avatarsIndex >= 0) {
        const path = pathname.slice(avatarsIndex + avatarsMarker.length);
        if (path.startsWith(`${staffId}/`)) return { bucket: "avatars", path };
      }

      const clinicMarker = `/storage/v1/object/${access}/clinic-assets/`;
      const clinicIndex = pathname.indexOf(clinicMarker);
      if (clinicIndex >= 0) {
        const path = pathname.slice(clinicIndex + clinicMarker.length);
        if (path.startsWith(`staff/${clinicId}/${staffId}/photo.`)) {
          return { bucket: "clinic-assets", path };
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function downloadProfileImage(
  ref: DocumentProfileImageRef,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.storage.from(ref.bucket).download(ref.path);
  if (error || !data || data.size === 0 || data.size > MAX_PROFILE_IMAGE_BYTES) return null;
  const mime = profileImageMime(ref.path, data.type);
  if (!mime) return null;
  return { bytes: new Uint8Array(await data.arrayBuffer()), mime };
}

/**
 * Shared patient/staff photo pipeline for the two documents that carry a person
 * photo — the patient file and the staff file — across Preview, PDF and
 * reprints. Foregrounds are never cropped; the hero background is a separate
 * blurred cover layer derived from the same trusted image.
 */
export async function inlineDocumentProfileImage(
  ref: DocumentProfileImageRef | null,
): Promise<DocumentProfileImage> {
  if (!ref) return { imageSrc: null, imageBackgroundSrc: null };
  let image: Awaited<ReturnType<typeof downloadProfileImage>>;
  try {
    image = await downloadProfileImage(ref);
  } catch {
    return { imageSrc: null, imageBackgroundSrc: null };
  }
  if (!image) return { imageSrc: null, imageBackgroundSrc: null };

  const imageSrc = `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`;
  try {
    // `sharp` is a native module and is loaded lazily on purpose: every document
    // resolver imports this file for `inlineClinicLogo`, so a sharp load failure
    // must never be able to take the clinic logo down with it.
    const { default: sharp } = await import("sharp");
    const background = await sharp(image.bytes)
      .rotate()
      .resize(72, 72, { fit: "cover", position: "centre" })
      .blur(8)
      .webp({ quality: 78 })
      .toBuffer();
    return {
      imageSrc,
      imageBackgroundSrc: `data:image/webp;base64,${background.toString("base64")}`,
    };
  } catch {
    return { imageSrc, imageBackgroundSrc: imageSrc };
  }
}

/**
 * Resolve a stored clinic-logo URL back to its tenant-scoped `clinic-assets`
 * storage path. Only this project's own storage layouts are accepted, so an
 * arbitrary remote URL can never enter a canonical document snapshot. The
 * access segment is not constrained (`public`/`sign`/`authenticated` all map to
 * the same object) because the bytes are read through the storage client, not
 * through the URL.
 */
function clinicLogoStoragePath(logoUrl: URL, clinicId: string): string | null {
  for (const access of ["public", "sign", "authenticated"] as const) {
    const marker = `/storage/v1/object/${access}/clinic-assets/`;
    const index = logoUrl.pathname.indexOf(marker);
    if (index < 0) continue;
    let path: string;
    try {
      path = decodeURIComponent(logoUrl.pathname.slice(index + marker.length));
    } catch {
      return null;
    }
    if (path.includes("..") || path.includes("\\")) return null;
    return path.startsWith(`clinics/${clinicId}/`) ? path : null;
  }
  return null;
}

function logoMimeType(path: string, blobType: string): string | null {
  const normalized = blobType.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized && ALLOWED_LOGO_TYPES.has(normalized)) return normalized;
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "svg") return "image/svg+xml";
  return null;
}

/**
 * Canonical PDFs cannot load remote assets: the Chromium renderer blocks every
 * non-`data:` request, so a logo that is still an `https:` URL when the page is
 * printed silently disappears. Clinic logos are therefore always read from this
 * project's own `clinic-assets` bucket and frozen as a data URI.
 *
 * The bytes come from the storage client rather than an outbound `fetch` of the
 * public URL, so the logo resolves identically against a remote project and a
 * local `http://127.0.0.1:54321` stack, and does not depend on egress from the
 * rendering runtime. A cross-origin/legacy URL that still points at this
 * clinic's storage prefix keeps working; anything else degrades to the existing
 * clinic-initial fallback.
 */
export async function inlineClinicLogo(
  logoUrl: string | null,
  clinicId: string,
): Promise<string | null> {
  if (!logoUrl) return null;
  if (logoUrl.startsWith("data:image/")) return logoUrl;

  let source: URL;
  try {
    source = new URL(logoUrl);
  } catch {
    return null;
  }

  const path = clinicLogoStoragePath(source, clinicId);
  if (!path) return null;

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.storage
      .from("clinic-assets")
      .download(path);
    if (error || !data || data.size === 0 || data.size > MAX_INLINE_LOGO_BYTES) {
      return null;
    }
    const mime = logoMimeType(path, data.type);
    if (!mime) return null;
    return `data:${mime};base64,${Buffer.from(await data.arrayBuffer()).toString("base64")}`;
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
