import type { MetadataRoute } from "next";
import { MARKETING_SITE_URL } from "@/lib/marketing-copy";

export default function robots(): MetadataRoute.Robots {
  if (process.env.VERCEL_ENV === "preview") {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/privacy", "/terms"],
      disallow: [
        "/api/",
        "/auth/",
        "/dashboard",
        "/appointments",
        "/patients",
        "/reports",
        "/revenue",
        "/settings",
        "/operator",
      ],
    },
    sitemap: `${MARKETING_SITE_URL}/sitemap.xml`,
    host: MARKETING_SITE_URL,
  };
}
