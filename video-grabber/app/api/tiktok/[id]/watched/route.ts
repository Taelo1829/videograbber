import { NextResponse } from "next/server";
import { markWatched } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Mark a TikTok as watched; its file is deleted an hour later. Returns the updated feed item. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const item = markWatched((await params).id);
  return item ? NextResponse.json(item) : NextResponse.json({ error: "Video not found." }, { status: 404 });
}
