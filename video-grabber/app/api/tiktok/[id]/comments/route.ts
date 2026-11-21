import { NextResponse } from "next/server";
import { getComments, loadComments, solveCommentsFor } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** { status: "ready", comments: [...], total } or { status: "pending" | "unavailable", reason? }. */
export async function GET(_req: Request, { params }: Ctx) {
  const c = getComments((await params).id);
  return c ? NextResponse.json(c) : NextResponse.json({ error: "Video not found." }, { status: 404 });
}

/**
 * Fetch (or re-fetch) a TikTok's comments in the background. Body { solve: true } instead opens a window
 * on this computer where the user solves TikTok's CAPTCHA themselves, then saves the comments.
 */
export async function POST(req: Request, { params }: Ctx) {
  const body = (await req.json().catch(() => null)) as { solve?: unknown } | null;
  const id = (await params).id;
  const c = body?.solve === true ? solveCommentsFor(id) : loadComments(id);
  return c ? NextResponse.json(c) : NextResponse.json({ error: "Video not found." }, { status: 404 });
}
