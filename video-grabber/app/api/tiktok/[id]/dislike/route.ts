import { NextResponse } from "next/server";
import { dislikeTikTok, undislikeTikTok } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Dislike a TikTok: it leaves the feed now, its file is deleted shortly after, and it's never downloaded again. */
export async function POST(_req: Request, { params }: Ctx) {
  const ok = dislikeTikTok((await params).id);
  return ok ? NextResponse.json({ ok }) : NextResponse.json({ error: "Video not found." }, { status: 404 });
}

/** Undo a dislike, while the video's file is still there. Returns the feed item. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const item = undislikeTikTok((await params).id);
  return item ? NextResponse.json(item) : NextResponse.json({ error: "Too late: it's already been deleted." }, { status: 410 });
}
