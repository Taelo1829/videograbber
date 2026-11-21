"use client";

import { useEffect, useState } from "react";

export type GalleryItem = { url: string; title: string; thumb?: string; downloaded?: boolean };
export type Gallery = { title: string; items: GalleryItem[]; source: string };

/** A grid of videos found on a page, with checkboxes to pick which ones to download. */
export function GalleryPicker({
  gallery,
  heading,
  busy,
  onDownload,
  onClose,
  onRefresh,
  compact,
}: {
  gallery: Gallery;
  heading: string;
  busy: boolean;
  onDownload: (items: GalleryItem[]) => Promise<void>;
  onClose?: () => void;
  onRefresh?: () => void;
  /** Shorter grid, for when the list sits above other content. */
  compact?: boolean;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Started from this list; they can't be picked again.
  const [started, setStarted] = useState<Set<string>>(new Set());
  useEffect(() => { setPicked(new Set()); setStarted(new Set()); }, [gallery]);

  const isDone = (it: GalleryItem) => it.downloaded || started.has(it.url);
  const open = gallery.items.filter((i) => !isDone(i));

  function toggle(u: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(u)) next.delete(u); else next.add(u);
      return next;
    });
  }

  async function download() {
    const items = gallery.items.filter((i) => picked.has(i.url));
    try { await onDownload(items); } catch { return; } // the page shows the error; keep the ticks
    setStarted((prev) => new Set([...prev, ...items.map((i) => i.url)]));
    setPicked(new Set());
  }

  return (
    <section className="panel gallery" aria-label="Videos on this page">
      <div className="gallery-head">
        <div>
          <h2>{heading}</h2>
          <p className="url">{gallery.title || gallery.source}</p>
        </div>
        <div className="actions">
          <button className="btn ghost" disabled={!open.length} onClick={() => setPicked(picked.size === open.length ? new Set() : new Set(open.map((i) => i.url)))}>
            {picked.size && picked.size === open.length ? "Clear" : "Select all"}
          </button>
          <button className="btn primary" disabled={!picked.size || busy} onClick={download}>
            Download {picked.size || ""} selected
          </button>
          {onRefresh && <button className="btn ghost" onClick={onRefresh}>Refresh</button>}
          {onClose && <button className="btn ghost" onClick={onClose} aria-label="Close list">Close</button>}
        </div>
      </div>
      <ul className={`grid ${compact ? "compact" : ""}`}>
        {gallery.items.map((it) => (
          <li key={it.url}>
            <label className={`tile ${picked.has(it.url) ? "on" : ""} ${isDone(it) ? "had" : ""}`}>
              <input type="checkbox" checked={picked.has(it.url)} disabled={isDone(it)} onChange={() => toggle(it.url)} />
              <span className="thumb">
                {it.thumb ? <img src={it.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" /> : null}
                {isDone(it) && <span className="had-badge">{it.downloaded ? "Downloaded" : "Added"}</span>}
              </span>
              <span className="tile-title">{it.title}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
