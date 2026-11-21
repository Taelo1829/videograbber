import { NextResponse } from "next/server";
import { importCookies, signInStatus } from "@/lib/tiktok-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Body: the text of a cookies.txt or JSON cookie export. Signs the app in to TikTok with it. */
export async function POST(req: Request) {
  const text = await req.text();
  if (!text.trim()) return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  if (text.length > 1_000_000) return NextResponse.json({ error: "That file is too big to be a cookie export." }, { status: 400 });
  try {
    const { count } = await importCookies(text);
    return NextResponse.json({ ...signInStatus(), imported: count });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message.split("\n")[0] : String(err) }, { status: 400 });
  }
}
