# Video Grabber

Paste a link, and the video downloads. It's built with Next.js and TypeScript, and yt-dlp does the heavy lifting.

## How it works

1. **yt-dlp first.** The server runs `yt-dlp` on the link. That covers YouTube, Vimeo, X, TikTok and over a thousand other sites.
2. **Page scan fallback.** If yt-dlp says the site is unsupported, the server fetches the page HTML and looks for a video: `og:video` meta tags, `<video>`/`<source>` tags, YouTube/Vimeo embeds, and `.mp4`/`.m3u8`/`.mpd` URLs in the page text. It hands the best match back to yt-dlp, with the page as the Referer.
3. **Headless browser.** If neither of those works, the server opens the page in headless Chromium (Playwright). It clicks each "Server 1 / Server 2 / Mirror" button in turn, presses play inside the player iframe, and watches the network for an `.m3u8`, `.mpd` or `.mp4` request. Ad pop-up tabs are closed automatically. The first stream it sees goes to yt-dlp with the right Referer. If the site shows a CAPTCHA or bot check, it stops.
4. **Jobs and progress.** Each download is a job. The UI polls `/api/jobs` every second for progress, speed and time left.
5. **Saving.** Finished files go in `./downloads`. If "Save to my browser's downloads" is ticked, your browser also downloads the file automatically when the job finishes.

```
app/
  page.tsx                    UI: link box + live job list
  api/jobs/route.ts           GET list · POST { url } or { items: [...] } to start
  api/gallery/route.ts        POST { url } → videos on a thumbnails page
  api/jobs/[id]/route.ts      GET status · POST cancel · DELETE remove
  api/jobs/[id]/file/route.ts streams the finished file
lib/
  jobs.ts                     job queue, spawns yt-dlp, parses progress
  page-scan.ts                fallback HTML scanner
  browser.ts                  headless browser: gallery scan + server-click capture
  recipes.ts                  per-site selectors from recipes.json
```

## On your phone (installable app)

Open the app from a phone on the same Wi-Fi as the laptop, at the laptop's address (the "Network:" line `npm run dev` prints, e.g. `http://10.219.38.5:3000`). On a phone it opens straight into the TikToks, full screen: ↑/↓ on the right, sound top right, **☰** top left for the rest of the app, and **▶ Watch full screen** to go back in.

It's also an installable app (PWA): the Chrome menu gets **Install app** / **Add to Home screen**, and the installed app opens full screen without the browser bar. Browsers only allow installing apps from `https` (or `localhost`), so from the laptop's plain `http` Wi-Fi address you first have to tell Chrome on the phone to trust it: open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, enter the address (e.g. `http://10.219.38.5:3000`), set it to **Enabled** and relaunch Chrome. The address changes when the laptop joins another network, so update it then. (Tailscale's `tailscale serve` is the other way: it gives the laptop a real https address.)

## TikTok tab

Anything downloaded from tiktok.com goes to the **TikTok** tab instead of the Downloads list (and isn't sent to your browser's downloads). There you watch them one at a time in a 9:16 frame, unwatched videos first in random order: ↑/↓ (or the arrow keys) on a laptop, swiping up and down on a phone, where a 💬 button on the right opens the comments. **Share** (on the right on a phone, under the caption on a laptop) shares the video's original TikTok link with the phone's share sheet, or copies it where there's no share sheet, such as over the laptop's plain-http Wi-Fi address. **👎 Not for me** removes a video for good: it leaves the feed at once (with a few seconds to **Undo**), its file is deleted within about a minute, and it's never downloaded again. Sound is on (a phone may need one tap first: the corner button says **Tap for sound**). A video counts as watched as soon as it's been on screen, and is deleted an hour later (`TIKTOK_KEEP_MINUTES`). The app keeps a record of every TikTok it has downloaded, by video ID, so the same video is never downloaded twice, even after it's been deleted.

Opening the tab scans https://www.tiktok.com/explore for videos you haven't downloaded yet. Signed out, explore only shows about 50 videos, so when those are all old the scan steps through explore's categories (Comedy, Sports, Food…) until it has as many new ones as **TikTok: find … new videos per search** in the settings panel asks for (30 to start with, up to 500); it closes TikTok's sign-in pop-up on the way, but stops if TikTok shows a CAPTCHA. TikToks download as H.264, which every browser can play. **Refresh & download all** does the same search on the server and queues every new video it finds, so you don't have to wait for the list and pick; you can close the page while it runs. The data cap and download times still apply to what it queues.

Each video shows its creator and likes, and a comments button. Comments need you to be signed in to TikTok. The easiest way is to reuse the sign-in from your normal browser: open tiktok.com there while signed in, export its cookies with a cookies extension (for example "Get cookies.txt LOCALLY", which saves a cookies.txt, or "Cookie-Editor", which exports JSON; both formats work), and press **Upload cookies file** in the TikTok tab. Only tiktok.com cookies are kept. Delete the exported file afterwards: it is your TikTok session. **Sign out** in the same bar clears them again.

Alternatively, **sign in in a new window** opens a browser window on this computer at TikTok's sign-in page. Sign in there yourself (if TikTok shows a CAPTCHA, you solve it, as anywhere; text-message codes are rate-limited, so the QR code is the surer way); the window closes by itself once you're in. The sign-in window is your installed Chrome (TikTok is pickier with the bundled browser; set `TIKTOK_BROWSER_CHANNEL=chromium` to use that instead, or `msedge` for Edge). The sign-in is kept in the app's own browser profile, `.tiktok-profile/` (set `TIKTOK_PROFILE_DIR` to move it). It holds your TikTok session, so keep it private; it's in `.gitignore`.

After that, each TikTok download also opens its page in the background with your session and saves up to 50 comments the page loads, in `downloads/.comments/`. They're deleted with the video. If TikTok shows a CAPTCHA to that background browser, the app skips the comments for that video rather than trying to get past it. You solve it yourself: when a download's comments hit a CAPTCHA, a Chrome window with it opens by itself (one at a time; if you leave one unsolved, no more open by themselves for half an hour), and **Solve it in a window** in the comments panel does the same on demand; once you've solved the puzzle and the comments load, they're saved, the window closes, and the app retries the other videos that were skipped for a CAPTCHA.

## Thumbnail pages: Find videos

Paste the link to a page full of thumbnails and press **Find videos**. The app lists every video it finds, with thumbnails, so you can tick the ones you want and press **Download selected**. Each one becomes its own job and goes through all three layers, including the server clicking.

## Setup

You need **Node 20+**, **yt-dlp** and **ffmpeg**. ffmpeg joins HLS chunks and merges YouTube's separate video and audio streams.

**Windows**
```powershell
winget install yt-dlp.yt-dlp Gyan.FFmpeg
```
**macOS**
```bash
brew install yt-dlp ffmpeg
```
**Linux**
```bash
pipx install yt-dlp && sudo apt install ffmpeg
```

Close and reopen your terminal so the new PATH is picked up, then:

```bash
npm install
npx playwright install chromium
npm run dev
```

The second command downloads the headless browser (about 150 MB, once). To use your installed Chrome instead, skip it and set `BROWSER_CHANNEL=chrome`.

Open http://localhost:3000 and paste a link.

## Settings (optional)

Create `.env.local`:

```
DOWNLOAD_DIR=downloads      # where files are saved
MAX_CONCURRENT=2            # downloads running at once; the rest queue
MAX_FILESIZE=4G             # yt-dlp skips anything bigger
YTDLP_PATH=yt-dlp           # full path if it isn't on your PATH
FFMPEG_PATH=                # ffmpeg folder or binary, if it isn't on your PATH
TIKTOK_KEEP_MINUTES=60      # how long a watched TikTok stays before it's deleted
BROWSER_CHANNEL=chrome      # use installed Chrome instead of Playwright's Chromium
CHROMIUM_PATH=              # or point at any Chromium binary
```

## Site recipes

The browser layer guesses which links are thumbnails and which buttons are servers. When it guesses wrong on a site, copy `recipes.example.json` to `recipes.json` and add an entry for that site (hostname without `www.`):

```json
{
  "example-videos.co.za": {
    "thumbnail": ".video-grid a.card",
    "server": ".server-list button",
    "play": ".vjs-big-play-button",
    "waitMs": 12000
  }
}
```

Find the selectors by right-clicking a thumbnail or server button and choosing Inspect. Changes apply on the next job, with no restart needed.

For pages whose grid draws late or keeps loading as you scroll, three more fields help **Find videos**: `renderMs` (how long to wait for the first `thumbnail` to appear, default 15000), `scrolls` (screens to scroll, default 4) and `scrollPauseMs` (pause after each scroll, default 400).

TikTok works out of the box: explore, profile, tag and search pages (for example https://www.tiktok.com/explore) list their videos under **Find videos**. Its built-in recipe lives in `lib/recipes.ts`; a `tiktok.com` entry in `recipes.json` overrides it.

## Troubleshooting

- **"yt-dlp isn't installed"**: run `yt-dlp --version` in a fresh terminal. If that fails, set `YTDLP_PATH`.
- **A site that used to work stops working**: sites change all the time, so update yt-dlp with `yt-dlp -U` (or `winget upgrade yt-dlp.yt-dlp`).
- **"needs you to be signed in"**: add `"--cookies-from-browser", "chrome"` to the `args` array in `lib/jobs.ts`. Only do this for your own accounts.
- **"no video stream showed up"**: the browser layer couldn't find the right buttons. Add a recipe (above). As a fallback, open DevTools → Network, play the video, copy the `.m3u8` or `.mp4` request URL, and paste that in.
- **"headless browser isn't installed"**: run `npx playwright install chromium`.
- **CAPTCHA or bot check**: the app stops by design. Download that one manually from your own browser.

## Hosting it

Don't deploy this to Vercel or another serverless host. Downloads take minutes, need the yt-dlp and ffmpeg binaries, and need disk space. Run it locally, or on a small VPS or Docker host. If other people will use it, add a login and a domain allowlist before exposing it.

Only download videos you have the rights to. DRM-protected streams can't be downloaded and aren't attempted.
