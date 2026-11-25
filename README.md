# Video Frame Extractor

A self-hosted web app for pulling frames out of videos. Upload a clip, extract frames periodically or on scene changes, review them in a gallery, filter them with on-device AI analysis, and export the result as a ZIP or a new video.

## Features

- **Two extraction modes**
  - **Periodic (FPS):** sample frames at a fixed rate.
  - **Scene change:** keep only frames above an FFmpeg scene-score threshold.
- **Trim and resize:** start/end time, output width and height, PNG or JPG.
- **Job queue:** add multiple videos, streamed progress with frame count and ETA; jobs run one at a time.
- **Gallery:** lazy-loaded grid, adjustable grid size, lightbox with zoom and keyboard navigation, shift-click range selection, copy frame URL or filename.
- **AI analysis (in the browser):** brightness (luma) and face detection with TensorFlow.js BlazeFace in a Web Worker; filter frames by faces, brightness, or selection.
- **Exports**
  - Download all frames as a server-generated ZIP.
  - Download only the selected frames as a browser-generated ZIP.
  - Rebuild a video from the selected frames at a chosen frame rate.
- **Local storage:** uploads and outputs live under `public/uploads/<uuid>/` (gitignored).

## Requirements

- Node.js 20.9 or newer (Next.js 16)
- No system FFmpeg needed: `ffmpeg-static` downloads a platform binary during `npm install`

## Getting started

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

For a production build:

```bash
npm run build
npm start
```

## Usage

1. Select a video file and preview it.
2. Choose **Periodic** or **Scene** mode, set the time range, output size, and format.
3. Click **Add to Queue**; progress and ETA appear in the job list.
4. When a job completes, open it to browse frames. Optionally click **Analyze Content** for brightness/face metadata, then filter or select frames.
5. Download all frames, download the selection, or create a video from the selection.

## How it works

- `app/api/extract/route.ts` receives the upload, writes it to `public/uploads/<uuid>/`, runs FFmpeg (`fps` filter or `select='gt(scene,<threshold>)'`), streams NDJSON progress, and zips the extracted frames.
- `app/api/create-video/route.ts` builds an FFmpeg concat list from the chosen frames and encodes an H.264 (`yuv420p`) MP4 at the requested frame rate.
- `public/analysis.worker.js` loads TensorFlow.js and BlazeFace from a CDN inside a Web Worker, then computes luma brightness and face confidence per frame.

## Project structure

```
app/
  api/extract/route.ts       frame extraction + ZIP (FFmpeg)
  api/create-video/route.ts  video export from selected frames
  page.tsx                   upload form, job queue, gallery, lightbox
  layout.tsx, globals.css
public/
  analysis.worker.js         brightness + face detection worker
src/types.d.ts
```

## Tech stack

Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, FFmpeg via `fluent-ffmpeg` + `ffmpeg-static`, TensorFlow.js + BlazeFace, JSZip, FileSaver, Archiver.

## Notes and limitations

- This is a self-hosted demo: there is no authentication and uploads are never deleted automatically. Clean `public/uploads` periodically and do not expose it publicly as-is.
- `ffmpeg-static` covers common platforms/codecs; very large videos still consume disk and memory.
- The face model is fetched from a CDN at runtime; offline deployments need local copies.
- In scene mode, a lower threshold yields more frames.

## License

[MIT](LICENSE)
