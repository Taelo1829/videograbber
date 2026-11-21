import type { MetadataRoute } from "next";

/** Makes the app installable ("Add to Home screen"). On a phone it opens full screen on the TikTok tab. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Video Grabber",
    short_name: "Grabber",
    description: "Download videos, and watch your TikToks full screen.",
    start_url: "/",
    scope: "/",
    display: "fullscreen",
    display_override: ["fullscreen", "standalone"],
    orientation: "portrait",
    background_color: "#000000",
    theme_color: "#14161b",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
