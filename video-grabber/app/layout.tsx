import type { Metadata, Viewport } from "next";
import { RegisterServiceWorker } from "./register-sw";
import "./globals.css";

export const metadata: Metadata = {
  title: "Video Grabber",
  description: "Paste a link and download the video with yt-dlp.",
  appleWebApp: { capable: true, title: "Grabber", statusBarStyle: "black-translucent" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#14161b",
  // Lets the full-screen player use the whole screen, notch area included.
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
