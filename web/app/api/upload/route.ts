import { nanoid } from "nanoid";
import {
  BlobUnavailableError,
  STORAGE_UNAVAILABLE_MESSAGE,
  uploadScreenshot,
  uploadSource,
} from "@/lib/blob";

export const runtime = "nodejs";

const MAX_BYTES = 15 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Missing file" }, { status: 400, headers: CORS });
  }
  const file = form.get("file");

  if (!(file instanceof Blob) || file.size === 0) {
    return Response.json({ error: "Missing file" }, { status: 400, headers: CORS });
  }
  if (file.type !== "image/png") {
    return Response.json({ error: "File must be a PNG" }, { status: 400, headers: CORS });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "File too large" }, { status: 400, headers: CORS });
  }

  const id = nanoid();
  let blobUrl: string;
  try {
    ({ url: blobUrl } = await uploadScreenshot(id, file));
  } catch (err) {
    if (err instanceof BlobUnavailableError) {
      return Response.json(
        { error: STORAGE_UNAVAILABLE_MESSAGE },
        { status: 503, headers: CORS }
      );
    }
    throw err;
  }

  // Optional source URL (e.g. the browser tab a window was captured from).
  // Best-effort: the screenshot is already stored, so losing this metadata must
  // not fail the upload and leave the caller without its id.
  const sourceUrl = form.get("sourceUrl");
  if (typeof sourceUrl === "string" && /^https?:\/\//i.test(sourceUrl)) {
    try {
      await uploadSource(id, sourceUrl);
    } catch (err) {
      console.error(`[upload] source URL not stored for ${id}:`, err);
    }
  }

  return Response.json({ id, url: `/s/${id}`, blobUrl }, { headers: CORS });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
