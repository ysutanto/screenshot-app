"use client";

import { useState } from "react";

type Screenshot = { id: string; uploadedAt: string; size: number };
type Direction = "older" | "newer";
type Preview = { matched: number; bytes: number; cutoff: string };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function ScreenshotBrowser({
  initialScreenshots,
  initialBytes,
  initialError,
}: {
  initialScreenshots: Screenshot[];
  initialBytes: number;
  initialError: string | null;
}) {
  // Seeded from the server render, so there is no fetch-on-mount effect and no
  // loading flash; refreshes happen from event handlers after a delete.
  const [screenshots, setScreenshots] = useState<Screenshot[]>(initialScreenshots);
  const [bytes, setBytes] = useState(initialBytes);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    initialError ? "error" : "ready"
  );
  const [error, setError] = useState<string | null>(initialError);

  const [days, setDays] = useState(90);
  const [direction, setDirection] = useState<Direction>("older");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/screenshots", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
      setScreenshots(data.screenshots ?? []);
      setBytes(data.bytes ?? 0);
      setStatus("ready");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load screenshots");
      setStatus("error");
    }
  }

  // Any change to the window invalidates a preview taken against the old one.
  function updateWindow(nextDays: number, nextDirection: Direction) {
    setDays(nextDays);
    setDirection(nextDirection);
    setPreview(null);
    setConfirming(false);
    setResult(null);
  }

  async function prune(dryRun: boolean) {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/screenshots/prune", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days, direction, dryRun }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);

      if (dryRun) {
        setPreview({ matched: data.matched, bytes: data.bytes, cutoff: data.cutoff });
        setConfirming(false);
      } else {
        setResult(
          data.deleted === 0
            ? "Nothing matched — nothing deleted."
            : `Deleted ${data.deleted} screenshot${data.deleted === 1 ? "" : "s"} (${formatBytes(data.bytes)}).`
        );
        setPreview(null);
        setConfirming(false);
        await load();
      }
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            ScreenCapture
          </h1>
          <p className="mt-1 text-sm text-neutral-400">
            {status === "ready"
              ? `${screenshots.length} screenshot${screenshots.length === 1 ? "" : "s"} · ${formatBytes(bytes)}`
              : status === "loading"
                ? "Loading…"
                : "Unavailable"}
          </p>
        </div>
        <a
          href="https://github.com/yudiks/screenshot-app"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-neutral-400 underline underline-offset-4 transition-colors hover:text-white"
        >
          Download the Mac app
        </a>
      </header>

      <section className="mb-10 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
        <h2 className="text-sm font-medium text-white">Bulk delete</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-neutral-400">Delete screenshots</span>
          <select
            value={direction}
            onChange={(e) => updateWindow(days, e.target.value as Direction)}
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-white"
          >
            <option value="older">older than</option>
            <option value="newer">from the past</option>
          </select>
          <input
            type="number"
            min={0}
            max={36500}
            value={days}
            onChange={(e) => updateWindow(Number(e.target.value), direction)}
            className="w-24 rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-white"
          />
          <span className="text-neutral-400">days</span>
          <button
            onClick={() => prune(true)}
            disabled={busy || status !== "ready"}
            className="ml-auto rounded bg-neutral-700 px-3 py-1.5 font-medium text-white transition-colors hover:bg-neutral-600 disabled:opacity-40"
          >
            {busy && !confirming ? "Checking…" : "Preview"}
          </button>
        </div>

        {preview && (
          <div className="mt-4 rounded border border-neutral-700 bg-neutral-950 p-3 text-sm">
            <p className="text-neutral-300">
              <span className="font-medium text-white">{preview.matched}</span>{" "}
              screenshot{preview.matched === 1 ? "" : "s"} match ({formatBytes(preview.bytes)}) —{" "}
              {direction === "older" ? "uploaded before" : "uploaded since"}{" "}
              {formatDate(preview.cutoff)}.
            </p>
            {preview.matched > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {!confirming ? (
                  <button
                    onClick={() => setConfirming(true)}
                    className="rounded bg-red-900 px-3 py-1.5 font-medium text-red-100 transition-colors hover:bg-red-800"
                  >
                    Delete {preview.matched}…
                  </button>
                ) : (
                  <>
                    <span className="text-red-300">
                      Permanently delete {preview.matched} screenshot
                      {preview.matched === 1 ? "" : "s"} and their annotations? This cannot be undone.
                    </span>
                    <button
                      onClick={() => prune(false)}
                      disabled={busy}
                      className="rounded bg-red-700 px-3 py-1.5 font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-40"
                    >
                      {busy ? "Deleting…" : "Yes, delete"}
                    </button>
                    <button
                      onClick={() => setConfirming(false)}
                      disabled={busy}
                      className="rounded border border-neutral-700 px-3 py-1.5 text-neutral-300 transition-colors hover:bg-neutral-800 disabled:opacity-40"
                    >
                      Cancel
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {result && <p className="mt-3 text-sm text-neutral-300">{result}</p>}
      </section>

      {status === "error" && (
        <p className="text-sm text-red-300">{error}</p>
      )}

      {status === "ready" && screenshots.length === 0 && (
        <p className="text-sm text-neutral-400">
          No screenshots yet. Capture one with the Mac app or the CLI.
        </p>
      )}

      {status === "ready" && screenshots.length > 0 && (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {screenshots.map((s) => (
            <li key={s.id}>
              <a
                href={`/s/${s.id}`}
                className="group block overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 transition-colors hover:border-neutral-600"
              >
                <div className="aspect-video overflow-hidden bg-neutral-950">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/img/${s.id}`}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-contain"
                  />
                </div>
                <div className="px-3 py-2">
                  <p className="truncate text-xs text-neutral-300 group-hover:text-white">
                    {formatDate(s.uploadedAt)}
                  </p>
                  <p className="text-xs text-neutral-500">{formatBytes(s.size)}</p>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
