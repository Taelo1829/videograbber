"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AutoTikTok, FeedItem, Limit, PublicJob } from "@/lib/jobs";
import { TikTokFeed } from "./tiktok-feed";
import { GalleryPicker, type Gallery, type GalleryItem } from "./gallery-picker";

type LimitState = Limit & { waiting: number };

type ScheduleState = { start: string | null; end: string | null; open: boolean };
type Tab = "downloads" | "tiktok";

const TIKTOK_EXPLORE = "https://www.tiktok.com/explore";
/** Re-scan the explore page when the tab is opened after this long. */
const TIKTOK_RESCAN_MS = 10 * 60 * 1000;

/** Screens this narrow get the phone layout. */
const PHONE = "(max-width: 700px)";

const isTikTokUrl = (u: string) => { try { return /(^|\.)tiktok\.com$/.test(new URL(u).hostname); } catch { return false; } };

const MB = 1024 ** 2;
const GB = 1024 ** 3;

const ACTIVE = new Set(["queued", "starting", "downloading", "processing"]);
const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  starting: "Finding video",
  downloading: "Downloading",
  processing: "Joining & converting",
  done: "Ready",
  error: "Failed",
  cancelled: "Cancelled",
};

function formatBytes(n?: number) {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoSave, setAutoSave] = useState(true);
  const [gallery, setGallery] = useState<Gallery | null>(null);
  const [scanning, setScanning] = useState(false);
  const [limit, setLimit] = useState<LimitState | null>(null);
  const [capOn, setCapOn] = useState(false);
  const [capValue, setCapValue] = useState("2");
  const [capUnit, setCapUnit] = useState<"MB" | "GB">("GB");
  // How many new videos each TikTok search looks for (saved on the server).
  const [wantNew, setWantNew] = useState("30");
  const [savedWantNew, setSavedWantNew] = useState(30);
  useEffect(() => {
    fetch("/api/tiktok/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) { setWantNew(String(d.wantNew)); setSavedWantNew(d.wantNew); } })
      .catch(() => {});
  }, []);

  async function saveWantNew() {
    const n = Math.round(Number(wantNew));
    if (!Number.isFinite(n) || n < 1) { setWantNew(String(savedWantNew)); return; }
    const res = await fetch("/api/tiktok/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wantNew: n }),
    }).catch(() => null);
    const d = await res?.json().catch(() => null);
    if (res?.ok && d) { setWantNew(String(d.wantNew)); setSavedWantNew(d.wantNew); }
  }
  const capDialog = useRef<HTMLDialogElement>(null);
  const [schedule, setSchedule] = useState<ScheduleState | null>(null);
  const [scheduleOn, setScheduleOn] = useState(false);
  const [scheduleStart, setScheduleStart] = useState("23:00");
  const [scheduleEnd, setScheduleEnd] = useState("06:00");
  const lastWindow = useRef<string | null>(null);
  const [tab, setTab] = useState<Tab>("downloads");
  const [feed, setFeed] = useState<FeedItem[]>([]);
  // The TikTok tab's own scan of the explore page, separate from Find videos above.
  const [tiktokGallery, setTiktokGallery] = useState<Gallery | null>(null);
  const [tiktokScanning, setTiktokScanning] = useState(false);
  const [tiktokError, setTiktokError] = useState<string | null>(null);
  const tiktokScannedAt = useRef(0);
  // Signed in to TikTok in the app's own browser profile; comments need it.
  const [tiktokAuth, setTiktokAuth] = useState({ signedIn: false, signingIn: false, solving: false });
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  // "Refresh and download all": runs on the server, so this only shows how it's going.
  const [auto, setAuto] = useState<AutoTikTok | null>(null);
  const autoWasRunning = useRef(false);
  const authBar = useRef<HTMLDivElement>(null);
  // Jobs started in this tab that should auto-save when they finish.
  const pending = useRef(new Set<string>());

  const refreshLimit = useCallback(async () => {
    const res = await fetch("/api/limit", { cache: "no-store" }).catch(() => null);
    if (res?.ok) setLimit(await res.json());
  }, []);

  const refreshSchedule = useCallback(async () => {
    const res = await fetch("/api/schedule", { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    syncSchedule(await res.json());
  }, []);

  function syncSchedule(data: ScheduleState) {
    setSchedule(data);
    // Only touch the controls when the saved window changes, so polling doesn't fight the user's edits.
    const key = data.start && data.end ? `${data.start}-${data.end}` : null;
    if (key === lastWindow.current) return;
    lastWindow.current = key;
    setScheduleOn(key !== null);
    if (data.start && data.end) { setScheduleStart(data.start); setScheduleEnd(data.end); }
  }

  const refreshFeed = useCallback(async () => {
    const res = await fetch("/api/tiktok", { cache: "no-store" }).catch(() => null);
    if (res?.ok) setFeed(await res.json());
  }, []);

  const refresh = useCallback(async () => {
    refreshLimit();
    refreshSchedule();
    refreshFeed();
    const res = await fetch("/api/jobs", { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    const list: PublicJob[] = await res.json();
    setJobs(list);
    for (const j of list) {
      if (pending.current.has(j.id) && !ACTIVE.has(j.status)) {
        pending.current.delete(j.id);
        if (j.status === "done") save(j.id);
      }
    }
  }, [refreshLimit, refreshSchedule, refreshFeed]);

  useEffect(() => { refresh(); }, [refresh]);

  // Remember the open tab in this browser.
  useEffect(() => {
    try { if (localStorage.getItem("vg-tab") === "tiktok") setTab("tiktok"); } catch { /* storage blocked */ }
  }, []);

  // On a phone the app opens straight into the TikToks, full screen, like the TikTok app.
  const [phone, setPhone] = useState(false);
  const [immersive, setImmersive] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    if (mq.matches) { setTab("tiktok"); setImmersive(true); }
    const update = () => { setPhone(mq.matches); if (!mq.matches) setImmersive(false); };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  // The page behind the player shouldn't scroll.
  useEffect(() => {
    document.documentElement.classList.toggle("no-scroll", immersive && tab === "tiktok");
  }, [immersive, tab]);
  function openTab(t: Tab) {
    setTab(t);
    try { localStorage.setItem("vg-tab", t); } catch { /* storage blocked */ }
  }

  // Watched TikToks get deleted on the server; check now and then so they drop out of the feed.
  useEffect(() => {
    if (tab !== "tiktok") return;
    refreshFeed();
    const t = setInterval(refreshFeed, 60_000);
    return () => clearInterval(t);
  }, [tab, refreshFeed]);

  // Fill the cap controls from the server once.
  const capLoaded = useRef(false);
  useEffect(() => {
    if (!limit || capLoaded.current) return;
    capLoaded.current = true;
    if (limit.capBytes === null) return;
    const unit = limit.capBytes >= GB ? "GB" : "MB";
    setCapOn(true);
    setCapUnit(unit);
    setCapValue(String(+(limit.capBytes / (unit === "GB" ? GB : MB)).toFixed(2)));
  }, [limit]);

  async function saveCap(on = capOn, value = capValue, unit = capUnit) {
    const n = parseFloat(value);
    const capBytes = on && n > 0 ? Math.round(n * (unit === "GB" ? GB : MB)) : null;
    const res = await fetch("/api/limit", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capBytes }),
    }).catch(() => null);
    if (res?.ok) setLimit(await res.json());
  }

  async function saveSchedule(on = scheduleOn, start = scheduleStart, end = scheduleEnd) {
    if (on && (!start || !end || start === end)) {
      setError("Pick a start and a stop time that aren't the same.");
      return;
    }
    setError(null);
    const res = await fetch("/api/schedule", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(on ? { start, end } : { start: null, end: null }),
    }).catch(() => null);
    if (!res?.ok) return;
    syncSchedule(await res.json());
    refresh();
  }

  async function capAction(action: "continue" | "stop") {
    const res = await fetch("/api/limit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }).catch(() => null);
    if (res?.ok) setLimit(await res.json());
    refresh();
  }

  // Ask once the cap is hit and something is waiting to download.
  const capHit = !!limit?.paused && limit.waiting > 0;
  useEffect(() => {
    const d = capDialog.current;
    if (!d) return;
    if (capHit && !d.open) d.showModal();
    if (!capHit && d.open) d.close();
  }, [capHit]);

  const anyActive = jobs.some((j) => ACTIVE.has(j.status));
  // Cancelled downloads just clutter the lists.
  const shownJobs = jobs.filter((j) => j.status !== "cancelled");
  const downloadJobs = shownJobs.filter((j) => !isTikTokUrl(j.url));
  // Finished TikToks live in the feed; only show the ones still on their way (or that failed).
  const tiktokJobs = shownJobs.filter((j) => isTikTokUrl(j.url) && j.status !== "done");
  const newItems = gallery?.items.filter((i) => !i.downloaded) ?? [];
  // Only what hasn't been downloaded. Memoized: a new object each render would reset the picker's ticks.
  const tiktokNewGallery = useMemo(
    () => (tiktokGallery ? { ...tiktokGallery, items: tiktokGallery.items.filter((i) => !i.downloaded) } : null),
    [tiktokGallery],
  );
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [anyActive, refresh]);

  function save(id: string) {
    const a = document.createElement("a");
    a.href = `/api/jobs/${id}/file`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function startJobs(payload: { url: string } | { items: unknown[] }) {
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Couldn't start the download.");
    const list: PublicJob[] = Array.isArray(data) ? data : [data];
    const sent = "items" in payload && Array.isArray(payload.items) ? payload.items.length : 1;
    const skipped = sent - list.length;
    setNotice(skipped > 0 ? `Skipped ${skipped} ${skipped === 1 ? "video" : "videos"} you've already downloaded.` : null);
    // TikToks are watched in the TikTok tab, so they don't also go to the browser's downloads.
    if (autoSave) list.forEach((j) => { if (!isTikTokUrl(j.url)) pending.current.add(j.id); });
    // Show TikToks where they'll end up.
    if (list.length && list.every((j) => isTikTokUrl(j.url))) openTab("tiktok");
    await refresh();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await startJobs({ url });
      setUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function findVideos(pageUrl: string, onlyNew = false): Promise<Gallery> {
    const res = await fetch("/api/gallery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: pageUrl, onlyNew }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Couldn't read that page.");
    return { ...data, source: pageUrl };
  }

  async function scanPage() {
    setError(null);
    setScanning(true);
    setGallery(null);
    try {
      setGallery(await findVideos(url));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }

  async function scanTikTok() {
    setTiktokError(null);
    setTiktokScanning(true);
    tiktokScannedAt.current = Date.now();
    try {
      // TikTok's own page title is unreliable ("Log in | TikTok"), so name the page instead.
      // Scrolls past what's already been downloaded, so there's always something new.
      setTiktokGallery({ ...(await findVideos(TIKTOK_EXPLORE, true)), title: "tiktok.com/explore" });
    } catch (err) {
      tiktokScannedAt.current = 0; // let the next visit try again
      setTiktokError(err instanceof Error ? err.message : String(err));
    } finally {
      setTiktokScanning(false);
    }
  }

  const refreshTiktokAuth = useCallback(async () => {
    const res = await fetch("/api/tiktok/signin", { cache: "no-store" }).catch(() => null);
    if (res?.ok) setTiktokAuth(await res.json());
  }, []);

  // Keep checking while the tab is open: a CAPTCHA window can open by itself during downloads.
  useEffect(() => {
    if (tab !== "tiktok") return;
    refreshTiktokAuth();
    const t = setInterval(refreshTiktokAuth, tiktokAuth.signingIn || tiktokAuth.solving ? 3_000 : 8_000);
    return () => clearInterval(t);
  }, [tab, tiktokAuth.signingIn, tiktokAuth.solving, refreshTiktokAuth]);

  /** Sign in with a cookies file exported from the user's normal browser. */
  async function uploadCookies(file: File) {
    setAuthError(null);
    setAuthBusy(true);
    try {
      const res = await fetch("/api/tiktok/cookies", { method: "POST", body: await file.text() }).catch(() => null);
      const data = await res?.json().catch(() => null);
      if (res?.ok) setTiktokAuth(data);
      else setAuthError(data?.error ?? "Couldn't read that cookies file.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOutOfTikTok() {
    setAuthError(null);
    setAuthBusy(true);
    try {
      const res = await fetch("/api/tiktok/signin", { method: "DELETE" }).catch(() => null);
      const data = await res?.json().catch(() => null);
      if (res?.ok) setTiktokAuth(data);
      else setAuthError(data?.error ?? "Couldn't sign out.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function signInToTikTok() {
    setAuthError(null);
    const res = await fetch("/api/tiktok/signin", { method: "POST" }).catch(() => null);
    const data = await res?.json().catch(() => null);
    if (res?.ok) setTiktokAuth(data);
    else setAuthError(data?.error ?? "Couldn't open the sign-in window.");
  }

  // Only the latest request's answer counts, so a slow status check can't overwrite a run just started.
  const autoRequest = useRef(0);
  const refreshAuto = useCallback(async () => {
    const mine = ++autoRequest.current;
    const res = await fetch("/api/tiktok/auto", { cache: "no-store" }).catch(() => null);
    const data = res?.ok ? await res.json() : undefined;
    if (data !== undefined && mine === autoRequest.current) setAuto(data);
  }, []);

  async function startAuto() {
    const mine = ++autoRequest.current;
    const res = await fetch("/api/tiktok/auto", { method: "POST" }).catch(() => null);
    const data = res?.ok ? await res.json() : undefined;
    if (data !== undefined && mine === autoRequest.current) setAuto(data);
  }

  // Check on opening the tab, and every few seconds while a run is going.
  useEffect(() => {
    if (tab !== "tiktok") return;
    refreshAuto();
    if (!auto?.running) return;
    const t = setInterval(refreshAuto, 3_000);
    return () => clearInterval(t);
  }, [tab, auto?.running, refreshAuto]);

  // When a run finishes: show its downloads, and take what it queued out of the pick list.
  useEffect(() => {
    if (auto?.running) { autoWasRunning.current = true; return; }
    if (!autoWasRunning.current || !auto) return;
    autoWasRunning.current = false;
    const queued = new Set(auto.queued ?? []);
    setTiktokGallery((g) => (g ? { ...g, items: g.items.filter((i) => !queued.has(i.url)) } : g));
    refresh();
  }, [auto, refresh]);

  // Opening the TikTok tab looks for new videos on the explore page, unless it did so recently.
  useEffect(() => {
    if (tab === "tiktok" && !tiktokScanning && Date.now() - tiktokScannedAt.current > TIKTOK_RESCAN_MS) scanTikTok();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function downloadItems(items: GalleryItem[]) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await startJobs({ items: items.map(({ url, title }) => ({ url, title })) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, method: "POST" | "DELETE") {
    pending.current.delete(id);
    await fetch(`/api/jobs/${id}`, { method });
    refresh();
  }

  async function pasteFromClipboard() {
    try { setUrl((await navigator.clipboard.readText()).trim()); } catch { /* permission denied */ }
  }

  /** The "videos per search" box. It's in the settings panel and in the TikTok tab (the only one in reach on a phone). */
  function wantNewInput(id: string) {
    return (
      <input
        id={id}
        className="cap-input"
        type="number"
        min="1"
        max="500"
        step="1"
        inputMode="numeric"
        value={wantNew}
        onChange={(e) => setWantNew(e.target.value)}
        onBlur={saveWantNew}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveWantNew(); } }}
      />
    );
  }

  function renderJob(j: PublicJob) {
    return (
      <article key={j.id} className={`job ${j.status}`}>
        <div className="job-head">
          <span className={`pill ${j.status}`}>{STATUS_LABEL[j.status]}</span>
          {j.method === "page scan" && <span className="pill scan">Page scan</span>}
          {j.method === "browser" && <span className="pill scan">Browser</span>}
          <span className="title">{j.title ?? j.fileName ?? j.url}</span>
        </div>
        {j.title && <p className="url">{j.url}</p>}

        {ACTIVE.has(j.status) && (
          <>
            <div className="bar" role="progressbar" aria-valuenow={Math.round(j.progress)} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${j.status === "downloading" || j.status === "processing" ? j.progress : 0}%` }} className={j.status === "starting" || j.status === "queued" ? "indeterminate" : ""} />
            </div>
            <p className="meta">
              {j.status === "downloading" && <>{j.progress.toFixed(1)}%{j.speed && ` · ${j.speed}`}{j.eta && ` · ${j.eta} left`}</>}
              {j.status === "processing" && "Joining the video and audio into one MP4…"}
              {j.status === "starting" && `${j.step ?? "Looking for the video"}…`}
              {j.status === "queued" && (
                limit?.paused ? "Paused: data cap reached"
                : schedule && !schedule.open ? `Scheduled: starts at ${schedule.start}`
                : "Waiting for another download to finish…"
              )}
            </p>
          </>
        )}

        {j.status === "done" && <p className="meta">{j.fileName} · {formatBytes(j.size)}</p>}
        {j.status === "error" && <p className="error">{j.error}</p>}

        <div className="actions">
          {j.status === "done" && <button className="btn primary" onClick={() => save(j.id)}>Save file</button>}
          {ACTIVE.has(j.status) && <button className="btn" onClick={() => act(j.id, "DELETE")}>Cancel</button>}
          {!ACTIVE.has(j.status) && <button className="btn ghost" onClick={() => act(j.id, "DELETE")}>Remove</button>}
        </div>
      </article>
    );
  }

  return (
    <main className="wrap">
      <header>
        <div className="mark"><span className="dot" />Video Grabber</div>
        <h1>Paste a link. Get the video.</h1>
        <p className="lede">
          Works with YouTube, Vimeo and over a thousand other sites through yt-dlp. For anything else it scans the page, and if that fails it opens the page in a headless browser, picks a server, presses play and catches the stream.
        </p>
      </header>

      <form className="panel" onSubmit={submit}>
        <label htmlFor="url" className="label">Video or page link</label>
        <div className="input-row">
          <input
            id="url"
            type="url"
            inputMode="url"
            required
            placeholder="https://www.youtube.com/watch?v=…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
          />
          <button type="button" className="btn ghost" onClick={pasteFromClipboard}>Paste</button>
          <button type="button" className="btn" onClick={scanPage} disabled={scanning || busy || !url.trim()}>
            {scanning ? "Scanning…" : "Find videos"}
          </button>
          <button type="submit" className="btn primary" disabled={busy || scanning || !url.trim()}>
            {busy ? "Starting…" : "Download"}
          </button>
        </div>
        <label className="check">
          <input id="autosave" type="checkbox" checked={autoSave} onChange={(e) => setAutoSave(e.target.checked)} />
          Save to my browser's downloads when it finishes
        </label>
        <div className="cap-row">
          <label className="check">
            <input
              type="checkbox"
              checked={scheduleOn}
              onChange={(e) => { setScheduleOn(e.target.checked); saveSchedule(e.target.checked); }}
            />
            Only download between
          </label>
          <input
            className="cap-input"
            type="time"
            aria-label="Start downloading at"
            value={scheduleStart}
            disabled={!scheduleOn}
            onChange={(e) => setScheduleStart(e.target.value)}
            onBlur={() => scheduleOn && saveSchedule()}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveSchedule(); } }}
          />
          <span className="check">and</span>
          <input
            className="cap-input"
            type="time"
            aria-label="Stop downloading at"
            value={scheduleEnd}
            disabled={!scheduleOn}
            onChange={(e) => setScheduleEnd(e.target.value)}
            onBlur={() => scheduleOn && saveSchedule()}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveSchedule(); } }}
          />
          {schedule?.start && (
            <span className="meta">
              {schedule.open ? `Downloading now · stops at ${schedule.end}` : `Paused · starts at ${schedule.start}`}
            </span>
          )}
        </div>
        <div className="cap-row">
          <label className="check">
            <input
              type="checkbox"
              checked={capOn}
              onChange={(e) => { setCapOn(e.target.checked); saveCap(e.target.checked); }}
            />
            Stop after downloading
          </label>
          <input
            className="cap-input"
            type="number"
            min="0.1"
            step="any"
            inputMode="decimal"
            aria-label="Data cap amount"
            value={capValue}
            disabled={!capOn}
            onChange={(e) => setCapValue(e.target.value)}
            onBlur={() => saveCap()}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveCap(); } }}
          />
          <select
            className="cap-input"
            aria-label="Data cap unit"
            value={capUnit}
            disabled={!capOn}
            onChange={(e) => { const u = e.target.value as "MB" | "GB"; setCapUnit(u); saveCap(capOn, capValue, u); }}
          >
            <option>MB</option>
            <option>GB</option>
          </select>
          {limit && (
            <span className="meta">
              {formatBytes(limit.usedBytes) || "0 B"} used
              {limit.capBytes !== null && ` of ${formatBytes(limit.capBytes)}`}
              {limit.usedBytes > 0 && (
                <> · <button type="button" className="link" onClick={() => capAction("continue")}>Reset</button></>
              )}
            </span>
          )}
        </div>
        <div className="cap-row">
          <label className="check" htmlFor="want-new">TikTok: find</label>
          {wantNewInput("want-new")}
          <span className="check">new videos per search</span>
          <span className="meta">keeps looking until it has them</span>
        </div>
        <p className="hint">
          <b>Download</b> grabs the video on that page, clicking through server choices if it has to. <b>Find videos</b> is for a page of thumbnails: it lists the videos so you can pick which ones to download.
        </p>
        {scanning && <p className="meta">Opening the page in a headless browser and looking for thumbnails…</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
      </form>

      {gallery && (
        <GalleryPicker
          gallery={gallery}
          heading={`${gallery.items.length} videos found${newItems.length < gallery.items.length ? ` · ${gallery.items.length - newItems.length} already downloaded` : ""}`}
          busy={busy}
          onDownload={downloadItems}
          onClose={() => setGallery(null)}
        />
      )}

      <div className="tabs" role="tablist" aria-label="Downloads">
        <button role="tab" aria-selected={tab === "downloads"} className={`tab ${tab === "downloads" ? "on" : ""}`} onClick={() => openTab("downloads")}>
          Downloads{downloadJobs.length ? ` · ${downloadJobs.length}` : ""}
        </button>
        <button role="tab" aria-selected={tab === "tiktok"} className={`tab ${tab === "tiktok" ? "on" : ""}`} onClick={() => openTab("tiktok")}>
          TikTok{feed.length ? ` · ${feed.length}` : ""}
        </button>
      </div>

      {tab === "downloads" && (
        <section className="jobs" aria-live="polite">
          {downloadJobs.length === 0 && (
            <p className="empty">Downloads you start show up here with their progress. Finished files are also kept in the project's <code>downloads</code> folder. TikToks go to the TikTok tab.</p>
          )}
          {downloadJobs.map(renderJob)}
        </section>
      )}

      {tab === "tiktok" && (
        <section className="jobs" aria-live="polite">
          <div className="panel tt-auto">
            <p>
              {auto?.running
                ? `Searching TikTok explore for ${savedWantNew} new videos… they'll start downloading by themselves when it's done. You can close this page meanwhile.`
                : auto?.error
                  ? `The last search failed: ${auto.error}`
                  : auto?.finishedAt
                    ? auto.queued?.length
                      ? `Found ${auto.queued.length} new ${auto.queued.length === 1 ? "video" : "videos"} at ${new Date(auto.finishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} and started downloading them.`
                      : `Nothing new on TikTok explore at ${new Date(auto.finishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`
                    : "Don't want to pick? Search explore and download everything new in one go."}
            </p>
            <div className="tt-auto-actions">
              <label className="check" htmlFor="want-new-tiktok">Find</label>
              {wantNewInput("want-new-tiktok")}
              <span className="check">new</span>
              <button className="btn primary" onClick={startAuto} disabled={!!auto?.running}>
                {auto?.running ? "Searching…" : "Refresh & download all"}
              </button>
            </div>
          </div>
          {tiktokScanning && (
            <p className="panel meta">
              Looking for {savedWantNew} new videos on TikTok explore… this takes a minute or more, longer the more you ask for
              and the more you&apos;ve already downloaded.
            </p>
          )}
          {!tiktokScanning && tiktokError && (
            <div className="error" role="alert">
              {tiktokError} <button className="link" onClick={scanTikTok}>Try again</button>
            </div>
          )}
          {!tiktokScanning && tiktokNewGallery && (
            <GalleryPicker
              gallery={tiktokNewGallery}
              heading={tiktokNewGallery.items.length ? `${tiktokNewGallery.items.length} new on TikTok explore` : "Nothing new on TikTok explore"}
              busy={busy}
              onDownload={downloadItems}
              onRefresh={scanTikTok}
              compact
            />
          )}
          {tiktokJobs.map(renderJob)}
          <div className="panel tt-auth" ref={authBar}>
            {tiktokAuth.signingIn ? (
              <p>A browser window with TikTok&apos;s sign-in page is open on this computer. Sign in there; it closes by itself when you&apos;re done.</p>
            ) : tiktokAuth.signedIn && tiktokAuth.solving ? (
              <p className="tt-auth-alert">
                <b>TikTok wants a CAPTCHA solved.</b> A Chrome window with it is open on this computer. Solve it there so
                your downloads get their comments; the window closes by itself, and comments for the other videos follow.
              </p>
            ) : tiktokAuth.signedIn ? (
              <>
                <p>
                  Signed in to TikTok. Comments are saved with each video you download; if TikTok asks for a CAPTCHA,
                  a window opens for you to solve it.
                </p>
                <button className="btn ghost" onClick={signOutOfTikTok} disabled={authBusy}>Sign out</button>
              </>
            ) : (
              <>
                <div className="tt-auth-text">
                  <p>
                    <b>Comments need your TikTok sign-in.</b> Use the one from your normal browser: on tiktok.com, while signed in,
                    export the cookies with a cookies extension (such as &ldquo;Get cookies.txt LOCALLY&rdquo; or &ldquo;Cookie-Editor&rdquo;),
                    then upload the file here. Delete the file afterwards: it&apos;s your TikTok session.
                  </p>
                  <p>
                    Or <button className="link" onClick={signInToTikTok} disabled={authBusy}>sign in in a new window</button> on this computer.
                  </p>
                </div>
                {authError && <p className="error tt-auth-error" role="alert">{authError}</p>}
                <label className={`btn primary ${authBusy ? "disabled" : ""}`}>
                  {authBusy ? "Signing in…" : "Upload cookies file"}
                  <input
                    type="file"
                    accept=".txt,.json,text/plain,application/json"
                    hidden
                    disabled={authBusy}
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) uploadCookies(f); }}
                  />
                </label>
              </>
            )}
          </div>
          {phone && feed.length > 0 && (
            <button className="btn primary watch-full" onClick={() => setImmersive(true)}>▶ Watch full screen</button>
          )}
          <TikTokFeed
            items={feed}
            onWatched={(item) => setFeed((f) => f.map((x) => (x.id === item.id ? item : x)))}
            onDisliked={(id) => setFeed((f) => f.filter((x) => x.id !== id))}
            signedIn={tiktokAuth.signedIn}
            onSignIn={() => { setImmersive(false); setTimeout(() => authBar.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50); }}
            immersive={immersive}
            onExit={() => setImmersive(false)}
          />
          <p className="hint">A video counts as watched once it&apos;s been on screen, and is deleted an hour later. The app remembers every TikTok it has downloaded, so none comes down twice.</p>
        </section>
      )}

      <dialog
        ref={capDialog}
        className="modal"
        aria-labelledby="cap-title"
        onCancel={(e) => e.preventDefault()}
      >
        <h2 id="cap-title">Data cap reached</h2>
        <p>
          You&apos;ve downloaded {formatBytes(limit?.usedBytes)}
          {limit?.capBytes ? ` of your ${formatBytes(limit.capBytes)} cap` : ""}.{" "}
          {limit?.waiting === 1 ? "1 video is" : `${limit?.waiting ?? 0} videos are`} still waiting.
        </p>
        <p className="meta">Continuing allows another {formatBytes(limit?.capBytes ?? 0)} before asking again.</p>
        <div className="actions">
          <button className="btn primary" onClick={() => capAction("continue")} autoFocus>Continue downloading</button>
          <button className="btn" onClick={() => capAction("stop")}>Stop here</button>
        </div>
      </dialog>

      <footer>Only download videos you have the rights to. DRM-protected videos (Netflix, Showmax and the like) are refused.</footer>
    </main>
  );
}
