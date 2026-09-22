import { NextResponse } from "next/server";
import {
  BlobUnavailableError,
  STORAGE_UNAVAILABLE_MESSAGE,
  listScreenshots,
} from "@/lib/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const screenshots = await listScreenshots();
    const bytes = screenshots.reduce((sum, s) => sum + s.size, 0);
    return NextResponse.json(
      { screenshots, count: screenshots.length, bytes },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    if (err instanceof BlobUnavailableError) {
      return NextResponse.json(
        { error: STORAGE_UNAVAILABLE_MESSAGE },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
    throw err;
  }
}
