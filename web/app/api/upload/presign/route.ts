import { nanoid } from "nanoid";
import { issueSignedToken, presignUrl } from "@vercel/blob";
import { STORAGE_UNAVAILABLE_MESSAGE } from "@/lib/blob";

export const runtime = "nodejs";

// Recordings can be large, so the desktop app uploads them directly to Blob
// via a presigned PUT URL (bypassing the 4.5 MB Function request-body limit).
const MAX_BYTES = 500 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function POST(req: Request) {
  let payload: unknown = {};
  try {
    payload = await req.json();
  } catch {
    // fall through — contentType defaults are validated below
  }

  const contentType =
    typeof payload === "object" &&
    payload !== null &&
    (payload as { contentType?: unknown }).contentType === "video/mp4"
      ? "video/mp4"
      : null;

  if (!contentType) {
    return Response.json(
      { error: "Unsupported content type" },
      { status: 400, headers: CORS }
    );
  }

  const id = nanoid();
  const pathname = `recordings/${id}.mp4`;

  let presignedUrl: string;
  try {
    const signed = await issueSignedToken({
      pathname,
      operations: ["put"],
      allowedContentTypes: [contentType],
      maximumSizeInBytes: MAX_BYTES,
    });

    ({ presignedUrl } = await presignUrl(
      {
        clientSigningToken: signed.clientSigningToken,
        delegationToken: signed.delegationToken,
      },
      {
        operation: "put",
        pathname,
        access: "private",
        allowedContentTypes: [contentType],
        maximumSizeInBytes: MAX_BYTES,
        addRandomSuffix: false,
        allowOverwrite: true,
      }
    ));
  } catch (err) {
    // Signing is a store operation, so a suspended store fails here rather than
    // on the client's subsequent PUT.
    console.error(`[presign] could not sign upload for ${pathname}:`, err);
    return Response.json(
      { error: STORAGE_UNAVAILABLE_MESSAGE },
      { status: 503, headers: CORS }
    );
  }

  return Response.json(
    { id, uploadUrl: presignedUrl, url: `/v/${id}` },
    { headers: CORS }
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
