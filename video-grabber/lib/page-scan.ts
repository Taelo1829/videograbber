/**
 * Fallback for sites yt-dlp doesn't know: fetch the page HTML and pick the most
 * likely video URL from <video> tags, og:video meta tags, embeds and raw text.
 */
const EXT = "mp4|m4v|webm|mov|mkv|m3u8|mpd";
const EXT_RE = new RegExp(`\\.(${EXT})(?=$|[?#])`, "i");
const ABS_RE = new RegExp(`(?:https?:)?//[^\\s"'<>()\\\\]+?\\.(?:${EXT})(?:\\?[^\\s"'<>\\\\]*)?`, "gi");
const REL_RE = new RegExp(`["'](/?[\\w\\-./%~]+?\\.(?:${EXT})(?:\\?[^"'\\s<>\\\\]*)?)["']`, "gi");
const ATTR_RE = /<(?:video|source)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
const META_RE = /<meta\b[^>]*?(?:property|name)\s*=\s*["'](?:og:video(?::secure_url|:url)?|twitter:player:stream)["'][^>]*?content\s*=\s*["']([^"']+)["']/gi;
const META_RE_REV = /<meta\b[^>]*?content\s*=\s*["']([^"']+)["'][^>]*?(?:property|name)\s*=\s*["'](?:og:video(?::secure_url|:url)?|twitter:player:stream)["']/gi;
const IFRAME_RE = /<iframe\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
const EMBED_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|dailymotion\.com|wistia\.(com|net)|vidyard\.com|loom\.com|streamable\.com)$/i;

const MAX_BYTES = 5 * 1024 * 1024;

export interface PageVideo { url: string; title?: string }

export async function findVideoInPage(pageUrl: string): Promise<PageVideo | null> {
  let html: string;
  try {
    const res = await fetch(pageUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    // The link itself is a video file.
    if (/^video\/|mpegurl|dash\+xml/i.test(type)) return { url: res.url };
    html = (await res.text()).slice(0, MAX_BYTES);
    pageUrl = res.url;
  } catch {
    return null;
  }

  const raw = html
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&");

  const candidates: { url: string; score: number }[] = [];
  const add = (u: string | undefined, score: number) => {
    if (!u || u.startsWith("blob:") || u.startsWith("data:")) return;
    try {
      candidates.push({ url: new URL(u.startsWith("//") ? "https:" + u : u, pageUrl).href, score });
    } catch { /* ignore malformed */ }
  };

  for (const m of raw.matchAll(META_RE)) add(m[1], 50);
  for (const m of raw.matchAll(META_RE_REV)) add(m[1], 50);
  for (const m of raw.matchAll(ATTR_RE)) add(m[1], 40);
  for (const m of raw.matchAll(IFRAME_RE)) {
    try { if (EMBED_HOSTS.test(new URL(m[1], pageUrl).hostname)) add(m[1], 45); } catch { /* skip */ }
  }
  for (const m of raw.matchAll(ABS_RE)) add(m[0], 20);
  for (const m of raw.matchAll(REL_RE)) add(m[1], 15);

  const ranked = candidates
    .filter((c) => EXT_RE.test(new URL(c.url).pathname) || EMBED_HOSTS.test(new URL(c.url).hostname))
    .map((c) => {
      const p = new URL(c.url).pathname.toLowerCase();
      // Prefer adaptive master playlists (best quality), then MP4.
      if (p.endsWith(".m3u8")) c.score += /master|index|playlist/.test(p) ? 15 : 10;
      else if (p.endsWith(".mp4")) c.score += 8;
      else if (p.endsWith(".mpd")) c.score += 6;
      return c;
    })
    .sort((a, b) => b.score - a.score);

  if (!ranked[0]) return null;
  const t = raw.match(/<meta\b[^>]*?property\s*=\s*["']og:title["'][^>]*?content\s*=\s*["']([^"']+)["']/i)?.[1]
    ?? raw.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
  return { url: ranked[0].url, title: t?.trim() || undefined };
}
