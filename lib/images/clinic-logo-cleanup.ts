import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { cleanClinicLogo } from "@/lib/images/clean-clinic-logo";

const CLINIC_ASSETS_BUCKET = "clinic-assets";
const MAX_LEGACY_LOGO_BYTES = 5 * 1024 * 1024;
const CLEANED_LOGO_FILENAME = "logo-clean-v1.png";

type ClinicClient = SupabaseClient<Database>;

export type ClinicLogoCleanupStatus =
  | "no-logo"
  | "already-clean"
  | "unsupported-source"
  | "migrated"
  | "failed";

export interface ClinicLogoCleanupResult {
  status: ClinicLogoCleanupStatus;
  logoUrl: string | null;
}

export function cleanedClinicLogoStoragePath(clinicId: string) {
  return `clinics/${clinicId}/${CLEANED_LOGO_FILENAME}`;
}

function clinicLogoStoragePathFromUrl(
  logoUrl: string,
  clinicId: string,
): string | null {
  let source: URL;
  try {
    source = new URL(logoUrl);
  } catch {
    return null;
  }

  const prefixes = [
    "/storage/v1/object/public/clinic-assets/",
    "/storage/v1/object/sign/clinic-assets/",
  ];
  const prefix = prefixes.find((candidate) =>
    source.pathname.startsWith(candidate),
  );
  if (!prefix) return null;

  let storagePath: string;
  try {
    storagePath = decodeURIComponent(source.pathname.slice(prefix.length));
  } catch {
    return null;
  }

  const clinicPrefix = `clinics/${clinicId}/`;
  if (
    !storagePath.startsWith(clinicPrefix) ||
    storagePath.includes("..") ||
    storagePath.includes("\\")
  ) {
    return null;
  }

  return storagePath;
}

export function isClinicLogoCleaned(
  logoUrl: string | null,
  clinicId: string,
) {
  if (!logoUrl) return false;
  return (
    clinicLogoStoragePathFromUrl(logoUrl, clinicId) ===
    cleanedClinicLogoStoragePath(clinicId)
  );
}

function publicCleanedLogoUrl(
  supabase: ClinicClient,
  clinicId: string,
) {
  const path = cleanedClinicLogoStoragePath(clinicId);
  const { data } = supabase.storage
    .from(CLINIC_ASSETS_BUCKET)
    .getPublicUrl(path);
  return `${data.publicUrl}?cleaned=v1&t=${Date.now()}`;
}

/**
 * Migrates a legacy clinic logo at most once. The versioned storage path is the
 * durable marker, so future loads skip decoding entirely. If the cleaned asset
 * was written but the database update failed, the next attempt only repairs the
 * URL and does not process the source pixels again.
 */
export async function ensureClinicLogoCleaned(input: {
  supabase: ClinicClient;
  clinicId: string;
  logoUrl: string | null;
}): Promise<ClinicLogoCleanupResult> {
  const { supabase, clinicId, logoUrl } = input;
  if (!logoUrl) return { status: "no-logo", logoUrl: null };
  if (isClinicLogoCleaned(logoUrl, clinicId)) {
    return { status: "already-clean", logoUrl };
  }

  const legacyPath = clinicLogoStoragePathFromUrl(logoUrl, clinicId);
  if (!legacyPath) return { status: "unsupported-source", logoUrl };

  try {
    const storage = supabase.storage.from(CLINIC_ASSETS_BUCKET);
    const cleanPath = cleanedClinicLogoStoragePath(clinicId);
    const existingCleaned = await storage.download(cleanPath);

    if (!existingCleaned.data || existingCleaned.data.size === 0) {
      const original = await storage.download(legacyPath);
      if (
        original.error ||
        !original.data ||
        original.data.size === 0 ||
        original.data.size > MAX_LEGACY_LOGO_BYTES
      ) {
        return { status: "failed", logoUrl };
      }

      const cleaned = await cleanClinicLogo(
        new Uint8Array(await original.data.arrayBuffer()),
      );
      const { error: uploadError } = await storage.upload(
        cleanPath,
        cleaned.bytes,
        { upsert: true, contentType: "image/png" },
      );
      if (uploadError) return { status: "failed", logoUrl };
    }

    const cleanedUrl = publicCleanedLogoUrl(supabase, clinicId);
    const { error: updateError } = await supabase
      .from("clinics")
      .update({ logo_url: cleanedUrl })
      .eq("id", clinicId)
      .eq("logo_url", logoUrl);

    if (updateError) return { status: "failed", logoUrl };
    return { status: "migrated", logoUrl: cleanedUrl };
  } catch {
    return { status: "failed", logoUrl };
  }
}
