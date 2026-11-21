import { NextResponse } from "next/server";
import { getSchedule, setSchedule } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** { start, end, open } — "HH:MM" each day (nulls = any time); `open` says whether downloads may run now. */
export async function GET() {
  return NextResponse.json(getSchedule());
}

/** Body: { start: "HH:MM", end: "HH:MM" } to set the daily window, or { start: null, end: null } to clear it. */
export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { start?: unknown; end?: unknown } | null;
  const hhmm = (v: unknown) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  const clear = body?.start === null && body?.end === null;
  if (!clear && !(hhmm(body?.start) && hhmm(body?.end) && body!.start !== body!.end)) {
    return NextResponse.json({ error: "Pick a start and a stop time that aren't the same." }, { status: 400 });
  }
  setSchedule(clear ? null : (body!.start as string), clear ? null : (body!.end as string));
  return NextResponse.json(getSchedule());
}
