import { NextRequest, NextResponse } from "next/server";
import {
  BlobUnavailableError,
  STORAGE_UNAVAILABLE_MESSAGE,
  fetchBlobContents,
  findBlob,
} from "@/lib/blob";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const blob = await findBlob(`screenshots/${id}.png`);
    if (!blob) return new NextResponse("Not found", { status: 404 });

    const res = await fetchBlobContents(blob.url);
    if (!res.ok) return new NextResponse("Not found", { status: 404 });

    return new NextResponse(res.body, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    if (err instanceof BlobUnavailableError) {
      // no-store matters here: the success path is cached immutably for a year,
      // so a cached outage would outlive the outage itself.
      return new NextResponse(STORAGE_UNAVAILABLE_MESSAGE, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
    throw err;
  }
}
