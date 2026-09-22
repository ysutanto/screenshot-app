import { NextRequest, NextResponse } from "next/server";
import {
  BlobUnavailableError,
  STORAGE_UNAVAILABLE_MESSAGE,
  fetchBlobContents,
  findBlob,
} from "@/lib/blob";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import path from "path";
import type { ShapeData } from "@/lib/shapes";

export const runtime = "nodejs";

const STROKE_WIDTH = 3;
const FONT_FAMILY = "Roboto, sans-serif";
// Bundled font — Vercel's serverless runtime has no system fonts, so text in
// the SVG overlay would render blank without an explicitly loaded font. This
// path is force-included in the deployment via `outputFileTracingIncludes` in
// next.config.ts.
const FONT_PATH = path.join(process.cwd(), "assets/fonts/Roboto-Regular.ttf");

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === "<"
      ? "&lt;"
      : c === ">"
        ? "&gt;"
        : c === "&"
          ? "&amp;"
          : c === '"'
            ? "&quot;"
            : "&apos;"
  );
}

function shapesToSvg(shapes: ShapeData[], width: number, height: number): string {
  const parts = shapes.map((s) => {
    if (s.type === "rect") {
      return `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" fill="none" stroke="${escapeXml(s.stroke)}" stroke-width="${STROKE_WIDTH}" />`;
    }
    if (s.type === "circle") {
      return `<ellipse cx="${s.x}" cy="${s.y}" rx="${s.radiusX}" ry="${s.radiusY}" fill="none" stroke="${escapeXml(s.stroke)}" stroke-width="${STROKE_WIDTH}" />`;
    }
    // text — Konva positions (x, y) at the top-left; SVG <text> y is the baseline,
    // so offset each line by the font size (~0.8 for the ascent).
    const lines = (s.text ?? "").split("\n");
    const tspans = lines
      .map(
        (line, i) =>
          `<tspan x="${s.x}" y="${s.y + s.fontSize * (i + 0.8)}">${escapeXml(line)}</tspan>`
      )
      .join("");
    return `<text font-family="${FONT_FAMILY}" font-size="${s.fontSize}" fill="${escapeXml(s.fill)}">${tspans}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
}

// Store-level failures deliberately propagate: silently falling back to []
// would hand the user a clean PNG with their annotations quietly missing.
async function fetchBlobJson(prefix: string): Promise<ShapeData[]> {
  const blob = await findBlob(prefix);
  if (!blob) return [];
  const res = await fetchBlobContents(blob.url, { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const blob = await findBlob(`screenshots/${id}.png`);
    if (!blob) return new NextResponse("Not found", { status: 404 });

    const imgRes = await fetchBlobContents(blob.url);
    if (!imgRes.ok) return new NextResponse("Not found", { status: 404 });

    const pngBuffer = Buffer.from(await imgRes.arrayBuffer());
    const shapes = await fetchBlobJson(`annotations/${id}.json`);

    let out = pngBuffer;
    if (shapes.length) {
      const base = sharp(pngBuffer);
      const { width, height } = await base.metadata();
      const svg = shapesToSvg(shapes, width, height);
      // Rasterize the overlay with resvg using the bundled font, then composite.
      // (sharp's own SVG renderer relies on librsvg + system fonts, which Vercel
      // lacks, so text would silently render blank.)
      const overlay = new Resvg(svg, {
        fitTo: { mode: "original" },
        font: {
          fontFiles: [FONT_PATH],
          loadSystemFonts: false,
          defaultFontFamily: "Roboto",
          sansSerifFamily: "Roboto",
        },
      })
        .render()
        .asPng();
      out = await base
        .composite([{ input: overlay, top: 0, left: 0 }])
        .png()
        .toBuffer();
    }

    // Copy into a standalone, byteOffset-0 Uint8Array. sharp's toBuffer() can
    // return a Buffer that is a view into a larger pooled ArrayBuffer, which the
    // Vercel Node response adapter mishandles (UTF-8-decodes the bytes, turning
    // every byte >= 0x80 into U+FFFD and corrupting the PNG). A tight copy avoids it.
    const body = new Uint8Array(out);

    return new NextResponse(body, {
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${id}.png"`,
        "Cache-Control": "no-store",
      },
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
