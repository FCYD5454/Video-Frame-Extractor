import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

// Reuse path resolution helper (or move to shared util in real app)
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
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { jobId, frames, fps } = body; // frames is array of relative URLs

    // Ensure we are looking in the same root as extract route
    // The previous extract route used: path.join(process.cwd(), "public", "uploads", requestId)
    // Here we should do the same.
    // However, client sends jobId which IS the requestId (folder name)
    
    if (!jobId || !frames || !Array.isArray(frames) || frames.length === 0) {
      return NextResponse.json({ error: "Invalid request data" }, { status: 400 });
    }

    const uploadDir = path.join(process.cwd(), "public", "uploads", jobId);
    
    // Debug logging
    console.log(`Checking for job directory: ${uploadDir}`);
    
    if (!fs.existsSync(uploadDir)) {
      console.error(`Directory not found: ${uploadDir}`);
      return NextResponse.json({ error: "Job directory not found" }, { status: 404 });
    }

    // 1. Create Concat List
    // ffmpeg concat demuxer requires absolute paths or relative to the list file.
    // We will create 'input.txt' in the job dir.
    const listPath = path.join(uploadDir, `input_${Date.now()}.txt`);
    const outputFilename = `video_${Date.now()}.mp4`;
    const outputPath = path.join(uploadDir, outputFilename);

    // Format: file 'filename'
    // duration is needed if we want specific duration per frame, 
    // but if we set global -r (framerate), simple file list works usually with image2pipe? 
    // No, for images to video with concat, we usually specify duration for each image 
    // OR use -framerate with image2pipe (but that requires sequential naming).
    // Since our frames might be non-sequential (selections), Concat Demuxer is best.
    // 
    // Concat format:
    // file 'path/to/image'
    // duration 5
    
    // Duration per frame = 1 / fps
    const frameDuration = 1 / (fps || 30);
    
    const fileContent = frames.map((frameUrl: string) => {
        // Extract filename from URL (e.g., /uploads/uuid/frame_001.jpg -> frame_001.jpg)
        const filename = frameUrl.split('/').pop();
        // Path relative to the txt file
        return `file '${filename}'\nduration ${frameDuration}`;
    }).join('\n');

    // Note: The last image needs to be specified twice or handled carefully 
    // because ffmpeg concat demuxer might cut off the last frame duration?
    // Actually, adding the last frame again without duration fixes a known "last frame skipped" issue in some versions,
    // or just ensure the stream ends correctly. 
    // Let's stick to the standard first.

    fs.writeFileSync(listPath, fileContent);

    // 2. Run FFmpeg
    console.log(`Creating video from ${frames.length} frames at ${fps} FPS...`);

    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions([
            '-c:v', 'libx264', 
            '-pix_fmt', 'yuv420p', // Important for browser compatibility
            '-r', fps.toString() // Output framerate
        ])
        .save(outputPath)
        .on('end', () => {
            // Cleanup list file
            try { fs.unlinkSync(listPath); } catch(e) {}
            resolve();
        })
        .on('error', (err) => {
            console.error("FFmpeg Video Creation Error:", err);
            reject(err);
        });
    });

    return NextResponse.json({
      success: true,
      videoUrl: `/uploads/${jobId}/${outputFilename}`
    });

  } catch (error: any) {
    console.error("Create Video API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

