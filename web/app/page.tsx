import ScreenshotBrowser from "@/components/ScreenshotBrowser";
import {
  BlobUnavailableError,
  STORAGE_UNAVAILABLE_MESSAGE,
  listScreenshots,
  type ScreenshotSummary,
} from "@/lib/blob";

// The listing reflects live store contents, so it must not be cached.
export const dynamic = "force-dynamic";

export default async function Home() {
  let screenshots: ScreenshotSummary[] = [];
  let error: string | null = null;
  try {
    screenshots = await listScreenshots();
  } catch (err) {
    if (!(err instanceof BlobUnavailableError)) throw err;
    error = STORAGE_UNAVAILABLE_MESSAGE;
  }

  return (
    <main className="min-h-screen bg-neutral-950">
      <ScreenshotBrowser
        initialScreenshots={screenshots}
        initialBytes={screenshots.reduce((sum, s) => sum + s.size, 0)}
        initialError={error}
      />
    </main>
  );
}
