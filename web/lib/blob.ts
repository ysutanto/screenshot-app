import { put, list, del } from "@vercel/blob";

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

export type ScreenshotSummary = {
  id: string;
  uploadedAt: string;
  size: number;
};

/** Page through a prefix, collecting every blob (the SDK caps a page at 1000). */
async function listAll(prefix: string) {
  const out: { pathname: string; url: string; size: number; uploadedAt: Date }[] = [];
  let cursor: string | undefined;
  do {
    const res = await blobOp(`list ${prefix}`, () =>
      list({ prefix, limit: 1000, cursor })
    );
    out.push(...res.blobs);
    cursor = res.cursor;
  } while (cursor);
  return out;
}

function idFromPathname(pathname: string, prefix: string): string {
  return pathname.slice(prefix.length).replace(/\.(png|json)$/, "");
}

/** Every stored screenshot, newest first. */
export async function listScreenshots(): Promise<ScreenshotSummary[]> {
  const blobs = await listAll("screenshots/");
  return blobs
    .map((b) => ({
      id: idFromPathname(b.pathname, "screenshots/"),
      uploadedAt: new Date(b.uploadedAt).toISOString(),
      size: b.size,
    }))
    .filter((s) => s.id)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

/**
 * Delete the given screenshots along with the annotation and source metadata
 * belonging to them, so a prune never leaves orphaned records behind.
 */
export async function deleteScreenshots(
  ids: string[]
): Promise<{ deleted: number; bytes: number }> {
  if (!ids.length) return { deleted: 0, bytes: 0 };
  const wanted = new Set(ids);

  const targets: { url: string; size: number; isScreenshot: boolean }[] = [];
  for (const prefix of ["screenshots/", "annotations/", "sources/"] as const) {
    for (const b of await listAll(prefix)) {
      if (wanted.has(idFromPathname(b.pathname, prefix))) {
        targets.push({
          url: b.url,
          size: b.size,
          isScreenshot: prefix === "screenshots/",
        });
      }
    }
  }

  let deleted = 0;
  let bytes = 0;
  // The delete API takes a batch of urls; keep batches modest so one failure
  // does not strand a very large prune.
  for (let i = 0; i < targets.length; i += 100) {
    const batch = targets.slice(i, i + 100);
    await blobOp("delete batch", () => del(batch.map((t) => t.url)));
    for (const t of batch) {
      bytes += t.size;
      if (t.isScreenshot) deleted++;
    }
  }
  return { deleted, bytes };
}
