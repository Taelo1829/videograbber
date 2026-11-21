import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { DOWNLOAD_DIR, getJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska", ".mov": "video/quicktime", ".m4a": "audio/mp4",
};

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = getJob((await params).id);
  if (!job || job.status !== "done" || !job.filePath) return new Response("File not ready.", { status: 404 });

  // Only ever serve files from the downloads folder.
  const resolved = path.resolve(job.filePath);
  if (!resolved.startsWith(DOWNLOAD_DIR + path.sep) || !fs.existsSync(resolved)) {
    return new Response("File not found.", { status: 404 });
  }

  const name = path.basename(resolved);
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  const stream = Readable.toWeb(fs.createReadStream(resolved)) as ReadableStream;

  return new Response(stream, {
    headers: {
      "Content-Type": TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": String(fs.statSync(resolved).size),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });
}
