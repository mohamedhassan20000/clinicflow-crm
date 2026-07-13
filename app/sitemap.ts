import type { MetadataRoute } from "next";
import { MARKETING_SITE_URL } from "@/lib/marketing-copy";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date("2026-07-13T00:00:00.000Z");

  return [
    { url: MARKETING_SITE_URL, lastModified, changeFrequency: "weekly", priority: 1 },
    { url: `${MARKETING_SITE_URL}/privacy`, lastModified, changeFrequency: "monthly", priority: 0.4 },
    { url: `${MARKETING_SITE_URL}/terms`, lastModified, changeFrequency: "monthly", priority: 0.4 },
  ];
}
