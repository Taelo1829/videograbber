import { NextResponse } from "next/server";
import { getWantNew, MAX_WANT_NEW, setWantNew } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** { wantNew, max }: how many new videos each TikTok search looks for. */
export async function GET() {
  return NextResponse.json({ wantNew: getWantNew(), max: MAX_WANT_NEW });
}

/** Body: { wantNew: number } (1 to 500). */
export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { wantNew?: unknown } | null;
  const n = body?.wantNew;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 1) {
    return NextResponse.json({ error: "Enter how many videos to look for: 1 or more." }, { status: 400 });
  }
  return NextResponse.json({ wantNew: setWantNew(n), max: MAX_WANT_NEW });
}
