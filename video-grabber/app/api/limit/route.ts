import { NextResponse } from "next/server";
import { cancelQueued, getLimit, resumeAfterCap, setCap } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** { capBytes, usedBytes, paused, waiting } */
export async function GET() {
  return NextResponse.json(getLimit());
}

/** Body: { capBytes: number | null } to set or clear the cap. */
export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { capBytes?: unknown } | null;
  const cap = body?.capBytes;
  if (cap !== null && (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0)) {
    return NextResponse.json({ error: "Set the cap to a number bigger than 0." }, { status: 400 });
  }
  setCap(cap);
  return NextResponse.json(getLimit());
}

/** Body: { action: "continue" } resumes with a fresh allowance; { action: "stop" } cancels what's queued. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action === "continue") resumeAfterCap();
  else if (body?.action === "stop") cancelQueued();
  else return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  return NextResponse.json(getLimit());
}
