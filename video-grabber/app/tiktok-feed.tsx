"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FeedItem } from "@/lib/jobs";
import type { TikTokComment } from "@/lib/tiktok-session";

/** 806600 → "806.6K", like TikTok shows counts. */
function count(n: number) {
  if (n < 1000) return String(n);
  const [d, u] = n < 1e6 ? [1e3, "K"] : [1e6, "M"];
  return `${+(n / d).toFixed(1)}${u}`;
}

function clock(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Downloaded TikToks, one at a time, moved through with the up and down buttons (or arrow keys):
 * on phones you swipe up and down instead. Videos you haven't watched come first, in random order.
 * The video on screen plays, the rest pause. A video counts as watched as soon as it's been on screen,
 * and the server deletes it an hour later.
 */
export function TikTokFeed({
  items: newestFirst,
  onWatched,
  onDisliked,
  signedIn,
  onSignIn,
  immersive,
  onExit,
}: {
  items: FeedItem[];
  onWatched: (item: FeedItem) => void;
  /** A video was disliked (and deleted on the server). */
  onDisliked: (id: string) => void;
  /** Signed in to TikTok in the app's browser profile, which comments need. */
  signedIn: boolean;
  onSignIn: () => void;
  /** Fill the whole screen, like the TikTok app (used on phones). */
  immersive?: boolean;
  /** Leave the full-screen player for the rest of the app. */
  onExit?: () => void;
}) {
  const feed = useRef<HTMLDivElement>(null);
  // Once opened, the comments follow you from video to video until closed.
  const [showComments, setShowComments] = useState(false);
  // Wide screens have room for the comments beside the video; narrower ones put them over it.
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(SIDE_BY_SIDE);
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  // Phones swipe between videos (like the TikTok app) and get a comments button where the arrows would be.
  const [swipe, setSwipe] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const update = () => setSwipe(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  // Sound is on unless the user turned it off (remembered in this browser). Browsers may still refuse to
  // play sound before the first tap on the page; until then videos play muted and the button says so.
  const [soundOff, setSoundOff] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const muted = soundOff || needsTap;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  useEffect(() => {
    try { setSoundOff(localStorage.getItem("vg-sound") === "off"); } catch { /* storage blocked */ }
  }, []);

  // Playback speed, remembered in this browser; every video plays at it.
  const [speed, setSpeed] = useState(1);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem("vg-speed"));
      if (SPEEDS.includes(saved)) setSpeed(saved);
    } catch { /* storage blocked */ }
  }, []);
  useEffect(() => {
    feed.current?.querySelectorAll("video").forEach((v) => { v.defaultPlaybackRate = speed; v.playbackRate = speed; });
  }, [speed]);
  /** Tap to step through 0.5x → 1x → 1.5x → 2x and round again. */
  function nextSpeed() {
    const s = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(s);
    try { localStorage.setItem("vg-speed", String(s)); } catch { /* storage blocked */ }
  }

  /** Play with the current sound setting; if the browser won't allow sound yet, play muted instead. */
  function play(v: HTMLVideoElement) {
    v.muted = mutedRef.current;
    v.defaultPlaybackRate = speedRef.current;
    v.playbackRate = speedRef.current;
    v.play().catch((err: unknown) => {
      if (v.muted || (err as Error)?.name !== "NotAllowedError") return;
      setNeedsTap(true);
      v.muted = true;
      v.play().catch(() => {});
    });
  }

  // The tap that turns sound on shouldn't also pause the video it landed on.
  const unlockTap = useRef(false);

  function unmuteNow() {
    feed.current?.querySelectorAll("video").forEach((v) => { v.muted = false; });
  }

  // The first tap or key press anywhere lets the browser play sound. (The sound button handles its own tap.)
  useEffect(() => {
    if (!needsTap) return;
    const unlock = (e: Event) => {
      if ((e.target as Element | null)?.closest?.(".reel-sound:not(.reel-speed)")) return;
      unlockTap.current = e.type === "pointerdown";
      setTimeout(() => { unlockTap.current = false; }, 600); // only the click that belongs to this tap
      setNeedsTap(false);
      if (!soundOff) unmuteNow();
    };
    window.addEventListener("pointerdown", unlock, { capture: true });
    window.addEventListener("keydown", unlock, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", unlock, { capture: true });
      window.removeEventListener("keydown", unlock, { capture: true });
    };
  }, [needsTap, soundOff]);

  function soundButton() {
    if (needsTap) { setNeedsTap(false); if (!soundOff) unmuteNow(); return; }
    const off = !soundOff;
    setSoundOff(off);
    try { localStorage.setItem("vg-sound", off ? "off" : "on"); } catch { /* storage blocked */ }
    if (!off) unmuteNow();
  }
  const reported = useRef(new Set<string>());

  // Track the video on screen by ID, so the list can change (downloads arrive, watched ones get deleted) without jumping.
  const [currentId, setCurrentId] = useState<string | null>(null);
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;

  // Unwatched videos first, in random order, then the watched ones. The order then stays put while you watch:
  // watching a video doesn't move it, and new downloads slot in at random places further down.
  const [order, setOrder] = useState<string[]>([]);
  useEffect(() => {
    setOrder((prev) => {
      const present = new Set(newestFirst.map((i) => i.id));
      const kept = prev.filter((id) => present.has(id));
      const known = new Set(kept);
      const fresh = newestFirst.filter((i) => !known.has(i.id));
      if (!fresh.length && kept.length === prev.length) return prev;
      if (!kept.length) {
        const watched = fresh.filter((i) => i.watchedAt).sort((a, b) => a.watchedAt! - b.watchedAt!);
        return [...shuffle(fresh.filter((i) => !i.watchedAt)), ...watched].map((i) => i.id);
      }
      const out = [...kept];
      const from = out.indexOf(currentIdRef.current ?? "") + 1;
      for (const it of shuffle(fresh)) out.splice(from + Math.floor(Math.random() * (out.length - from + 1)), 0, it.id);
      return out;
    });
  }, [newestFirst]);
  // Disliked videos vanish at once; the server is only told after a few seconds, so Undo can bring one back.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const items = useMemo(() => {
    const byId = new Map(newestFirst.map((i) => [i.id, i]));
    return order.flatMap((id) => (hidden.has(id) ? [] : byId.get(id) ?? []));
  }, [order, newestFirst, hidden]);

  // The observer below outlives renders, so it reads the list through a ref.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const lastIndex = useRef(0);
  let index = items.findIndex((i) => i.id === currentId);
  if (index < 0) {
    // First load: the top of the list. After a deletion: whatever moved into that spot.
    index = currentId === null ? 0 : lastIndex.current;
    index = Math.max(0, Math.min(index, items.length - 1));
  }
  lastIndex.current = index;
  const current = items[index];

  // A short message over the player, e.g. "Link copied".
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  function flash(message: string) {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2_500);
  }

  /** Share the video's original TikTok link: the phone's share sheet where there is one, else copy it. */
  async function share(item: FeedItem) {
    if (navigator.share) {
      try {
        await navigator.share({ title: item.title, url: item.url });
        return;
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return; // closed the share sheet
      }
    }
    flash((await copyText(item.url)) ? "TikTok link copied" : item.url);
  }

  // The most recent dislike, while it can still be undone. The server hears about a dislike straight away (so closing
  // the app can't lose it) and keeps the file a little longer, which is what lets Undo bring it back.
  const [undo, setUndo] = useState<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const UNDO_MS = 5_000;

  function dislike(item: FeedItem) {
    if (undo) clearTimeout(undo.timer);
    setHidden((h) => new Set(h).add(item.id));
    setShowComments(false);
    fetch(`/api/tiktok/${item.id}/dislike`, { method: "POST" }).catch(() => {});
    const timer = setTimeout(() => { setUndo(null); onDisliked(item.id); }, UNDO_MS);
    setUndo({ id: item.id, timer });
  }

  async function undoDislike() {
    if (!undo) return;
    clearTimeout(undo.timer);
    const id = undo.id;
    setUndo(null);
    const res = await fetch(`/api/tiktok/${id}/dislike`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) { onDisliked(id); flash("Too late to undo: it's already been deleted"); return; }
    setHidden((h) => { const n = new Set(h); n.delete(id); return n; });
    setCurrentId(id);
  }

  function go(step: number) {
    const next = items[index + step];
    if (next) setCurrentId(next.id);
  }

  // On phones the feed scrolls by swiping; once a swipe settles, the video it landed on becomes the current one.
  const fromSwipe = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  function onFeedScroll() {
    if (!swipe) return;
    clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      const root = feed.current;
      const landed = root && items[Math.round(root.scrollTop / root.clientHeight)];
      if (landed && landed.id !== current?.id) { fromSwipe.current = true; setCurrentId(landed.id); }
    }, 120);
  }

  // Slide to the current video (buttons, keys, list changes). The first time, jump there without animating.
  const placed = useRef(false);
  useEffect(() => {
    const root = feed.current;
    if (!root || !current) return;
    if (fromSwipe.current) { fromSwipe.current = false; placed.current = true; return; } // already there
    root.scrollTo({ top: index * root.clientHeight, behavior: placed.current ? "smooth" : "auto" });
    placed.current = true;
  }, [index, current]);

  // Play whichever video is mostly on screen; pause the others. Measured against the window (not the feed)
  // so nothing plays while the feed itself is scrolled out of view.
  const ids = items.map((i) => i.id).join(",");
  // Comments over the video (narrow screens): the video shrinks into the space above them.
  const commentsOver = showComments && (!wide || !!immersive);
  useEffect(() => {
    const root = feed.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const v = e.target as HTMLVideoElement;
          if (!e.isIntersecting) { v.pause(); continue; }
          play(v);
          // Being on screen is enough to count as watched (and start the hour before it's deleted).
          const seen = itemsRef.current.find((i) => i.id === v.dataset.id);
          if (seen) reportWatched(seen);
        }
      },
      { threshold: 0.6 },
    );
    root.querySelectorAll("video").forEach((v) => io.observe(v));
    return () => io.disconnect();
  }, [ids]);

  useEffect(() => {
    feed.current?.querySelectorAll("video").forEach((v) => { v.muted = muted; });
  }, [muted]);

  async function reportWatched(item: FeedItem) {
    if (item.watchedAt || reported.current.has(item.id)) return;
    reported.current.add(item.id);
    const res = await fetch(`/api/tiktok/${item.id}/watched`, { method: "POST" }).catch(() => null);
    if (res?.ok) onWatched(await res.json());
    else reported.current.delete(item.id);
  }

  if (!items.length && newestFirst.length && !undo) return null; // first shuffle lands on the next render
  if (!items.length) {
    const undoBar = undo && (
      <p className="empty-undo">Removed. <button className="link" onClick={undoDislike}>Undo</button></p>
    );
    if (immersive) {
      return (
        <div className="feed-wrap immersive feed-empty">
          <p>No TikToks to watch yet.</p>
          <button className="btn primary" onClick={onExit}>Find some</button>
          {undoBar}
        </div>
      );
    }
    return (
      <div className="empty">
        No TikToks yet. Pick some from the explore list above and they&apos;ll show up here to watch.
        {undoBar}
      </div>
    );
  }

  return (
    <div className={`feed-wrap ${immersive ? "immersive" : showComments && wide ? "with-comments" : ""} ${commentsOver ? "comments-over" : ""}`}>
      {immersive && <button className="feed-exit" onClick={onExit} aria-label="Menu">☰</button>}
      <div
        className={`feed ${swipe ? "swipe" : ""} ${swipe && commentsOver ? "locked" : ""}`}
        ref={feed}
        tabIndex={0}
        aria-label="TikTok videos"
        onScroll={onFeedScroll}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); go(1); }
          if (e.key === "ArrowUp") { e.preventDefault(); go(-1); }
        }}
      >
        {items.map((it) => (
          <section key={it.id} className={`reel ${commentsOver && it.id === current?.id ? "with-comments" : ""}`}>
            <video
              src={`/api/tiktok/${it.id}/video`}
              data-id={it.id}
              loop
              playsInline
              preload="metadata"
              ref={(v) => { if (v) { v.muted = muted; v.defaultPlaybackRate = v.playbackRate = speedRef.current; } }}
              onClick={(e) => {
                if (unlockTap.current) { unlockTap.current = false; return; }
                const v = e.currentTarget;
                if (v.paused) v.play().catch(() => {}); else v.pause();
              }}
            />
            <div className="reel-info">
              {it.stats?.creator && <p className="reel-creator">@{it.stats.creator}</p>}
              <p className="reel-title">{it.title}</p>
              <p className="reel-stats">
                {it.stats?.likes !== undefined && <span>♥ {count(it.stats.likes)}</span>}
                <button className="reel-link" onClick={() => setShowComments(true)}>
                  💬 {it.stats?.comments !== undefined ? `${count(it.stats.comments)} comments` : "Comments"}
                </button>
                <button className="reel-link" onClick={() => share(it)}>↗ Share</button>
                <button className="reel-link" onClick={() => dislike(it)}>👎 Not for me</button>
              </p>
              <p className="reel-meta">
                {it.deletesAt ? `Watched · deleted at ${clock(it.deletesAt)}` : "Not watched yet"}
              </p>
            </div>
            <div className="reel-top">
              <button className="reel-sound reel-speed" onClick={nextSpeed} aria-label={`Playback speed ${speed}x, tap to change`}>
                {speed}x
              </button>
              <button className="reel-sound" onClick={soundButton} aria-label={muted ? "Turn sound on" : "Turn sound off"}>
                {needsTap ? "Tap for sound" : soundOff ? "Sound off" : "Sound on"}
              </button>
            </div>
            {commentsOver && it.id === current?.id && (
              <CommentsPanel key={it.id} item={it} signedIn={signedIn} onSignIn={onSignIn} onClose={() => setShowComments(false)} />
            )}
          </section>
        ))}
      </div>
      {swipe ? (
        !commentsOver && current && (
          <div className="feed-side">
            <button className="feed-btn" onClick={() => setShowComments(true)} aria-label="Comments">💬</button>
            <span className="feed-pos">{current.stats?.comments !== undefined ? count(current.stats.comments) : ""}</span>
            <button className="feed-btn" onClick={() => share(current)} aria-label="Share">{SHARE_ICON}</button>
            <span className="feed-pos">Share</span>
            <button className="feed-btn" onClick={() => dislike(current)} aria-label="Dislike: never show this again">👎</button>
            <span className="feed-pos">Not for me</span>
          </div>
        )
      ) : (
        <div className="feed-nav">
          <button className="feed-btn" onClick={() => go(-1)} disabled={index === 0} aria-label="Previous video">↑</button>
          <span className="feed-pos" aria-live="polite">{index + 1} / {items.length}</span>
          <button className="feed-btn" onClick={() => go(1)} disabled={index === items.length - 1} aria-label="Next video">↓</button>
        </div>
      )}
      {toast && <div className="feed-toast" role="status">{toast}</div>}
      {undo && (
        <div className="feed-toast feed-undo" role="status">
          Removed. It won&apos;t come back. <button onClick={undoDislike}>Undo</button>
        </div>
      )}
      {showComments && wide && !immersive && current && (
        <CommentsPanel key={current.id} item={current} side signedIn={signedIn} onSignIn={onSignIn} onClose={() => setShowComments(false)} />
      )}
    </div>
  );
}

const SPEEDS = [0.5, 1, 1.5, 2];

/** Keep in step with the matching media query in globals.css. */
const SIDE_BY_SIDE = "(min-width: 1000px)";
/** Same as PHONE in page.tsx. */
const PHONE = "(max-width: 700px)";

const SHARE_ICON = (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
    <path d="M12 3v12" />
    <path d="M7 8l5-5 5 5" />
  </svg>
);

/**
 * Copy text to the clipboard. The modern clipboard API only works on https (or localhost), and the app is
 * usually opened over the laptop's plain-http Wi-Fi address, so fall back to the older copy command.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* not allowed */ }
  area.remove();
  return ok;
}

/** A shuffled copy (Fisher–Yates). */
function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type CommentsResponse =
  | { status: "ready"; comments: TikTokComment[]; total?: number }
  | { status: "pending"; solving?: boolean }
  | { status: "unavailable"; reason: string };

const UNAVAILABLE: Record<string, string> = {
  "signed-out": "Comments need you to be signed in to TikTok.",
  captcha: "TikTok wants a CAPTCHA solved before it shows these comments. Solve it in a window and they'll load here.",
  none: "TikTok didn't send any comments for this video.",
  "not-fetched": "Comments haven't been loaded for this video yet.",
  error: "Something went wrong loading the comments.",
};

/** The saved comments for one TikTok, beside the video or over the bottom of it. */
function CommentsPanel({
  item,
  side,
  signedIn,
  onSignIn,
  onClose,
}: {
  item: FeedItem;
  /** Beside the video rather than over it. */
  side?: boolean;
  signedIn: boolean;
  onSignIn: () => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<CommentsResponse | null>(null);

  // Load what's saved, and keep checking while a fetch is under way.
  useEffect(() => {
    if (data && data.status !== "pending") return;
    const t = setTimeout(async () => {
      const res = await fetch(`/api/tiktok/${item.id}/comments`, { cache: "no-store" }).catch(() => null);
      if (res?.ok) setData(await res.json());
    }, data ? 3_000 : 0);
    return () => clearTimeout(t);
  }, [data, item.id]);

  /** Fetch in the background, or (`solve`) open a window where the user solves TikTok's CAPTCHA first. */
  async function load(solve = false) {
    setData({ status: "pending", solving: solve });
    const res = await fetch(`/api/tiktok/${item.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ solve }),
    }).catch(() => null);
    if (res?.ok) setData(await res.json());
  }

  const total = item.stats?.comments;
  return (
    <div className={`comments ${side ? "side" : ""}`} role={side ? "complementary" : "dialog"} aria-label="Comments">
      <div className="comments-head">
        <b>
          {data?.status === "ready"
            ? `${data.comments.length}${total && total > data.comments.length ? ` of ${count(total)}` : ""} comments`
            : "Comments"}
        </b>
        <button className="comments-close" onClick={onClose} aria-label="Close comments">✕</button>
      </div>
      <div className="comments-body">
        {!data && <p className="comments-note">Loading…</p>}
        {data?.status === "pending" && (
          <p className="comments-note">
            {data.solving
              ? "A window with TikTok's CAPTCHA is open on this computer. Solve it there; the comments appear here and the window closes by itself."
              : "Getting comments from TikTok… this takes up to half a minute."}
          </p>
        )}
        {data?.status === "unavailable" && (
          <div className="comments-note">
            <p>{UNAVAILABLE[data.reason] ?? UNAVAILABLE.error}</p>
            {!signedIn ? (
              <button className="btn" onClick={onSignIn}>Sign in to TikTok</button>
            ) : data.reason === "captcha" ? (
              <div className="actions">
                <button className="btn primary" onClick={() => load(true)}>Solve it in a window</button>
                <button className="btn ghost" onClick={() => load()}>Try again</button>
              </div>
            ) : (
              <button className="btn" onClick={() => load()}>Load comments</button>
            )}
          </div>
        )}
        {data?.status === "ready" && (
          <ul className="comment-list">
            {data.comments.map((c, i) => (
              <li key={i}>
                <p className="comment-user">{c.user}</p>
                <p className="comment-text">{c.text}</p>
                <p className="comment-meta">
                  {c.at ? new Date(c.at).toLocaleDateString([], { day: "numeric", month: "short" }) : ""}
                  {c.likes ? ` · ♥ ${count(c.likes)}` : ""}
                  {c.replies ? ` · ${count(c.replies)} ${c.replies === 1 ? "reply" : "replies"}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
        <a className="comments-open" href={item.url} target="_blank" rel="noopener noreferrer">Open on TikTok ↗</a>
      </div>
    </div>
  );
}
