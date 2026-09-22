import { put } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import {
  BlobUnavailableError,
  STORAGE_UNAVAILABLE_MESSAGE,
  fetchBlobContents,
  findBlob,
} from "@/lib/blob";

export const runtime = "nodejs";

function unavailable() {
  return NextResponse.json(
    { error: STORAGE_UNAVAILABLE_MESSAGE },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const blob = await findBlob(`annotations/${id}.json`);
    // A screenshot with no annotations yet is the normal case, not a failure.
    if (!blob) return NextResponse.json([]);

    const res = await fetchBlobContents(blob.url, { cache: "no-store" });
    if (!res.ok) return NextResponse.json([]);

    const data = await res.json();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    if (err instanceof BlobUnavailableError) {
      // Returning [] here would render as "your annotations were deleted".
      return unavailable();
    }
    throw err;
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let shapes: unknown;
  try {
    shapes = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (!Array.isArray(shapes)) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    await put(`annotations/${id}.json`, JSON.stringify(shapes), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
  } catch (err) {
    console.error(`[annotations] save failed for ${id}:`, err);
    return unavailable();
  }

  return NextResponse.json({ ok: true });
}
