"use client";

import { useEffect } from "react";

/** Registers the service worker so the app can be installed. Browsers only allow it on https or localhost. */
export function RegisterServiceWorker() {
  useEffect(() => {
    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}
