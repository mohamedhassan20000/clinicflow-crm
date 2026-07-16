import type { MetadataRoute } from "next";
import enMessages from "@/messages/en.json";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ClinicFlow",
    short_name: "ClinicFlow",
    description: enMessages.marketing.seo.description,
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
  };
}
