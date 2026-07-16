import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { config } from "@/middleware";

describe("Phase 3 manifest and middleware matcher", () => {
  it("publishes the production web manifest", () => {
    expect(manifest()).toEqual({
      name: "ClinicFlow",
      short_name: "ClinicFlow",
      description:
        "Run appointments, patient records, billing, follow-ups, reports, and clinic operations from one calm, role-aware workspace.",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#f5fbfb",
      theme_color: "#087f7b",
      icons: [
        {
          src: "/brand/icon-192.png",
          sizes: "192x192",
          type: "image/png",
        },
        {
          src: "/brand/icon-512.png",
          sizes: "512x512",
          type: "image/png",
        },
      ],
    });
  });

  it.each([
    "/manifest.webmanifest",
    "/marketing/dashboard-desktop.avif",
    "/assets/browser.ico",
    "/assets/feed.xml",
    "/assets/readme.txt",
  ])("bypasses middleware for the static asset %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
  });

  it.each(["/dashboard", "/api/cron/fx-rates", "/patients"])(
    "keeps the application route %s behind middleware",
    (url) => {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    },
  );
});
