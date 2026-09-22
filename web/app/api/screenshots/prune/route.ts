import { NextRequest, NextResponse } from "next/server";
import {
  BlobUnavailableError,
  STORAGE_UNAVAILABLE_MESSAGE,
  deleteScreenshots,
  listScreenshots,
} from "@/lib/blob";

export const runtime = "nodejs";

const MAX_DAYS = 36500;

type Direction = "older" | "newer";

function parseBody(body: unknown): { days: number; direction: Direction; dryRun: boolean } | null {
  if (typeof body !== "object" || body === null) return null;
  const { days, direction, dryRun } = body as Record<string, unknown>;

  if (typeof days !== "number" || !Number.isFinite(days)) return null;
  const whole = Math.trunc(days);
  if (whole < 0 || whole > MAX_DAYS) return null;

  if (direction !== "older" && direction !== "newer") return null;

  return { days: whole, direction, dryRun: dryRun === true };
}

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const parsed = parseBody(raw);
  if (!parsed) {
    return NextResponse.json(
      { error: `Expected { days: 0-${MAX_DAYS}, direction: "older" | "newer" }` },
      { status: 400 }
    );
  }
  const { days, direction, dryRun } = parsed;

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  try {
    const all = await listScreenshots();
    const matched = all.filter((s) => {
      const t = Date.parse(s.uploadedAt);
      return direction === "older" ? t < cutoff : t >= cutoff;
    });
    const bytes = matched.reduce((sum, s) => sum + s.size, 0);

    // A preview pass so the caller can see the blast radius before committing.
    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        matched: matched.length,
        bytes,
        cutoff: new Date(cutoff).toISOString(),
      });
    }

    const result = await deleteScreenshots(matched.map((s) => s.id));
    return NextResponse.json({
      dryRun: false,
      matched: matched.length,
      deleted: result.deleted,
      bytes: result.bytes,
      cutoff: new Date(cutoff).toISOString(),
    });
  } catch (err) {
    if (err instanceof BlobUnavailableError) {
      return NextResponse.json(
        { error: STORAGE_UNAVAILABLE_MESSAGE },
        { status: 503 }
      );
    }
    throw err;
  }
}
