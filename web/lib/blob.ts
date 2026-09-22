import { put, list } from "@vercel/blob";

/** User-facing text for a store-level outage. */
export const STORAGE_UNAVAILABLE_MESSAGE =
  "Storage is temporarily unavailable. Please try again shortly.";

/**
 * Raised when the Blob store itself is unreachable — suspended, blocked, or
 * pointed at by a bad token — as opposed to a single blob not existing.
 *
 * The distinction matters because the SDK resolves normally for an absent blob
 * (`list` returns an empty array), so a rejection always means the store, not
 * the object, is at fault. Reporting that as 404 tells the caller their
 * screenshot is gone when it is actually sitting safely in a blocked store.
 */
export class BlobUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Blob store unavailable", { cause });
    this.name = "BlobUnavailableError";
  }
}

/** Run a Blob SDK call, translating store-level failures into a typed error. */
async function blobOp<T>(label: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    console.error(`[blob] ${label} failed:`, err);
    throw new BlobUnavailableError(err);
  }
}

/** Look up a single blob by pathname. Returns null when it genuinely does not exist. */
export async function findBlob(pathname: string): Promise<{ url: string } | null> {
  const { blobs } = await blobOp(`list ${pathname}`, () =>
    list({ prefix: pathname, limit: 1 })
  );
  return blobs[0] ?? null;
}

/**
 * Fetch a blob's bytes with the store token. Callers still inspect the response
 * (for 206 range replies and the like); only store-level rejections throw.
 */
export async function fetchBlobContents(
  url: string,
  init?: RequestInit
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    console.error(`[blob] read ${url} failed:`, err);
    throw new BlobUnavailableError(err);
  }
  // A suspended or blocked store answers 403 here, and a bad token 401. Neither
  // means the blob is missing, so they must not collapse into a 404.
  if (res.status === 401 || res.status === 403) {
    console.error(`[blob] store rejected read of ${url} with ${res.status}`);
    throw new BlobUnavailableError(new Error(`store returned ${res.status}`));
  }
  return res;
}

export function getScreenshotUrl(id: string): string {
  return `/api/img/${id}`;
}

/** Persist the source URL a screenshot was captured from (e.g. a browser tab). */
export async function uploadSource(id: string, url: string): Promise<void> {
  await blobOp(`put sources/${id}.json`, () =>
    put(`sources/${id}.json`, JSON.stringify({ url }), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    })
  );
}

/**
 * Read the stored source URL for a screenshot, if any. Returns only http(s) URLs.
 *
 * Deliberately best-effort: this is decorative metadata rendered by the share
 * page, so a store outage degrades to "no source shown" rather than failing the
 * whole page render.
 */
export async function getSource(id: string): Promise<string | null> {
  try {
    const blob = await findBlob(`sources/${id}.json`);
    if (!blob) return null;
    const res = await fetchBlobContents(blob.url, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    const url = typeof data?.url === "string" ? data.url : null;
    return url && /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

export function getRecordingUrl(id: string): string {
  return `/api/vid/${id}`;
}

export async function uploadScreenshot(
  id: string,
  file: Blob
): Promise<{ url: string }> {
  const blob = await blobOp(`put screenshots/${id}.png`, () =>
    put(`screenshots/${id}.png`, file, {
      access: "private",
      addRandomSuffix: false,
      contentType: "image/png",
    })
  );
  return { url: blob.url };
}

export async function uploadRecording(
  id: string,
  file: Blob
): Promise<{ url: string }> {
  const blob = await blobOp(`put recordings/${id}.mp4`, () =>
    put(`recordings/${id}.mp4`, file, {
      access: "private",
      addRandomSuffix: false,
      contentType: "video/mp4",
    })
  );
  return { url: blob.url };
}
