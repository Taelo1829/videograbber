import { NextResponse } from "next/server";
import { tiktokFeed } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Downloaded TikToks still on disk, newest first: [{ id, title, at, watchedAt?, deletesAt? }]. */
export async function GET() {
  return NextResponse.json(tiktokFeed());
}
