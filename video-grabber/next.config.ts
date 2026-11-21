import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright ships native binaries; load it from node_modules at runtime instead of bundling it.
  serverExternalPackages: ["playwright", "playwright-core"],
  // Next streams page metadata into <body> for most browsers, but phones only read the app manifest and
  // home-screen tags from <head>. Matching every user agent keeps all metadata in <head>, so the app installs.
  htmlLimitedBots: /.*/,
  // The dev-mode "N" badge sits over the full-screen player's controls on a phone.
  devIndicators: false,
};

export default nextConfig;
