import { NextResponse } from "next/server";
import { openSignIn, signInStatus, signOut } from "@/lib/tiktok-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** { signedIn, signingIn } */
export async function GET() {
  return NextResponse.json(signInStatus());
}

/** Opens a browser window on this computer at TikTok's sign-in page. */
export async function POST() {
  try {
    await openSignIn();
    return NextResponse.json(signInStatus());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message.split("\n")[0] : String(err) }, { status: 500 });
  }
}

/** Signs the app out of TikTok (clears TikTok's cookies from its browser profile). */
export async function DELETE() {
  try {
    await signOut();
    return NextResponse.json(signInStatus());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message.split("\n")[0] : String(err) }, { status: 500 });
  }
}
