import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { tiktokFile } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime" };

/** Streams a TikTok for the in-app player. Supports Range requests so the video can seek and start fast. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const file = tiktokFile((await params).id);
  if (!file) return new Response("Video not found.", { status: 404 });

  const size = fs.statSync(file).size;
  const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);

  if (!range) {
    return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
      headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes" },
    });
  }

  // "bytes=500-" means to the end; "bytes=-500" means the last 500 bytes.
  let start = range[1] ? Number(range[1]) : size - Number(range[2]);
  let end = range[1] && range[2] ? Number(range[2]) : size - 1;
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });

  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream, {
    status: 206,
    headers: {
      "Content-Type": type,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
    },
  });
}
