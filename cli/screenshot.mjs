#!/usr/bin/env node
// Takes a screenshot, uploads it, and opens the annotation page.
// Usage:  node screenshot.mjs [--mode region|window|screen] [--url https://your-app.vercel.app]
//         SCREENSHOT_APP_URL=https://... node screenshot.mjs

import { execSync, spawnSync } from "child_process";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const urlFlagIdx = process.argv.indexOf("--url");
const BASE_URL =
  (urlFlagIdx !== -1 ? process.argv[urlFlagIdx + 1] : undefined) ??
  process.env.SCREENSHOT_APP_URL ??
  "https://actava-screenshot.vercel.app";

const modeFlagIdx = process.argv.indexOf("--mode");
const mode = (modeFlagIdx !== -1 ? process.argv[modeFlagIdx + 1] : undefined) ?? "region";

if (!["region", "window", "screen"].includes(mode)) {
  console.error(`Unknown mode "${mode}". Use: region, window, or screen.`);
  process.exit(1);
}

const TMP = join(tmpdir(), `screenshot-${Date.now()}.png`);

const modeLabels = { region: "Select a region", window: "Click a window", screen: "Capturing full screen" };
console.log(`${modeLabels[mode]}...`);

const args = ["-x"];
if (mode === "region") args.push("-i");
if (mode === "window") args.push("-i", "-w");
args.push(TMP);

const result = spawnSync("screencapture", args, { stdio: "inherit" });

if (result.status !== 0 || !existsSync(TMP)) {
  console.log("Cancelled.");
  process.exit(0);
}

const bytes = readFileSync(TMP);
unlinkSync(TMP);

console.log(`Uploading ${(bytes.length / 1024).toFixed(0)} KB...`);

const form = new FormData();
form.append("file", new Blob([bytes], { type: "image/png" }), "screenshot.png");

let pageUrl;
try {
  const res = await fetch(`${BASE_URL}/api/upload`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  ({ url: pageUrl } = await res.json());
} catch (err) {
  console.error("Upload failed:", err.message);
  process.exit(1);
}

const shareUrl = `${BASE_URL}${pageUrl}`;
console.log(`\nShare: ${shareUrl}\n`);
execSync(`open "${shareUrl}"`);
