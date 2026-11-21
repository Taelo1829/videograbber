import { NextResponse } from "next/server";
import { createJob, duplicateReason, listJobs, toPublic } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(listJobs().map(toPublic));
}

type Item = { url?: unknown; title?: unknown };

function parseUrl(input: unknown): URL | null {
  if (typeof input !== "string") return null;
  try {
    const url = new URL(input.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Body: { url, title? } for one video, or { items: [{ url, title? }, …] } for several.
 * Links downloaded before (or downloading now) are skipped; a batch returns only the jobs it started.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as (Item & { items?: Item[] }) | null;
  const items: Item[] = Array.isArray(body?.items) ? body!.items.slice(0, 100) : body ? [body] : [];
  if (!items.length) return NextResponse.json({ error: "Paste a link first." }, { status: 400 });

  const fresh: { url: string; title?: string }[] = [];
  let lastReason = "";
  for (const it of items) {
    const url = parseUrl(it.url);
    if (!url) {
      return NextResponse.json({ error: "That doesn't look like a link. Paste the full address, starting with https://" }, { status: 400 });
    }
    const reason = duplicateReason(url.href) ?? (fresh.some((f) => f.url === url.href) ? "already in this batch" : undefined);
    if (reason) { lastReason = reason; continue; }
    const title = typeof it.title === "string" && it.title.trim() ? it.title.trim().slice(0, 140) : undefined;
    fresh.push({ url: url.href, title });
  }
  if (!fresh.length) {
    const error = items.length === 1
      ? `Skipped: this video is ${lastReason}.`
      : "Skipped: you've already downloaded all of these videos.";
    return NextResponse.json({ error }, { status: 409 });
  }

  const created = fresh.map((f) => toPublic(createJob(f.url, f.title)));
  return NextResponse.json(Array.isArray(body?.items) ? created : created[0], { status: 201 });
}
