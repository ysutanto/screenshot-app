# Screenshot App

Capture a screen region on Mac, get a shareable link instantly, and annotate with rectangles, circles, and text — right in the browser.

**Live:** https://actava-screenshot.vercel.app

## Demo

![ScreenCapture demo](https://github.com/yudiks/screenshot-app/releases/download/v0.4.0/demo.gif)

---

## Download the Mac App

1. Go to the [Releases page](https://github.com/yudiks/screenshot-app/releases) and download the latest `.dmg`.
2. Open the `.dmg`, drag **ScreenCapture** into Applications.
3. Launch the app.
4. Press **⌘⇧9** or click **Capture Now** — drag to select a region and the annotation page opens automatically.

> **macOS security warning:** The app is not code-signed, so macOS may say it's "damaged". Run this once in Terminal after installing:
> ```bash
> xattr -cr /Applications/ScreenCapture.app
> ```

### Build from source

Requires [Rust](https://rustup.rs) and Node.js 18+.

```bash
cd desktop
npm install
npm run tauri build
# .app and .dmg appear in src-tauri/target/release/bundle/
```

---

## CLI

No app install needed — just Node.js 18+.

```bash
# Run once without installing
node cli/screenshot.mjs

# Or point at your own deployment
node cli/screenshot.mjs --url https://your-app.vercel.app
SCREENSHOT_APP_URL=https://your-app.vercel.app node cli/screenshot.mjs
```

Steps: drag-select a region → uploads → prints the URL → opens the annotation page in your browser.

---

## Annotation tools

| Tool | How |
|------|-----|
| Rectangle | Drag to draw |
| Circle | Drag to draw |
| Text | Click to place, **double-click to edit** |
| Select | Click to move/resize, drag handles to scale |
| Color | Pick from toolbar |
| Export | Download annotated PNG |
| Share | Copy link — anyone with it can view and annotate |

---

## Self-host

```bash
cd web
npm install
vercel deploy --prod
```

Requires a `BLOB_READ_WRITE_TOKEN` env var from a [Vercel Blob](https://vercel.com/docs/vercel-blob) store.

Point the desktop app at your deployment at build time:

```bash
UPLOAD_API_BASE=https://your-app.vercel.app npm run tauri build
```

---

## Architecture

```
[Desktop app / CLI]
        │  screencapture -i  (macOS region picker)
        │  POST /api/upload  (multipart PNG)
        ▼
[Next.js on Vercel]  →  Vercel Blob (private)
        │
        │  /s/<id>  opened in browser
        ▼
[Annotation page]  →  /api/img/<id> (server proxy)  →  Konva.js canvas
```
