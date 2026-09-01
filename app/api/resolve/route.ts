import { NextResponse } from "next/server";
import { matchSite } from "@/lib/live-site";

export const dynamic = "force-dynamic";

/**
 * Step 1 of the site input flow: propose a match, commit to nothing.
 * See lib/live-site.ts for why this is a separate step from /api/screen.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim();
  if (!query) {
    return NextResponse.json({ ok: false, stage: "input", message: "Enter a site and waterbody." }, { status: 400 });
  }
  const result = await matchSite(query);
  return NextResponse.json(result);
}
