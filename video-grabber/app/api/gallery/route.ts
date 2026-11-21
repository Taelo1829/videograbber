import { NextResponse } from "next/server";
import { scanGallery } from "@/lib/browser";
import { downloadedLinks, findNewTikToks, TIKTOK_EXPLORE } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A TikTok search for many new videos can take several minutes.
export const maxDuration = 1800;

/**
 * Body: { url, onlyNew? } of a thumbnails page. Returns { title, items: [{ url, title, thumb, downloaded }] }.
 * With onlyNew, it scrolls further until it finds videos that weren't downloaded before, and returns only those.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { url?: unknown; onlyNew?: unknown } | null;
  const onlyNew = body?.onlyNew === true;
  let url: URL;
  try {
    url = new URL(typeof body?.url === "string" ? body.url.trim() : "");
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    return NextResponse.json({ error: "That doesn't look like a link. Paste the full address, starting with https://" }, { status: 400 });
  }

  try {
    // TikTok explore: keep searching until the number set in the settings is found. Finding none is an answer, not an error.
    if (onlyNew && url.href === TIKTOK_EXPLORE) return NextResponse.json(await findNewTikToks());

    const known = (u: string) => downloadedLinks([u]).length > 0;
    const result = await scanGallery(url.href, onlyNew ? { skip: known, want: 30 } : {});
    if (!result.items.length) {
      return NextResponse.json(
        { error: "Couldn't spot a grid of video thumbnails on that page. If it's a single video, use Download instead; otherwise add a thumbnail selector for this site in recipes.json." },
        { status: 404 },
      );
    }
    const done = new Set(downloadedLinks(result.items.map((i) => i.url)));
    const items = result.items.map((i) => ({ ...i, downloaded: done.has(i.url) }));
    return NextResponse.json({ ...result, items: onlyNew ? items.filter((i) => !i.downloaded) : items });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
