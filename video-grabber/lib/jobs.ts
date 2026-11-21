import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findVideoInPage } from "./page-scan";
import { captureStream, scanGallery } from "./browser";
import { fetchComments, solveComments, type CommentsResult } from "./tiktok-session";

export type JobStatus =
  | "queued"
  | "starting"
  | "downloading"
  | "processing"
  | "done"
  | "error"
  | "cancelled";

export interface Job {
  id: string;
  url: string;
  status: JobStatus;
  method?: "yt-dlp" | "page scan" | "browser";
  /** Who posted it and how it's doing, when the site reports it (TikTok does). */
  stats?: VideoStats;
  /** Stopped by the schedule; goes back in the queue instead of failing. */
  held?: boolean;
  /** What the job is doing right now, e.g. "Trying server 2 of 4". */
  step?: string;
  title?: string;
  progress: number; // 0–100
  speed?: string;
  eta?: string;
  filePath?: string;
  fileName?: string;
  size?: number;
  error?: string;
  createdAt: number;
}

/** The shape sent to the browser — no server paths. */
export type PublicJob = Omit<Job, "filePath">;

export const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR ?? "downloads");
const YTDLP = process.env.YTDLP_PATH ?? "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH; // folder or ffmpeg binary; unset = find it on PATH
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT ?? 2));
const MAX_FILESIZE = process.env.MAX_FILESIZE ?? "4G";

/** Data cap: once `usedBytes` reaches `capBytes`, queued jobs wait until the user says to continue. */
export interface Limit {
  capBytes: number | null; // null = no cap
  usedBytes: number; // downloaded since the cap was last reset
  paused: boolean;
}

/** Daily download window, "HH:MM" in the server's local time. Null = download any time. May run past midnight. */
export interface Schedule { start: string | null; end: string | null }

export interface VideoStats { creator?: string; likes?: number; comments?: number }

/** A link that finished downloading, keyed by the link (see `linkKey`). */
interface HistoryEntry {
  fileName: string;
  at: number;
  title?: string;
  url?: string;
  stats?: VideoStats;
  /** When it was first watched to the end in the TikTok tab. */
  watchedAt?: number;
  /** Disliked in the TikTok tab: gone from the feed at once, the file deleted shortly after (so Undo can still bring it
   * back), and like every TikTok in the history, never downloaded again. */
  disliked?: boolean;
  dislikedAt?: number;
  /** The file was removed an hour after watching. The entry stays so it's never downloaded again. */
  deleted?: boolean;
  /** TikTok comments: being fetched, saved in COMMENTS_DIR, or not available (and why). */
  comments?: CommentsState;
}

export type CommentsState =
  /** `solving`: a window is open for the user to solve TikTok's CAPTCHA. */
  | { status: "pending"; solving?: boolean }
  | { status: "ready"; count: number }
  | { status: "unavailable"; reason: string };

/** One downloaded TikTok in the feed. */
export interface FeedItem {
  id: string;
  title: string;
  /** The TikTok page, for its comments. */
  url: string;
  at: number;
  stats?: VideoStats;
  comments?: CommentsState;
  watchedAt?: number;
  deletesAt?: number;
}

/** How long a watched TikTok stays on disk. */
const KEEP_AFTER_WATCH_MS = Math.max(0, Number(process.env.TIKTOK_KEEP_MINUTES ?? 60)) * 60 * 1000;

type Store = {
  jobs: Map<string, Job>;
  procs: Map<string, ChildProcess>;
  queue: string[];
  limit?: Limit;
  history?: Map<string, HistoryEntry>;
  schedule?: Schedule;
  scheduleTimer?: ReturnType<typeof setInterval>;
  sweepTimer?: ReturnType<typeof setInterval>;
  autoTikTok?: AutoTikTok;
  /** CAPTCHA windows opened by themselves for downloads (see `autoSolve`). */
  autoSolve?: { open?: boolean; gaveUpAt?: number };
};
// Survive Next.js hot reloads in dev.
const g = globalThis as unknown as { __videoGrabber?: Store };
const store: Store = (g.__videoGrabber ??= { jobs: new Map(), procs: new Map(), queue: [] });

// Kept in the downloads folder so the cap and usage survive a restart.
const LIMIT_FILE = path.join(DOWNLOAD_DIR, ".limit.json");
const limit: Limit = (store.limit ??= loadLimit());

function loadLimit(): Limit {
  try {
    const saved = JSON.parse(fs.readFileSync(LIMIT_FILE, "utf8"));
    const capBytes = typeof saved.capBytes === "number" && saved.capBytes > 0 ? saved.capBytes : null;
    const usedBytes = typeof saved.usedBytes === "number" && saved.usedBytes > 0 ? saved.usedBytes : 0;
    return { capBytes, usedBytes, paused: capBytes !== null && usedBytes >= capBytes };
  } catch {
    return { capBytes: null, usedBytes: 0, paused: false };
  }
}

function saveLimit() {
  try {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    fs.writeFileSync(LIMIT_FILE, JSON.stringify({ capBytes: limit.capBytes, usedBytes: limit.usedBytes }));
  } catch { /* not worth failing a download over */ }
}

export function getLimit(): Limit & { waiting: number } {
  return { ...limit, waiting: store.queue.length };
}

/** Set or clear the cap. Raising it above what's been used resumes the queue. */
export function setCap(capBytes: number | null) {
  limit.capBytes = capBytes && capBytes > 0 ? capBytes : null;
  limit.paused = limit.capBytes !== null && limit.usedBytes >= limit.capBytes;
  saveLimit();
  pump();
}

/** "Continue downloading": start a fresh allowance of the same size and resume the queue. */
export function resumeAfterCap() {
  limit.usedBytes = 0;
  limit.paused = false;
  saveLimit();
  pump();
}

/** "Stop here": cancel everything still waiting in the queue, and drop it from the list. */
export function cancelQueued() {
  for (const id of [...store.queue]) removeJob(id);
}

function addUsage(bytes: number) {
  limit.usedBytes += bytes;
  if (limit.capBytes !== null && limit.usedBytes >= limit.capBytes) limit.paused = true;
  saveLimit();
}

// Every link that's been downloaded, so the same video isn't fetched twice.
const HISTORY_FILE = path.join(DOWNLOAD_DIR, ".history.json");
const TIKTOK_VIDEO = /^(?:[\w-]+\.)?tiktok\.com$/;
const history: Map<string, HistoryEntry> = (store.history ??= loadHistory());
// Older entries are keyed by the full link; re-key them so TikToks match by video ID. Also covers a hot-reloaded store.
for (const [k, v] of [...history]) {
  const key = /^https?:/.test(k) ? linkKey(k) : k;
  if (key !== k) { history.delete(k); history.set(key, v); }
}

function loadHistory(): Map<string, HistoryEntry> {
  try {
    const saved = new Map(Object.entries(JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")) as Record<string, HistoryEntry>));
    // A comment fetch cut short by a restart would otherwise stay "pending" for good.
    for (const e of saved.values()) if (e.comments?.status === "pending") e.comments = { status: "unavailable", reason: "not-fetched" };
    return saved;
  } catch {
    return new Map();
  }
}

function saveHistory() {
  try {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Object.fromEntries(history)));
  } catch { /* not worth failing a download over */ }
}

/** True for links on tiktok.com (including vm. and vt. short links). */
export function isTikTok(url: string) {
  try { return TIKTOK_VIDEO.test(new URL(url).hostname); } catch { return false; }
}

/**
 * The same link with or without a #fragment or trailing slash counts as one video.
 * TikToks go by video ID, since the same video shows up under different links.
 */
function linkKey(url: string) {
  const u = new URL(url);
  const tiktok = isTikTok(url) && u.pathname.match(/\/video\/(\d+)/);
  if (tiktok) return `tiktok:${tiktok[1]}`;
  u.hash = "";
  return u.href.replace(/\/$/, "");
}

/**
 * True when a link was downloaded before and shouldn't be fetched again.
 * TikToks never come back once downloaded, even after the file is deleted.
 * Other links whose file has since been deleted from the downloads folder can be downloaded again.
 */
function alreadyHave(key: string) {
  const prev = history.get(key);
  if (!prev) return false;
  return key.startsWith("tiktok:") || prev.deleted || fs.existsSync(path.join(DOWNLOAD_DIR, prev.fileName));
}

/** Why this link shouldn't be downloaded again, or undefined if it's fine. */
export function duplicateReason(url: string): string | undefined {
  const key = linkKey(url);
  const active = [...store.jobs.values()].find((j) => linkKey(j.url) === key && !isFinished(j.status));
  if (active) return "already downloading";
  if (!alreadyHave(key)) return;
  const prev = history.get(key)!;
  if (prev.disliked) return "one you disliked";
  return prev.deleted || !fs.existsSync(path.join(DOWNLOAD_DIR, prev.fileName))
    ? "already downloaded before (it's since been deleted)"
    : `already downloaded as ${prev.fileName}`;
}

/** Links (from `urls`) that were downloaded before. */
export function downloadedLinks(urls: string[]): string[] {
  return urls.filter((u) => alreadyHave(linkKey(u)));
}

function recordDownload(job: Job) {
  if (!job.fileName) return;
  const key = linkKey(job.url);
  history.set(key, { fileName: job.fileName, at: Date.now(), title: job.title, url: job.url, stats: job.stats });
  saveHistory();
  if (key.startsWith("tiktok:")) loadComments(key.slice(7));
}

// ---------- TikTok feed ----------

/** TikToks whose file is still on disk, newest first. */
export function tiktokFeed(): FeedItem[] {
  const out: FeedItem[] = [];
  for (const [key, e] of history) {
    if (!key.startsWith("tiktok:") || e.deleted || e.disliked || !fs.existsSync(path.join(DOWNLOAD_DIR, e.fileName))) continue;
    out.push({
      id: key.slice(7),
      title: e.title ?? e.fileName.replace(/\.[^.]+$/, ""),
      url: e.url ?? `https://www.tiktok.com/@/video/${key.slice(7)}`,
      at: e.at,
      stats: e.stats,
      comments: e.comments,
      watchedAt: e.watchedAt,
      deletesAt: e.watchedAt ? e.watchedAt + KEEP_AFTER_WATCH_MS : undefined,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Path of a TikTok's file in the downloads folder, if it's still there. */
export function tiktokFile(id: string): string | undefined {
  const e = history.get(`tiktok:${id}`);
  if (!e || e.deleted) return;
  const file = path.join(DOWNLOAD_DIR, e.fileName);
  return path.dirname(file) === DOWNLOAD_DIR && fs.existsSync(file) ? file : undefined;
}

/** Start the one-hour countdown. Watching again doesn't restart it. */
// Saved comments, one JSON file per TikTok, deleted along with the video.
const COMMENTS_DIR = path.join(DOWNLOAD_DIR, ".comments");
const commentsFile = (id: string) => path.join(COMMENTS_DIR, `${id}.json`);

/** Fetch a TikTok's comments in the background (needs the user's TikTok sign-in) and save them. */
export function loadComments(id: string): CommentsState | undefined {
  return startComments(id, false);
}

/**
 * TikTok showed a CAPTCHA: open the video in a window for the user to solve it, then save the comments.
 * Once that works, retry the other videos whose comments were skipped for a CAPTCHA.
 */
export function solveCommentsFor(id: string): CommentsState | undefined {
  return startComments(id, true);
}

function startComments(id: string, solve: boolean): CommentsState | undefined {
  const e = history.get(`tiktok:${id}`);
  if (!e || e.deleted) return;
  if (e.comments?.status === "pending") return e.comments;
  e.comments = solve ? { status: "pending", solving: true } : { status: "pending" };
  saveHistory();
  const url = e.url ?? `https://www.tiktok.com/@/video/${id}`;
  const fetching = solve ? solveComments(url) : fetchComments(url);
  fetching
    .catch((err): CommentsResult => ({ status: "unavailable", reason: "error", detail: String(err) }))
    .then((r) => {
      if (e.deleted) return;
      if (r.status === "ready") {
        try {
          fs.mkdirSync(COMMENTS_DIR, { recursive: true });
          fs.writeFileSync(commentsFile(id), JSON.stringify(r));
          e.comments = { status: "ready", count: r.comments.length };
        } catch {
          e.comments = { status: "unavailable", reason: "error" };
        }
      } else {
        e.comments = { status: "unavailable", reason: r.reason };
      }
      saveHistory();
      if (solve) {
        const a = (store.autoSolve ??= {});
        a.open = false;
        if (r.status === "ready") retrySkippedForCaptcha();
        else a.gaveUpAt = Date.now();
      } else if (r.status === "unavailable" && r.reason === "captcha") {
        autoSolve(id);
      }
    });
  return e.comments;
}

/** After an unsolved CAPTCHA window, wait this long before opening another by itself. */
const AUTO_SOLVE_PAUSE_MS = 30 * 60 * 1000;

/**
 * A download's comments hit a CAPTCHA: open the window for the user to solve it, without them having to ask.
 * Only one at a time; the other videos skipped meanwhile are retried once it's solved. If the user leaves one
 * unsolved (they're probably away), don't open more for half an hour; the panel's button still works.
 */
function autoSolve(id: string) {
  const a = (store.autoSolve ??= {});
  if (a.open || (a.gaveUpAt && Date.now() - a.gaveUpAt < AUTO_SOLVE_PAUSE_MS)) return;
  a.open = true;
  if (!startComments(id, true)) a.open = false;
}

/** After the user solves a CAPTCHA, TikTok usually lets the session through for a while. */
function retrySkippedForCaptcha() {
  for (const [key, e] of history) {
    if (key.startsWith("tiktok:") && !e.deleted && e.comments?.status === "unavailable" && e.comments.reason === "captcha") {
      loadComments(key.slice(7));
    }
  }
}

/** A TikTok's saved comments, or where fetching them stands. */
export function getComments(id: string): (CommentsState & { comments?: unknown[]; total?: number }) | undefined {
  const e = history.get(`tiktok:${id}`);
  if (!e || e.deleted) return;
  if (e.comments?.status !== "ready") return e.comments ?? { status: "unavailable", reason: "not-fetched" };
  try {
    const saved = JSON.parse(fs.readFileSync(commentsFile(id), "utf8"));
    return { ...e.comments, comments: saved.comments, total: saved.total };
  } catch {
    return { status: "unavailable", reason: "not-fetched" };
  }
}

/** How long a disliked video's file is kept, so Undo can bring it back. The minutely sweep deletes it after. */
const UNDO_DISLIKE_MS = 15_000;

/** "Not for me": hide the video for good. The history entry stays, so it's never downloaded again either. */
export function dislikeTikTok(id: string): boolean {
  const e = history.get(`tiktok:${id}`);
  if (!e) return false;
  e.disliked = true;
  e.dislikedAt ??= Date.now();
  saveHistory();
  return true;
}

/** Undo a dislike, if its file hasn't been deleted yet. */
export function undislikeTikTok(id: string): FeedItem | undefined {
  const e = history.get(`tiktok:${id}`);
  if (!e || !e.disliked || e.deleted) return;
  e.disliked = false;
  e.dislikedAt = undefined;
  saveHistory();
  return tiktokFeed().find((f) => f.id === id);
}

export function markWatched(id: string): FeedItem | undefined {
  const e = history.get(`tiktok:${id}`);
  if (!e || e.deleted) return;
  e.watchedAt ??= Date.now();
  saveHistory();
  return tiktokFeed().find((f) => f.id === id);
}

/** Delete TikToks watched more than an hour ago, keeping their history entry. */
function sweepWatched() {
  let changed = false;
  for (const [key, e] of history) {
    if (!key.startsWith("tiktok:") || e.deleted) continue;
    const due = e.disliked
      ? Date.now() - (e.dislikedAt ?? 0) >= UNDO_DISLIKE_MS
      : !!e.watchedAt && Date.now() - e.watchedAt >= KEEP_AFTER_WATCH_MS;
    if (!due) continue;
    try { fs.rmSync(path.join(DOWNLOAD_DIR, e.fileName), { force: true }); } catch { continue; } // in use: try again next sweep
    fs.rmSync(commentsFile(key.slice(7)), { force: true });
    e.deleted = true;
    changed = true;
  }
  if (changed) saveHistory();
}

// Kept in the downloads folder so a schedule survives a restart.
const SCHEDULE_FILE = path.join(DOWNLOAD_DIR, ".schedule.json");
// A hot reload keeps the old object, so replace one left over from the older one-off "startAt" schedule.
const schedule: Schedule = (store.schedule = store.schedule && "start" in store.schedule ? store.schedule : loadSchedule());
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function loadSchedule(): Schedule {
  try {
    const { start, end } = JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf8"));
    return HHMM.test(start) && HHMM.test(end) && start !== end ? { start, end } : { start: null, end: null };
  } catch {
    return { start: null, end: null };
  }
}

function saveSchedule() {
  try {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule));
  } catch { /* not worth failing a download over */ }
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** True when downloads are allowed right now. */
function inWindow(now = new Date()) {
  if (!schedule.start || !schedule.end) return true;
  const m = now.getHours() * 60 + now.getMinutes();
  const start = minutes(schedule.start), end = minutes(schedule.end);
  return start < end ? m >= start && m < end : m >= start || m < end; // the second case runs past midnight
}

/** Outside the window: stop running downloads and put them back at the front of the queue. */
function holdRunning() {
  for (const job of store.jobs.values()) {
    if (job.status !== "starting" && job.status !== "downloading" && job.status !== "processing") continue;
    job.held = true;
    const proc = store.procs.get(job.id);
    if (proc) killProc(proc);
  }
}

function requeue(job: Job) {
  job.held = false;
  job.status = "queued";
  job.method = job.step = job.speed = job.eta = undefined;
  job.progress = 0;
  store.queue.unshift(job.id);
}

// Check the clock every 15 seconds; the window only changes on the minute.
clearInterval(store.scheduleTimer);
store.scheduleTimer = setInterval(() => (inWindow() ? pump() : holdRunning()), 15_000);

export function getSchedule(): Schedule & { open: boolean } {
  return { ...schedule, open: inWindow() };
}

/** Only download between `start` and `end` each day, or pass nulls to download any time. */
export function setSchedule(start: string | null, end: string | null) {
  const ok = !!start && !!end && HHMM.test(start) && HHMM.test(end) && start !== end;
  schedule.start = ok ? start : null;
  schedule.end = ok ? end : null;
  saveSchedule();
  if (inWindow()) pump(); else holdRunning();
}

clearInterval(store.sweepTimer);
store.sweepTimer = setInterval(sweepWatched, 60_000);
sweepWatched();

// ---------- TikTok: refresh and download all ----------

export const TIKTOK_EXPLORE = "https://www.tiktok.com/explore";
// How many new videos a TikTok search looks for: it keeps going until it has that many (or TikTok runs out).
// Saved in the downloads folder so it survives a restart and applies to searches started from any device.
const TIKTOK_SETTINGS_FILE = path.join(DOWNLOAD_DIR, ".tiktok-settings.json");
const DEFAULT_WANT_NEW = 30;
export const MAX_WANT_NEW = 500;

export function getWantNew(): number {
  try {
    const n = JSON.parse(fs.readFileSync(TIKTOK_SETTINGS_FILE, "utf8")).wantNew;
    if (Number.isInteger(n) && n >= 1) return Math.min(n, MAX_WANT_NEW);
  } catch { /* not set yet */ }
  return DEFAULT_WANT_NEW;
}

export function setWantNew(n: number): number {
  const want = Math.max(1, Math.min(MAX_WANT_NEW, Math.round(n)));
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.writeFileSync(TIKTOK_SETTINGS_FILE, JSON.stringify({ wantNew: want }));
  return want;
}

/**
 * Search TikTok explore for `want` videos that weren't downloaded before. It keeps scrolling and stepping
 * through explore's categories until it has them; it only stops early if TikTok runs out of videos to show,
 * shows a CAPTCHA, or after a long safety limit.
 */
export async function findNewTikToks(want = getWantNew()) {
  const known = (u: string) => downloadedLinks([u]).length > 0;
  const result = await scanGallery(TIKTOK_EXPLORE, {
    skip: known,
    want,
    timeLimitMs: Math.min(30 * 60_000, 2 * 60_000 + want * 5_000),
  });
  return { ...result, items: result.items.filter((i) => !known(i.url)).slice(0, want) };
}

/** A scan of TikTok explore that queues every new video it finds. Runs on the server, so the page can be closed. */
export interface AutoTikTok {
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  /** Links queued for download when it finished. */
  queued?: string[];
  error?: string;
}

export function getAutoTikTok(): AutoTikTok | null {
  return store.autoTikTok ?? null;
}

export function startAutoTikTok(): AutoTikTok {
  if (store.autoTikTok?.running) return store.autoTikTok;
  const run: AutoTikTok = (store.autoTikTok = { running: true, startedAt: Date.now() });
  findNewTikToks()
    .then(({ items }) => {
      const queued: string[] = [];
      for (const it of items) {
        // Also skips anything downloaded, or started, since the scan began.
        if (duplicateReason(it.url)) continue;
        createJob(it.url, it.title);
        queued.push(it.url);
      }
      run.queued = queued;
    })
    .catch((err) => { run.error = err instanceof Error ? err.message.split("\n")[0] : String(err); })
    .finally(() => { run.running = false; run.finishedAt = Date.now(); });
  return run;
}

export function toPublic(job: Job): PublicJob {
  const { filePath: _omit, ...rest } = job;
  return rest;
}

export function listJobs(): Job[] {
  return [...store.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getJob(id: string): Job | undefined {
  return store.jobs.get(id);
}

export function createJob(url: string, title?: string): Job {
  const job: Job = { id: randomUUID(), url, title, status: "queued", progress: 0, createdAt: Date.now() };
  store.jobs.set(job.id, job);
  store.queue.push(job.id);
  pump();
  return job;
}

export function cancelJob(id: string): boolean {
  const job = store.jobs.get(id);
  if (!job) return false;
  store.queue = store.queue.filter((q) => q !== id);
  const proc = store.procs.get(id);
  if (proc) killProc(proc);
  if (!isFinished(job.status)) job.status = "cancelled";
  return true;
}

export function removeJob(id: string): boolean {
  cancelJob(id);
  return store.jobs.delete(id);
}

/**
 * yt-dlp.exe on Windows is a launcher that runs the real program as a child process,
 * and kill() only stops the launcher, so take down the whole process tree.
 */
function killProc(proc: ChildProcess) {
  if (process.platform === "win32" && proc.pid) {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true }).on("error", () => proc.kill());
  } else {
    proc.kill();
  }
}

// Reads status fresh (avoids TS narrowing across awaits). A held job stops like a cancelled one.
const isCancelled = (j: Job) => j.status === "cancelled" || !!j.held;
const isFinished = (s: JobStatus) => s === "done" || s === "error" || s === "cancelled";
const running = () => [...store.jobs.values()].filter((j) => j.status === "starting" || j.status === "downloading" || j.status === "processing").length;

function pump() {
  while (!limit.paused && inWindow() && running() < MAX_CONCURRENT && store.queue.length) {
    const id = store.queue.shift()!;
    const job = store.jobs.get(id);
    if (!job || job.status !== "queued") continue;
    job.status = "starting";
    runJob(job)
      .catch((err) => fail(job, err instanceof Error ? err.message : String(err)))
      .finally(() => {
        if (job.held && job.status !== "cancelled") requeue(job);
        pump();
      });
  }
}

function fail(job: Job, message: string) {
  if (isCancelled(job)) return;
  job.status = "error";
  job.step = undefined;
  job.error = message;
}

/**
 * Layer 1: yt-dlp on the link.
 * Layer 2: fetch the HTML and look for a video URL in it.
 * Layer 3: open the page in a headless browser, click through servers, press play,
 *          and catch the stream from network traffic.
 * Whatever a layer finds goes back through yt-dlp to actually download.
 */
async function runJob(job: Job) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  job.method = "yt-dlp";
  job.step = "Checking the link";
  const first = await runYtDlp(job, job.url);
  if (first.ok || isCancelled(job)) return;
  if (isFatal(first.error)) return fail(job, first.error!);

  job.method = "page scan";
  job.status = "starting";
  job.step = "Scanning the page";
  const found = await findVideoInPage(job.url);
  if (isCancelled(job)) return;
  if (found) {
    if (found.title && !job.title) job.title = found.title;
    const second = await runYtDlp(job, found.url, job.url, job.title);
    if (second.ok || isCancelled(job)) return;
    if (isFatal(second.error)) return fail(job, second.error!);
  }

  job.method = "browser";
  job.status = "starting";
  job.progress = 0;
  const cap = await captureStream(job.url, {
    onStep: (s) => { job.step = s; },
    shouldStop: () => isCancelled(job),
  });
  if (isCancelled(job)) return;
  if (!cap) {
    return fail(
      job,
      "Opened the page and tried every server button, but no video stream showed up. Add a recipe for this site in recipes.json (see README) so it knows which buttons to click."
    );
  }
  if (!job.title && cap.title) job.title = cap.title;
  job.step = cap.kind === "embed" ? "Handing the player to yt-dlp" : "Found the stream";
  const third = await runYtDlp(job, cap.url, cap.referer ?? job.url, job.title);
  if (!third.ok && !isCancelled(job)) fail(job, third.error ?? "Found the video stream but couldn't download it.");
}

/** Errors no fallback layer can fix. */
function isFatal(err?: string) {
  return !!err && /DRM|signed in|size limit|ffmpeg is needed|isn't installed/i.test(err);
}

interface RunResult { ok: boolean; unsupported?: boolean; error?: string }

function runYtDlp(job: Job, target: string, referer?: string, titleOverride?: string): Promise<RunResult> {
  const safeTitle = titleOverride?.replace(/[\\/:*?"<>|%\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  const args = [
    target,
    "--newline",
    "--no-colors",
    "--no-playlist",
    "--windows-filenames",
    // Without this, Windows prints emoji in file names as "?" and the finished file can't be found.
    "--encoding", "utf-8",
    "--max-filesize", MAX_FILESIZE,
    "--merge-output-format", "mp4",
    "-o", path.join(DOWNLOAD_DIR, safeTitle ? `${safeTitle}.%(ext)s` : "%(title).120B [%(id)s].%(ext)s"),
    // --print makes yt-dlp quiet and simulate; these two flags undo that.
    "--no-simulate",
    "--progress",
    "--progress-template", "download:PROGRESS %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
    "--print", "before_dl:TITLE %(title)s",
    "--print", "before_dl:STATS %(uploader)s|%(like_count)s|%(comment_count)s",
    "--print", "after_move:FILE %(filepath)s",
  ];
  if (FFMPEG) args.push("--ffmpeg-location", FFMPEG);
  // TikTok's best copy is often H.265, which many browsers can't play in the TikTok tab; H.264 plays everywhere.
  if (isTikTok(job.url)) args.push("-S", "vcodec:h264");
  if (referer) args.push("--referer", referer);

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(YTDLP, args, { windowsHide: true });
    } catch {
      return resolve({ ok: false, error: missingYtDlp() });
    }
    store.procs.set(job.id, child);
    const errLines: string[] = [];
    let unsupported = false;
    // No progress at all means yt-dlp found the file already on disk (same video, different link).
    let sawProgress = false;
    let spawnFailed = false;

    const onLine = (line: string) => {
      line = line.trim();
      if (!line) return;
      if (line.startsWith("PROGRESS ")) {
        const [pct, speed, eta] = line.slice(9).split("|").map((s) => s.trim());
        const n = parseFloat(pct);
        if (!Number.isNaN(n)) job.progress = Math.min(100, n);
        job.speed = speed && speed !== "NA" ? speed : undefined;
        job.step = undefined;
        job.eta = eta && eta !== "NA" ? eta : undefined;
        job.status = "downloading";
        sawProgress = true;
      } else if (line.startsWith("STATS ")) {
        const [creator, likes, comments] = line.slice(6).split("|");
        const num = (v: string) => (/^\d+$/.test(v) ? Number(v) : undefined);
        job.stats = { creator: creator && creator !== "NA" ? creator : undefined, likes: num(likes), comments: num(comments) };
      } else if (line.startsWith("TITLE ")) {
        if (!titleOverride) job.title = line.slice(6);
      } else if (line.startsWith("FILE ")) {
        job.filePath = line.slice(5);
      } else if (/^\[(Merger|FixupM3u8|FixupM4a|VideoConvertor|ffmpeg)\]/.test(line)) {
        job.status = "processing";
      }
    };
    const splitter = (cb: (l: string) => void) => {
      let buf = "";
      return (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const parts = buf.split(/\r?\n|\r/);
        buf = parts.pop() ?? "";
        parts.forEach(cb);
      };
    };

    child.stdout?.on("data", splitter(onLine));
    child.stderr?.on("data", splitter((l) => {
      if (/Unsupported URL/i.test(l)) unsupported = true;
      if (/^ERROR:/.test(l)) errLines.push(l.replace(/^ERROR:\s*/, ""));
    }));

    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnFailed = true;
      store.procs.delete(job.id);
      resolve({ ok: false, error: err.code === "ENOENT" ? missingYtDlp() : err.message });
    });

    child.on("close", (code) => {
      store.procs.delete(job.id);
      if (spawnFailed) return;
      if (isCancelled(job)) return resolve({ ok: false });
      if (code === 0 && job.filePath && fs.existsSync(job.filePath)) {
        job.status = "done";
        job.step = undefined;
        job.progress = 100;
        job.fileName = path.basename(job.filePath);
        job.size = fs.statSync(job.filePath).size;
        if (sawProgress) addUsage(job.size);
        recordDownload(job);
        job.speed = job.eta = undefined;
        return resolve({ ok: true });
      }
      if (code === 0 && !job.filePath) {
        return resolve({ ok: false, error: "The video is bigger than the size limit (MAX_FILESIZE), or yt-dlp skipped it." });
      }
      resolve({ ok: false, unsupported, error: friendly(errLines.at(-1)) });
    });
  });
}

function missingYtDlp() {
  return "yt-dlp isn't installed or isn't on your PATH. Install it (see README), or set YTDLP_PATH in .env.local.";
}

function friendly(msg?: string) {
  if (!msg) return undefined;
  if (/DRM/i.test(msg)) return "This video is DRM-protected, so it can't be downloaded.";
  if (/ffmpeg/i.test(msg) && /not (found|installed)/i.test(msg)) return "ffmpeg is needed for this video. Install it (see README) and try again.";
  if (/Sign in|login|cookies/i.test(msg)) return "This video needs you to be signed in. yt-dlp can use your browser's cookies: see --cookies-from-browser in the README.";
  if (/HTTP Error 403/i.test(msg)) return "The site refused the download (403). The link may have expired or need a referer; try again with a fresh link.";
  return msg;
}
