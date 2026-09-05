import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toConfiguredStorageOrigin } from "@/lib/storage/storage-url";

const HOSTED = "https://ayzetxywrqouqpurbjuv.supabase.co";
const LOCAL = "http://127.0.0.1:54321";
const OBJECT_PATH =
  "/storage/v1/object/public/clinic-assets/clinics/caf2711f-97cb-4474-a103-f9505f467087/logo-clean-v1.png";

let original: string | undefined;

beforeEach(() => {
  original = process.env.NEXT_PUBLIC_SUPABASE_URL;
});

afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = original;
});

describe("toConfiguredStorageOrigin", () => {
  it("re-points a URL copied in from another project at the configured one", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL;
    expect(toConfiguredStorageOrigin(`${HOSTED}${OBJECT_PATH}?t=1786237394471`)).toBe(
      `${LOCAL}${OBJECT_PATH}?t=1786237394471`,
    );
  });

  it("is the identity function when the row was written against this project", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = HOSTED;
    const url = `${HOSTED}${OBJECT_PATH}?t=1`;
    expect(toConfiguredStorageOrigin(url)).toBe(url);
  });

  it("preserves the encoded path, query and fragment", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL;
    const encoded =
      "/storage/v1/object/public/clinic-assets/clinics/c1/my%20logo.png";
    expect(toConfiguredStorageOrigin(`${HOSTED}${encoded}?cleaned=v1&t=2#x`)).toBe(
      `${LOCAL}${encoded}?cleaned=v1&t=2#x`,
    );
  });

  it("leaves signed URLs alone — their token belongs to the issuing project", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL;
    const signed = `${HOSTED}/storage/v1/object/sign/clinic-assets/clinics/c1/logo.png?token=abc`;
    expect(toConfiguredStorageOrigin(signed)).toBe(signed);
  });

  it("leaves non-storage and unparseable values alone", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL;
    expect(toConfiguredStorageOrigin("https://cdn.example.com/logo.png")).toBe(
      "https://cdn.example.com/logo.png",
    );
    expect(toConfiguredStorageOrigin("/local/logo.png")).toBe("/local/logo.png");
  });

  it("passes the value through when no Supabase URL is configured", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(toConfiguredStorageOrigin(`${HOSTED}${OBJECT_PATH}`)).toBe(
      `${HOSTED}${OBJECT_PATH}`,
    );
  });

  it("returns null for an absent logo", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL;
    expect(toConfiguredStorageOrigin(null)).toBeNull();
    expect(toConfiguredStorageOrigin(undefined)).toBeNull();
    expect(toConfiguredStorageOrigin("")).toBeNull();
  });
});
