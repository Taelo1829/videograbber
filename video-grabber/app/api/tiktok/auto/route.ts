import { NextResponse } from "next/server";
import { getAutoTikTok, startAutoTikTok } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The latest "refresh and download all" run: { running, startedAt, finishedAt?, queued?, error? }, or null. */
export async function GET() {
  return NextResponse.json(getAutoTikTok());
}

/** Scan TikTok explore on the server and queue every new video it finds. Returns at once; poll GET. */
export async function POST() {
  return NextResponse.json(startAutoTikTok());
}
