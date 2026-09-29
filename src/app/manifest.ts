import type { MetadataRoute } from "next";

// Colors are the v3 mockup light-theme tokens: --page #f9f9f7 (both the app
// chrome tint and the splash background match the page background).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Duit.",
    short_name: "Duit.",
    description: "Personal financial management platform",
    start_url: "/quick",
    display: "standalone",
    theme_color: "#f9f9f7",
    background_color: "#f9f9f7",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
