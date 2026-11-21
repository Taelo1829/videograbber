/**
 * Layer 3: drive a real (headless) browser for sites that only reveal the video
 * after clicks — a thumbnails gallery, then a "choose a server" step, then a
 * player inside an iframe. We watch every network request the page and its
 * iframes make, and stop as soon as one is a video stream or file.
 *
 * This deliberately does NOT try to get past CAPTCHAs or bot checks: if a site
 * shows one, we stop and say so.
 */
import type { Browser, BrowserContext, Frame, Page } from "playwright";
import { getRecipe } from "./recipes";

const MEDIA_EXT = /\.(m3u8|mpd|mp4|m4v|webm|mov|mkv)(?=$|[?#])/i;
const SEGMENT = /\.(ts|m4s|aac|cmfv|cmfa)(?=$|[?#])|\/seg[-_]?\d|\/chunk[-_]?\d|\/fragment/i;
const MEDIA_TYPE = /^video\/|mpegurl|dash\+xml/i;
const CAPTCHA_FRAME = /recaptcha|hcaptcha\.com|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha/i;
const CAPTCHA_TEXT = /verify (that )?you('| a)re (a )?human|checking your browser|are you a robot|complete the captcha|press (and|&) hold/i;
const PLAY_SELECTORS = [
  ".vjs-big-play-button", ".jw-display-icon-container", ".plyr__control--overlaid", ".play-button", ".btn-play",
  "button[aria-label*='play' i]", "[class*='play-btn' i]", "[class*='playbtn' i]", "#play", ".play", "video",
];
const MAX_SERVERS = 8;

export class CaptchaError extends Error {
  constructor() { super("This site shows a CAPTCHA or bot check, so automatic mode stops here. Open it in your own browser and use the DevTools Network method from the README."); }
}
export class BrowserMissingError extends Error {
  constructor(detail: string) { super(`The headless browser isn't installed. In the project folder run: npx playwright install chromium  (${detail})`); }
}

// ---------- shared browser ----------

const g = globalThis as unknown as { __vgBrowser?: Promise<Browser> };

async function getBrowser(): Promise<Browser> {
  if (!g.__vgBrowser) {
    g.__vgBrowser = (async () => {
      const { chromium } = await import("playwright");
      try {
        const b = await chromium.launch({
          headless: true,
          executablePath: process.env.CHROMIUM_PATH || undefined,
          channel: process.env.BROWSER_CHANNEL || undefined, // e.g. "chrome" to use your installed Chrome
          args: process.env.BROWSER_ARGS?.split(" ").filter(Boolean),
        });
        b.on("disconnected", () => { g.__vgBrowser = undefined; });
        return b;
      } catch (err) {
        g.__vgBrowser = undefined;
        const msg = err instanceof Error ? err.message : String(err);
        if (/Executable doesn't exist|browserType\.launch/i.test(msg)) throw new BrowserMissingError(msg.split("\n")[0]);
        throw err;
      }
    })();
  }
  return g.__vgBrowser;
}

async function newContext(): Promise<BrowserContext> {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-ZA" });
  ctx.setDefaultTimeout(15_000);
  return ctx;
}

/** Close pop-up tabs that ad scripts open when you click anything. */
/** Close pop-up tabs that ad scripts open when you click anything. Call after the main tab exists. */
function closePopups(ctx: BrowserContext, main: Page) {
  ctx.on("page", (p) => { if (p !== main) p.close().catch(() => {}); });
}

async function assertNoCaptcha(page: Page) {
  if (page.frames().some((f) => CAPTCHA_FRAME.test(f.url()))) throw new CaptchaError();
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? "").catch(() => "");
  if (CAPTCHA_TEXT.test(text)) throw new CaptchaError();
}

async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  await assertNoCaptcha(page);
}

// ---------- gallery ----------

export interface GalleryItem { url: string; title: string; thumb?: string }

/**
 * Lists the videos on a thumbnails page. With `want`, keeps scrolling until it has that many
 * videos that `skip` doesn't rule out (ones already downloaded), or the page stops loading more.
 */
export async function scanGallery(
  pageUrl: string,
  opts: { skip?: (url: string) => boolean; want?: number; timeLimitMs?: number } = {},
): Promise<{ title: string; items: GalleryItem[] }> {
  const recipe = getRecipe(pageUrl);
  const pause = recipe.scrollPauseMs ?? 400;
  const ctx = await newContext();
  try {
    const page = await ctx.newPage();
    closePopups(ctx, page);
    await open(page, pageUrl);
    // Script-heavy sites draw the grid well after the page loads.
    if (recipe.thumbnail) await page.waitForSelector(recipe.thumbnail, { timeout: recipe.renderMs ?? 15_000 }).catch(() => {});
    // Lazy-loaded grids: scroll a few screens so thumbnails render. The pointer has to be over the content for the wheel to scroll it.
    await page.mouse.move(640, 500);
    for (let i = 0; i < (recipe.scrolls ?? 4); i++) { await page.mouse.wheel(0, 2000); await page.waitForTimeout(pause); }

    const extract = () => page.evaluate((selector) => {
      const here = location.href.split("#")[0];
      const abs = (h: string) => { try { return new URL(h, location.href).href.split("#")[0]; } catch { return ""; } };
      const imgOf = (a: Element) => {
        const img = a.querySelector("img");
        const src = img?.getAttribute("data-src") || img?.getAttribute("data-lazy-src") || img?.currentSrc || img?.getAttribute("src") || "";
        if (src) return abs(src);
        const bg = getComputedStyle(a).backgroundImage.match(/url\(["']?(.+?)["']?\)/)?.[1]
          ?? (a.querySelector("[style*='background']") as HTMLElement | null)?.style.backgroundImage.match(/url\(["']?(.+?)["']?\)/)?.[1];
        return bg ? abs(bg) : "";
      };
      const titleOf = (a: Element) => {
        const img = a.querySelector("img");
        return (a.getAttribute("title") || img?.getAttribute("alt") || (a as HTMLElement).innerText || a.closest("article,li,.card,.item")?.querySelector("h1,h2,h3,h4,.title")?.textContent || "")
          .replace(/\s+/g, " ").trim().slice(0, 140);
      };

      let anchors: HTMLAnchorElement[];
      if (selector) {
        anchors = [...document.querySelectorAll(selector)].map((el) => (el.tagName === "A" ? el : el.querySelector("a") ?? el.closest("a"))).filter(Boolean) as HTMLAnchorElement[];
      } else {
        // Guess: links that wrap a picture, on this site, grouped by URL shape.
        // The biggest group of look-alike links is almost always the video grid.
        const withPics = [...document.querySelectorAll("a[href]")]
          .filter((a) => !a.closest("nav, header, footer, [role='navigation'], [class*='logo' i]") && imgOf(a)) as HTMLAnchorElement[];
        const shape = (u: string) => {
          try {
            const x = new URL(u);
            const segs = x.pathname.split("/").filter(Boolean);
            // Numbers and @handles vary per video (/@someone/video/123), so they don't count towards the shape.
            return x.host + "/" + segs.slice(0, -1).map((s) => (s.startsWith("@") ? "@*" : s.replace(/\d+/g, "#"))).join("/") + "/*" + (x.search ? "?" : "");
          } catch { return ""; }
        };
        const groups = new Map<string, HTMLAnchorElement[]>();
        for (const a of withPics) {
          const u = abs(a.href);
          if (!u || u === here || new URL(u).host !== location.host) continue;
          const k = shape(u);
          groups.set(k, [...(groups.get(k) ?? []), a]);
        }
        anchors = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
      }

      const seen = new Set<string>();
      const out: { url: string; title: string; thumb?: string }[] = [];
      for (const a of anchors) {
        const url = abs(a.getAttribute("href") || "");
        if (!url || url === here || seen.has(url)) continue;
        seen.add(url);
        out.push({ url, title: titleOf(a) || url.split("/").filter(Boolean).pop() || url, thumb: imgOf(a) || undefined });
      }
      return out.slice(0, 300);
    }, recipe.thumbnail ?? null);

    // Collect across rounds in case the page drops thumbnails that have scrolled far out of view.
    const found = new Map<string, GalleryItem>();
    const collect = async () => {
      const before = found.size;
      for (const it of await extract()) if (!found.has(it.url)) found.set(it.url, it);
      return found.size > before;
    };
    await collect();

    const fresh = () => [...found.values()].filter((i) => !opts.skip?.(i.url)).length;
    const deadline = Date.now() + (opts.timeLimitMs ?? 150_000);
    const enough = () => !opts.want || fresh() >= opts.want || Date.now() > deadline;

    // Scroll for more until enough are new, or `staleLimit` rounds in a row bring nothing.
    const scrollForMore = async (maxRounds: number, staleLimit: number) => {
      let stale = 0;
      for (let round = 0; !enough() && round < maxRounds && stale < staleLimit; round++) {
        await closePopup(page, recipe.dismiss);
        await page.mouse.move(640, 500);
        for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 2000); await page.waitForTimeout(pause); }
        stale = (await collect()) ? 0 : stale + 1;
      }
    };
    await scrollForMore(recipe.maxScrolls ?? 40, 4);

    // Still short: step through the page's categories, each with its own list. Categories can show different
    // videos when visited again, so go round again while a pass still turns up something new.
    if (recipe.sections && !enough()) {
      const sections = await page.locator(recipe.sections).count();
      for (let pass = 0; pass < 3 && !enough(); pass++) {
        const before = fresh();
        for (let i = pass === 0 ? 1 : 0; i < sections && !enough(); i++) {
          await closePopup(page, recipe.dismiss);
          const clicked = await page.locator(recipe.sections).nth(i).click({ timeout: 8_000 }).then(() => true, () => false);
          if (!clicked) continue;
          await page.waitForTimeout(2_500);
          await assertNoCaptcha(page);
          await collect();
          await scrollForMore(pass === 0 ? 4 : 8, 2);
        }
        if (fresh() === before) break; // nothing new anywhere: the page has run out
      }
    }

    return { title: await page.title(), items: [...found.values()].slice(0, 3000) };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Close a pop-up that covers the page (a sign-in prompt), if the recipe names its close button. */
async function closePopup(page: Page, selector?: string) {
  if (!selector) return;
  const btn = page.locator(selector).first();
  if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
    await btn.click({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
}

// ---------- stream capture ----------

export interface Capture { url: string; referer?: string; title?: string; kind: "stream" | "embed" }

interface Hit { url: string; referer?: string; score: number }

export async function captureStream(
  pageUrl: string,
  hooks: { onStep?: (s: string) => void; shouldStop?: () => boolean } = {},
): Promise<Capture | null> {
  const recipe = getRecipe(pageUrl);
  const waitMs = recipe.waitMs ?? 10_000;
  const step = hooks.onStep ?? (() => {});
  const stopped = hooks.shouldStop ?? (() => false);

  const ctx = await newContext();
  let page: Page | undefined;

  const hits: Hit[] = [];
  const record = (url: string, referer: string | undefined, typeHint = "") => {
    if (url.startsWith("blob:") || url.startsWith("data:")) return;
    let path = url;
    try { path = new URL(url).pathname; } catch { return; }
    if (SEGMENT.test(path) || /mp2t|iso\.segment/i.test(typeHint)) return;
    if (!MEDIA_EXT.test(path) && !MEDIA_TYPE.test(typeHint)) return;
    if (hits.some((h) => h.url === url)) return;
    let score = 1;
    if (/\.m3u8/i.test(path) || /mpegurl/i.test(typeHint)) score = /master|index|playlist/i.test(path) ? 10 : 8;
    else if (/\.mpd/i.test(path) || /dash/i.test(typeHint)) score = 6;
    else if (/\.mp4|\.m4v/i.test(path)) score = 5;
    // Skip tiny pre-roll ad clips where we can tell.
    if (/ads?[\/._-]|preroll|vast|doubleclick|googlesyndication/i.test(url)) score -= 4;
    hits.push({ url, referer, score });
  };
  ctx.on("request", (req) => {
    if (req.resourceType() === "media" || MEDIA_EXT.test(req.url())) record(req.url(), req.headers()["referer"] ?? req.frame()?.url());
  });
  ctx.on("response", (res) => {
    const type = res.headers()["content-type"] ?? "";
    if (MEDIA_TYPE.test(type)) record(res.url(), res.request().headers()["referer"] ?? res.frame()?.url(), type);
  });

  const best = () => [...hits].sort((a, b) => b.score - a.score).find((h) => h.score > 0);
  const waitForHit = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !stopped()) {
      if (best()) {
        await page!.waitForTimeout(1200); // let the master playlist arrive if a variant came first
        return true;
      }
      await page!.waitForTimeout(250);
    }
    return !!best();
  };

  try {
    page = await ctx.newPage();
    closePopups(ctx, page);
    step("Opening the video page");
    await open(page, pageUrl);
    const title = (await page.title()).trim() || undefined;
    const done = (h: Hit): Capture => ({ url: h.url, referer: h.referer, title, kind: "stream" });

    // Some pages autoplay straight away.
    await tryPlay(page, recipe.play);
    if (await waitForHit(3_000)) return done(best()!);

    const servers = await markServers(page, recipe.server);
    const embeds = new Set<string>();
    const total = Math.min(servers, MAX_SERVERS);

    for (let i = 0; i < total && !stopped(); i++) {
      step(`Trying server ${i + 1} of ${total}`);
      const btn = page.locator(`[data-vg-server="${i}"]`).first();
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 5_000 }).catch(() => btn.click({ force: true, timeout: 3_000 }).catch(() => {}));
      // An ad pop-under may have stolen the click; the real page is still `page`.
      await page.waitForTimeout(1_500);
      await assertNoCaptcha(page);
      step(`Playing server ${i + 1} of ${total}`);
      await tryPlay(page, recipe.play);
      if (await waitForHit(waitMs)) return done(best()!);
      for (const f of page.frames()) if (f !== page.mainFrame() && isPlayerFrame(f, pageUrl)) embeds.add(f.url());
    }

    if (total === 0) {
      step("Looking for a player");
      await tryPlay(page, recipe.play);
      if (await waitForHit(waitMs)) return done(best()!);
      for (const f of page.frames()) if (f !== page.mainFrame() && isPlayerFrame(f, pageUrl)) embeds.add(f.url());
    }

    // No stream seen, but a third-party player iframe loaded — yt-dlp may know that host.
    const embed = [...embeds][0];
    return embed ? { url: embed, referer: pageUrl, title, kind: "embed" } : null;
  } finally {
    await ctx.close().catch(() => {});
  }
}

function isPlayerFrame(f: Frame, pageUrl: string) {
  try {
    const u = new URL(f.url());
    if (!/^https?:/.test(u.protocol)) return false;
    if (/ads?\.|doubleclick|googlesyndication|facebook\.com\/plugins|disqus|recaptcha/i.test(u.host)) return false;
    return u.host !== new URL(pageUrl).host || /embed|player|watch|video/i.test(u.pathname);
  } catch { return false; }
}

/** Find server/mirror buttons and tag them data-vg-server=0..n. Returns how many. */
async function markServers(page: Page, selector?: string): Promise<number> {
  return page.evaluate(({ selector, max }) => {
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    let els: Element[];
    if (selector) {
      els = [...document.querySelectorAll(selector)];
    } else {
      const WORDS = /\b(server|mirror|source|player|stream|host|link|hd|sd|\d{3,4}p|option)\s*\d*\b/i;
      const DATA = ["data-server", "data-embed", "data-link", "data-video", "data-src", "data-url", "data-id"];
      const pool = [...document.querySelectorAll("button, a, li, span, div[role='button'], [onclick], " + DATA.map((d) => `[${d}]`).join(","))];
      els = pool.filter((el) => {
        if (!visible(el) || el.closest("nav, header, footer")) return false;
        const text = ((el as HTMLElement).innerText || "").trim();
        if (text.length > 40) return false;
        const hasData = DATA.slice(0, 5).some((d) => el.hasAttribute(d));
        const inList = !!el.closest("[class*='server' i], [id*='server' i], [class*='mirror' i], [class*='source' i]");
        return hasData || WORDS.test(text) || (inList && text.length > 0);
      });
      // Keep the innermost element of each nested group (click the button, not its wrapper).
      els = els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
    }
    els = els.filter(visible).slice(0, max);
    els.forEach((el, i) => el.setAttribute("data-vg-server", String(i)));
    return els.length;
  }, { selector: selector ?? null, max: MAX_SERVERS });
}

/** Press play in the page and in every iframe (players usually live in one). */
async function tryPlay(page: Page, selector?: string) {
  const selectors = selector ? [selector, ...PLAY_SELECTORS] : PLAY_SELECTORS;
  for (const frame of page.frames()) {
    for (const sel of selectors) {
      const el = frame.locator(sel).first();
      if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
        await el.click({ timeout: 2_000 }).catch(() => {});
        break;
      }
    }
    await frame.evaluate(() => {
      document.querySelectorAll("video").forEach((v) => { v.muted = true; v.play().catch(() => {}); });
    }).catch(() => {});
  }
}
