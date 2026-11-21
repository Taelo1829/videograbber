/**
 * Reads TikTok comments using the user's own signed-in TikTok session.
 *
 * The user signs in once, themselves, in a visible browser window the app opens (solving any
 * CAPTCHA TikTok shows there, as they would anywhere). That browser profile is kept on disk, and
 * after each TikTok download the app opens the video page with it in the background and saves the
 * comments the page itself loads. Like the rest of the app, this never tries to get past a CAPTCHA:
 * if TikTok shows one, comments for that video are skipped, and the user can choose to solve it
 * themselves in a visible window (`solveComments`), after which the comments load as normal.
 */
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";

/**
 * Which browser to sign in with. Defaults to the installed Chrome, which TikTok accepts more readily
 * than the bundled Chromium; "chromium" uses the bundled one. Falls back to it if Chrome isn't installed.
 */
const CHANNEL = process.env.TIKTOK_BROWSER_CHANNEL || "chrome";
/** Holds the user's TikTok cookies. Keep it out of git and don't share it. One profile per browser: they can't share one. */
const PROFILE_ROOT = path.resolve(process.env.TIKTOK_PROFILE_DIR ?? ".tiktok-profile");
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_CLOSE_MS = 2 * 60 * 1000;
const MAX_COMMENTS = 50;
/** How long the CAPTCHA window waits for the user to solve it. */
const SOLVE_TIMEOUT_MS = 5 * 60 * 1000;
const CAPTCHA = /drag the (puzzle|slider)|verify to continue|select 2 objects|captcha/i;

export interface TikTokComment { user: string; handle?: string; text: string; likes: number; replies: number; at: number }
export type CommentsResult =
  | { status: "ready"; comments: TikTokComment[]; total?: number }
  | { status: "unavailable"; reason: "signed-out" | "captcha" | "none" | "error"; detail?: string };

type Session = {
  /** The browser actually in use, once known (Chrome may turn out not to be installed). */
  channel?: string;
  ctx?: Promise<BrowserContext>;
  idle?: ReturnType<typeof setTimeout>;
  signingIn?: boolean;
  /** A CAPTCHA window is open, waiting for the user. */
  solving?: boolean;
  /** Comment fetches run one at a time: the profile can only be open once. */
  chain: Promise<unknown>;
};
// Survive Next.js hot reloads in dev.
const g = globalThis as unknown as { __vgTikTok?: Session };
const session: Session = (g.__vgTikTok ??= { chain: Promise.resolve() });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const profileDir = () => path.join(PROFILE_ROOT, session.channel ?? CHANNEL);
const signedInFile = () => path.join(profileDir(), "video-grabber-signed-in.json");

async function launch(headless: boolean): Promise<BrowserContext> {
  const { chromium } = await import("playwright");
  const open = (channel: string) => {
    const dir = path.join(PROFILE_ROOT, channel);
    fs.mkdirSync(dir, { recursive: true });
    return chromium.launchPersistentContext(dir, {
      headless,
      viewport: headless ? { width: 1280, height: 800 } : null,
      locale: "en-ZA",
      channel: channel === "chromium" ? undefined : channel,
      // Playwright turns Chrome's sandbox off by default, which Chrome warns about in a bar across the window.
      chromiumSandbox: true,
      args: process.env.BROWSER_ARGS?.split(" ").filter(Boolean),
    });
  };
  try {
    const ctx = await open(session.channel ?? CHANNEL);
    session.channel ??= CHANNEL;
    return ctx;
  } catch (err) {
    // Chrome not installed: use the bundled browser instead.
    if (CHANNEL === "chromium" || !/is not found|Executable doesn't exist|distribution/i.test(String(err))) throw err;
    session.channel = "chromium";
    return open("chromium");
  }
}

async function closeSession() {
  clearTimeout(session.idle);
  const ctx = session.ctx;
  session.ctx = undefined;
  if (ctx) await (await ctx.catch(() => null))?.close().catch(() => {});
}

function getSession(): Promise<BrowserContext> {
  clearTimeout(session.idle);
  if (!session.ctx) {
    session.ctx = launch(true);
    session.ctx.then((c) => c.on("close", () => { session.ctx = undefined; }), () => { session.ctx = undefined; });
  }
  return session.ctx;
}

function idleLater() {
  clearTimeout(session.idle);
  session.idle = setTimeout(closeSession, IDLE_CLOSE_MS);
}

function markSignedIn(on: boolean) {
  try {
    if (on) fs.writeFileSync(signedInFile(), JSON.stringify({ at: Date.now() }));
    else fs.rmSync(signedInFile(), { force: true });
  } catch { /* the profile folder may not exist yet */ }
}

export function signInStatus() {
  return { signedIn: fs.existsSync(signedInFile()), signingIn: !!session.signingIn, solving: !!session.solving };
}

/**
 * Open a visible browser window on TikTok's sign-in page. The user signs in there; once TikTok
 * sets its session cookie the window closes by itself. Returns as soon as the window is open.
 */
export async function openSignIn() {
  if (session.signingIn) return;
  session.signingIn = true;
  try {
    await session.chain; // let a running comment fetch finish
    await closeSession(); // and release the profile
    const ctx = await launch(false);
    let closed = false;
    ctx.on("close", () => { closed = true; });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("https://www.tiktok.com/login", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});

    void (async () => {
      try {
        const end = Date.now() + SIGN_IN_TIMEOUT_MS;
        while (!closed && Date.now() < end) {
          const cookies = await ctx.cookies("https://www.tiktok.com").catch(() => []);
          if (cookies.some((c) => c.name === "sessionid" && c.value)) {
            markSignedIn(true);
            await sleep(2_000); // let TikTok finish saving its settings
            break;
          }
          await sleep(2_000);
        }
      } finally {
        await ctx.close().catch(() => {});
        session.signingIn = false;
      }
    })();
  } catch (err) {
    session.signingIn = false;
    throw err;
  }
}

// ---------- sign-in from a cookies file ----------

type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
};

/** Run something that needs the profile to itself: after any comment fetch, never during the sign-in window. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (session.signingIn) return Promise.reject(new Error("Close the TikTok sign-in window first."));
  const run = session.chain.then(async () => { await closeSession(); return fn(); });
  session.chain = run.catch(() => {});
  return run;
}

/**
 * Sign in with cookies exported from the user's normal browser, where they're already signed in to TikTok.
 * Takes a cookies.txt (Netscape format) or a JSON export (Cookie-Editor and similar). Only tiktok.com
 * cookies are kept, and only if the file includes TikTok's sign-in cookie.
 */
export function importCookies(text: string): Promise<{ count: number }> {
  const cookies = parseCookies(text).filter((c) => /(^|\.)tiktok\.com$/.test(c.domain.replace(/^\./, "")));
  if (!cookies.some((c) => c.name === "sessionid" && c.value)) {
    return Promise.reject(new Error(
      "That file has no TikTok sign-in in it. Export the cookies while you're on tiktok.com and signed in.",
    ));
  }
  return exclusive(async () => {
    const ctx = await launch(true);
    try {
      await ctx.clearCookies({ domain: /tiktok\.com$/ });
      await ctx.addCookies(cookies);
    } finally {
      await ctx.close().catch(() => {});
    }
    markSignedIn(true);
    return { count: cookies.length };
  });
}

/** Forget the TikTok sign-in: clear TikTok's cookies from the app's browser profile. */
export function signOut(): Promise<void> {
  return exclusive(async () => {
    const ctx = await launch(true);
    try {
      await ctx.clearCookies({ domain: /tiktok\.com$/ });
    } finally {
      await ctx.close().catch(() => {});
    }
    markSignedIn(false);
  });
}

function parseCookies(text: string): Cookie[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let json: unknown;
    try { json = JSON.parse(trimmed); } catch { throw new Error("That file isn't valid JSON."); }
    const list = Array.isArray(json) ? json : (json as { cookies?: unknown[] }).cookies;
    if (!Array.isArray(list)) throw new Error("Couldn't find a list of cookies in that file.");
    return list.flatMap((raw) => {
      const c = raw as Record<string, unknown>;
      if (typeof c.name !== "string" || typeof c.value !== "string" || typeof c.domain !== "string") return [];
      const expires = typeof c.expirationDate === "number" ? c.expirationDate : typeof c.expires === "number" ? c.expires : -1;
      return [cookie(c.name, c.value, c.domain, typeof c.path === "string" ? c.path : "/", c.session === true ? -1 : expires,
        c.httpOnly === true, c.secure === true, typeof c.sameSite === "string" ? c.sameSite : "")];
    });
  }
  // Netscape cookies.txt: domain, include-subdomains, path, secure, expiry, name, value — tab separated.
  return trimmed.split(/\r?\n/).flatMap((line) => {
    const httpOnly = line.startsWith("#HttpOnly_");
    if (!httpOnly && (line.startsWith("#") || !line.trim())) return [];
    const parts = line.replace(/^#HttpOnly_/, "").split("\t");
    if (parts.length < 7) return [];
    const [domain, , cpath, secure, expiry, name, ...value] = parts;
    return [cookie(name, value.join("\t"), domain, cpath, Number(expiry) || -1, httpOnly, secure.toUpperCase() === "TRUE", "")];
  });
}

function cookie(name: string, value: string, domain: string, cpath: string, expires: number, httpOnly: boolean, secure: boolean, sameSite: string): Cookie {
  // Browser exports name SameSite several ways ("no_restriction", "lax", "unspecified", …).
  const s = sameSite.toLowerCase();
  const same: Cookie["sameSite"] = s === "strict" ? "Strict" : s === "none" || s === "no_restriction" ? "None" : "Lax";
  return { name, value, domain, path: cpath || "/", expires: expires > 0 ? Math.floor(expires) : -1, httpOnly, secure: secure || same === "None", sameSite: same };
}

/** Load a video's comments with the signed-in profile. Runs one at a time. */
export function fetchComments(videoUrl: string): Promise<CommentsResult> {
  const run = session.chain.then(() => loadComments(videoUrl));
  session.chain = run.catch(() => {});
  return run;
}

async function loadComments(videoUrl: string): Promise<CommentsResult> {
  while (session.signingIn) await sleep(2_000);
  if (!signInStatus().signedIn) return { status: "unavailable", reason: "signed-out" };

  let page: Page | undefined;
  try {
    const ctx = await getSession();
    page = await ctx.newPage();
    return await readComments(ctx, page, videoUrl, 0);
  } catch (err) {
    return { status: "unavailable", reason: "error", detail: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  } finally {
    await page?.close().catch(() => {});
    idleLater();
  }
}

/**
 * Open the video in a visible window so the user can solve TikTok's CAPTCHA themselves. As soon as
 * the page loads its comments, they're returned and the window closes. Closing the window, or not
 * solving it within five minutes, gives up.
 */
export function solveComments(videoUrl: string): Promise<CommentsResult> {
  if (session.signingIn) return Promise.reject(new Error("Close the TikTok sign-in window first."));
  if (!signInStatus().signedIn) return Promise.resolve({ status: "unavailable", reason: "signed-out" });
  const run = session.chain.then(async (): Promise<CommentsResult> => {
    await closeSession(); // the window needs the profile to itself
    session.solving = true;
    const ctx = await launch(false).catch((err) => { session.solving = false; throw err; });
    let closed = false;
    ctx.on("close", () => { closed = true; });
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      return await readComments(ctx, page, videoUrl, SOLVE_TIMEOUT_MS);
    } catch (err) {
      // The user closed the window before solving it: still a CAPTCHA to solve, not an error.
      if (closed) return { status: "unavailable", reason: "captcha" };
      return { status: "unavailable", reason: "error", detail: err instanceof Error ? err.message.split("\n")[0] : String(err) };
    } finally {
      session.solving = false;
      await ctx.close().catch(() => {});
    }
  });
  session.chain = run.catch(() => {});
  return run;
}

/**
 * Open a video page, open its comments like a viewer would, and catch the comments the page loads.
 * With `solveMs` 0 (background), a CAPTCHA ends it. Otherwise the window is the user's to solve it in,
 * and this waits up to `solveMs` for the comments to arrive.
 */
async function readComments(ctx: BrowserContext, page: Page, videoUrl: string, solveMs: number): Promise<CommentsResult> {
  // The page asks TikTok's comment API itself; keep the first answer that has comments in it.
  let data: { comments?: RawComment[]; total?: number } | null = null;
  page.on("response", async (r) => {
    if (data || !/\/api\/comment\/list\//.test(r.url())) return;
    const json = await r.json().catch(() => null);
    if (json?.comments?.length) data = json;
  });
  const got = () => data as { comments?: RawComment[]; total?: number } | null;

  await page.goto(videoUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector("[data-e2e='comment-icon'], [data-e2e='browse-comment-count']", { timeout: 30_000 }).catch(() => {});

  // Signed in, comments often load straight away; otherwise open them like a viewer would.
  const openComments = async () => {
    const tab = page.getByText("Comments", { exact: true }).first();
    if (await tab.isVisible({ timeout: 1_000 }).catch(() => false)) await tab.click({ timeout: 5_000 }).catch(() => {});
    else await page.locator("[data-e2e='comment-icon']").first().click({ timeout: 5_000 }).catch(() => {});
  };
  for (let i = 0; i < 6 && !got(); i++) await page.waitForTimeout(500);
  if (!got()) await openComments();

  if (solveMs === 0) {
    for (let i = 0; i < 30 && !got(); i++) {
      if (await captchaShowing(page)) return { status: "unavailable", reason: "captcha" };
      await page.waitForTimeout(500);
    }
  } else {
    // The user's window: wait while they solve it. Once the puzzle is gone, open the comments again in case
    // the request that tripped it was dropped.
    const end = Date.now() + solveMs;
    let wasShowing = false;
    while (!got() && Date.now() < end) {
      if (page.isClosed()) return { status: "unavailable", reason: "captcha" };
      const showing = await captchaShowing(page);
      if (wasShowing && !showing) { await page.waitForTimeout(1_500); if (!got()) await openComments(); }
      wasShowing = showing;
      await page.waitForTimeout(1_000).catch(() => {});
    }
    if (page.isClosed()) return { status: "unavailable", reason: "captcha" };
  }

  const stillSignedIn = (await ctx.cookies("https://www.tiktok.com")).some((c) => c.name === "sessionid" && c.value);
  if (!stillSignedIn) {
    markSignedIn(false);
    return { status: "unavailable", reason: "signed-out" };
  }
  const result = got();
  if (!result?.comments?.length) return { status: "unavailable", reason: (await captchaShowing(page)) ? "captcha" : "none" };

  return {
    status: "ready",
    total: result.total,
    comments: result.comments.slice(0, MAX_COMMENTS).map((c) => ({
      user: c.user?.nickname || c.user?.unique_id || "TikTok user",
      handle: c.user?.unique_id,
      text: c.text ?? "",
      likes: c.digg_count ?? 0,
      replies: c.reply_comment_total ?? 0,
      at: (c.create_time ?? 0) * 1000,
    })),
  };
}

interface RawComment {
  text?: string;
  digg_count?: number;
  reply_comment_total?: number;
  create_time?: number;
  user?: { nickname?: string; unique_id?: string };
}

async function captchaShowing(page: Page) {
  if (await page.locator("#captcha-verify-container, [id*='captcha' i]:not(script)").first().isVisible().catch(() => false)) return true;
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) ?? "").catch(() => "");
  return CAPTCHA.test(text) && /puzzle|slider|verify/i.test(text);
}
