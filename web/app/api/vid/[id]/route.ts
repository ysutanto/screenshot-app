import { NextRequest, NextResponse } from "next/server";
import {
  BlobUnavailableError,
  STORAGE_UNAVAILABLE_MESSAGE,
  fetchBlobContents,
  findBlob,
} from "@/lib/blob";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const blob = await findBlob(`recordings/${id}.mp4`);
    if (!blob) return new NextResponse("Not found", { status: 404 });

    // Forward the client's Range header so the browser can seek within the video.
    const range = req.headers.get("range");
    const upstream = await fetchBlobContents(
      blob.url,
      range ? { headers: { Range: range } } : undefined
    );
    if (!upstream.ok && upstream.status !== 206) {
      return new NextResponse("Not found", { status: 404 });
    }

    const headers = new Headers();
    headers.set("Content-Type", "video/mp4");
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    for (const h of ["content-length", "content-range"]) {
      const value = upstream.headers.get(h);
      if (value) headers.set(h, value);
    }

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch (err) {
    if (err instanceof BlobUnavailableError) {
      return new NextResponse(STORAGE_UNAVAILABLE_MESSAGE, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
    throw err;
  }
}
