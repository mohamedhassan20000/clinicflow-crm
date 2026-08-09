import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  cleanedClinicLogoStoragePath,
  ensureClinicLogoCleaned,
  isClinicLogoCleaned,
} from "@/lib/images/clinic-logo-cleanup";
import type { Database } from "@/types/database";

const CLINIC_ID = "clinic-1";
const LEGACY_PATH = `clinics/${CLINIC_ID}/logo.svg`;
const LEGACY_URL =
  `https://project.supabase.co/storage/v1/object/public/clinic-assets/${LEGACY_PATH}?t=old`;

function sourceLogo() {
  return new Blob(
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect x="50" y="30" width="100" height="60" fill="#1264a3" /></svg>',
    ],
    { type: "image/svg+xml" },
  );
}

function createClient(options: { failUpdates?: number } = {}) {
  const objects = new Map<string, Blob>([[LEGACY_PATH, sourceLogo()]]);
  let remainingUpdateFailures = options.failUpdates ?? 0;
  const download = vi.fn(async (path: string) => {
    const data = objects.get(path) ?? null;
    return {
      data,
      error: data ? null : { message: "not found" },
    };
  });
  const upload = vi.fn(
    async (
      path: string,
      bytes: Uint8Array,
      uploadOptions: { contentType: string },
    ) => {
      const body = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      objects.set(path, new Blob([body], { type: uploadOptions.contentType }));
      return { data: { path }, error: null };
    },
  );
  const getPublicUrl = vi.fn((path: string) => ({
    data: {
      publicUrl:
        `https://project.supabase.co/storage/v1/object/public/clinic-assets/${path}`,
    },
  }));
  const update = vi.fn();
  const filters: unknown[][] = [];
  const query = {
    eq: vi.fn((...args: unknown[]) => {
      filters.push(args);
      return query;
    }),
    then: <TResult1 = { error: { message: string } | null }, TResult2 = never>(
      onfulfilled?:
        | ((value: { error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => {
      const error = remainingUpdateFailures > 0
        ? { message: "database unavailable" }
        : null;
      remainingUpdateFailures = Math.max(0, remainingUpdateFailures - 1);
      return Promise.resolve({ error }).then(onfulfilled, onrejected);
    },
  };
  update.mockReturnValue(query);

  const client = {
    storage: {
      from: vi.fn(() => ({ download, upload, getPublicUrl })),
    },
    from: vi.fn(() => ({ update })),
  } as unknown as SupabaseClient<Database>;

  return { client, objects, download, upload, getPublicUrl, update, filters };
}

describe("legacy clinic logo cleanup", () => {
  it("migrates a legacy logo to the versioned clean-once asset", async () => {
    const mocks = createClient();

    const result = await ensureClinicLogoCleaned({
      supabase: mocks.client,
      clinicId: CLINIC_ID,
      logoUrl: LEGACY_URL,
    });

    const cleanPath = cleanedClinicLogoStoragePath(CLINIC_ID);
    expect(result.status).toBe("migrated");
    expect(result.logoUrl).toContain(`/${cleanPath}?cleaned=v1&t=`);
    expect(mocks.download).toHaveBeenNthCalledWith(1, cleanPath);
    expect(mocks.download).toHaveBeenNthCalledWith(2, LEGACY_PATH);
    expect(mocks.upload).toHaveBeenCalledWith(
      cleanPath,
      expect.any(Buffer),
      { upsert: true, contentType: "image/png" },
    );
    expect(mocks.objects.get(cleanPath)?.type).toBe("image/png");
    expect(mocks.filters).toEqual([
      ["id", CLINIC_ID],
      ["logo_url", LEGACY_URL],
    ]);
  });

  it("skips all storage work once the versioned URL is persisted", async () => {
    const mocks = createClient();
    const cleanUrl =
      `https://project.supabase.co/storage/v1/object/public/clinic-assets/${cleanedClinicLogoStoragePath(CLINIC_ID)}?cleaned=v1`;

    expect(isClinicLogoCleaned(cleanUrl, CLINIC_ID)).toBe(true);
    const result = await ensureClinicLogoCleaned({
      supabase: mocks.client,
      clinicId: CLINIC_ID,
      logoUrl: cleanUrl,
    });

    expect(result).toEqual({ status: "already-clean", logoUrl: cleanUrl });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("reuses an already-written clean asset when only URL persistence failed", async () => {
    const mocks = createClient({ failUpdates: 1 });

    const first = await ensureClinicLogoCleaned({
      supabase: mocks.client,
      clinicId: CLINIC_ID,
      logoUrl: LEGACY_URL,
    });
    const second = await ensureClinicLogoCleaned({
      supabase: mocks.client,
      clinicId: CLINIC_ID,
      logoUrl: LEGACY_URL,
    });

    expect(first.status).toBe("failed");
    expect(second.status).toBe("migrated");
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledTimes(3);
    expect(mocks.download.mock.calls.map(([path]) => path)).toEqual([
      cleanedClinicLogoStoragePath(CLINIC_ID),
      LEGACY_PATH,
      cleanedClinicLogoStoragePath(CLINIC_ID),
    ]);
  });

  it("will not read a logo path belonging to another clinic", async () => {
    const mocks = createClient();
    const result = await ensureClinicLogoCleaned({
      supabase: mocks.client,
      clinicId: CLINIC_ID,
      logoUrl:
        "https://project.supabase.co/storage/v1/object/public/clinic-assets/clinics/clinic-2/logo.png",
    });

    expect(result.status).toBe("unsupported-source");
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
