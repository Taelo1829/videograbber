// Video Grabber's service worker. It doesn't cache the app or the videos (everything lives on the
// laptop and changes constantly); it only shows a friendly page when the laptop can't be reached.

const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Video Grabber</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111318; color: #e8eaf0;
         font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 24px; box-sizing: border-box; }
  main { max-width: 34ch; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: #9aa1b2; margin: 0 0 18px; }
  button { font: 600 15px inherit; background: #ff5a4a; color: #111318; border: 0; border-radius: 8px; padding: 11px 18px; }
</style></head><body><main>
  <h1>Can't reach the laptop</h1>
  <p>Video Grabber runs on your laptop. Check it's on, awake and running the app, and that this phone is on the same Wi-Fi.</p>
  <button onclick="location.reload()">Try again</button>
</main></body></html>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  // Only page loads; API calls and video streams go straight to the network untouched.
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(() => new Response(OFFLINE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } })),
  );
});
