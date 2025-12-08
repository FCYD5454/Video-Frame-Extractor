import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import archiver from "archiver";

// Helper function to resolve FFmpeg path reliably
function getFfmpegPath() {
  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    return ffmpegPath;
  }
  const platform = process.platform;
  const ext = platform === 'win32' ? '.exe' : '';
  const pathsToCheck = [
    path.join(process.cwd(), 'node_modules', 'ffmpeg-static', `ffmpeg${ext}`),
    path.join(process.cwd(), '..', 'node_modules', 'ffmpeg-static', `ffmpeg${ext}`),
  ];
  for (const p of pathsToCheck) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

const resolvedFfmpegPath = getFfmpegPath();

if (resolvedFfmpegPath) {
  ffmpeg.setFfmpegPath(resolvedFfmpegPath);
} else {
  console.error("CRITICAL: FFmpeg binary not found.");
}

// Helper to write JSON line to stream
const sendJson = (writer: WritableStreamDefaultWriter, data: any) => {
  const encoder = new TextEncoder();
  writer.write(encoder.encode(JSON.stringify(data) + "\n"));
};

export async function POST(req: NextRequest) {
  const requestId = uuidv4();
  const uploadDir = path.join(process.cwd(), "public", "uploads", requestId);
  
  // Set up streaming response
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  
  const processVideo = async () => {
    try {
      if (!resolvedFfmpegPath) {
        throw new Error("FFmpeg binary not found on server.");
      }

      // 1. Parse Form Data
      const formData = await req.formData();
      const videoFile = formData.get("video") as File;
      const mode = (formData.get("mode") as "fps" | "scene") || "fps";
      const fps = parseFloat(formData.get("fps") as string) || 1;
      const threshold = parseFloat(formData.get("threshold") as string) || 0.3;
      
      const startTime = parseFloat(formData.get("startTime") as string) || 0;
      const endTime = parseFloat(formData.get("endTime") as string) || 10;
      const width = parseInt(formData.get("width") as string) || 1920;
      const height = parseInt(formData.get("height") as string) || 1080;
      const format = (formData.get("format") as string) || "jpg";

      if (!videoFile) {
        sendJson(writer, { type: "error", error: "No video file provided" });
        await writer.close();
        return;
      }

      // 2. Prepare Directories
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      // 3. Save Video File
      const videoBuffer = Buffer.from(await videoFile.arrayBuffer());
      const videoPath = path.join(uploadDir, `input_${videoFile.name}`);
      fs.writeFileSync(videoPath, videoBuffer);
      
      sendJson(writer, { type: "progress", percent: 0, frames: 0 }); // Started

      // 4. Run FFmpeg Extraction
      const outputPattern = path.join(uploadDir, `frame_%04d.${format}`);
      const duration = endTime - startTime;
      if (duration <= 0) {
        throw new Error("End time must be greater than start time");
      }

      console.log(`Starting extraction (${mode}): ${videoPath} -> ${outputPattern}`);

      await new Promise<void>((resolve, reject) => {
        let command = ffmpeg(videoPath)
          .setStartTime(startTime)
          .setDuration(duration)
          .size(`${width}x${height}`);

        if (mode === 'scene') {
           // Scene Change Mode
           command
             .outputOptions([
               `-vf select='gt(scene,${threshold})',metadata=print`, 
               '-vsync vfr'
             ]);
        } else {
           // Standard FPS Mode
           command.fps(fps);
        }

        command
          .output(outputPattern)
          .on("progress", (progress) => {
            // Send both percent and processed frames count
            // progress.frames is the number of frames processed so far
            if (progress.percent || progress.frames) {
               sendJson(writer, { 
                 type: "progress", 
                 percent: progress.percent || 0,
                 frames: progress.frames || 0 
               });
            }
          })
          .on("end", () => {
            sendJson(writer, { type: "progress", percent: 100 });
            resolve();
          })
          .on("error", (err) => {
            console.error("Error during extraction:", err);
            reject(err);
          })
          .run();
      });

      // 5. Collect Result Files
      const files = fs.readdirSync(uploadDir)
        .filter(f => f.startsWith("frame_") && f.endsWith(`.${format}`))
        .sort((a, b) => {
          const numA = parseInt(a.match(/\d+/)?.[0] || "0");
          const numB = parseInt(b.match(/\d+/)?.[0] || "0");
          return numA - numB;
        });
      
      const fileUrls = files.map(f => `/uploads/${requestId}/${f}`);

      // 6. Create ZIP
      const zipName = "frames.zip";
      const zipPath = path.join(uploadDir, zipName);
      const outputZip = fs.createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      await new Promise<void>((resolve, reject) => {
        outputZip.on("close", resolve);
        archive.on("error", reject);
        
        archive.pipe(outputZip);
        
        files.forEach(file => {
          archive.file(path.join(uploadDir, file), { name: file });
        });
        
        archive.finalize();
      });

      // 7. Send Completion
      sendJson(writer, {
        type: "complete",
        message: `Extracted ${files.length} frames successfully.`,
        data: {
          count: files.length,
          frames: fileUrls,
          zipUrl: `/uploads/${requestId}/${zipName}`,
          directory: requestId
        }
      });

    } catch (error: any) {
      console.error("API Error:", error);
      sendJson(writer, { type: "error", error: error.message || "Internal Server Error" });
    } finally {
      await writer.close();
    }
  };

  // Start processing
  processVideo();

  return new NextResponse(stream.readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
