import { NextResponse } from "next/server";
import { cancelJob, getJob, removeJob, toPublic } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const job = getJob((await params).id);
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  return NextResponse.json(toPublic(job));
}

/** POST = cancel (keeps it in the list); DELETE = cancel and remove from the list. */
export async function POST(_req: Request, { params }: Ctx) {
  const ok = cancelJob((await params).id);
  return ok ? NextResponse.json({ ok }) : NextResponse.json({ error: "Job not found." }, { status: 404 });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const ok = removeJob((await params).id);
  return ok ? NextResponse.json({ ok }) : NextResponse.json({ error: "Job not found." }, { status: 404 });
}
