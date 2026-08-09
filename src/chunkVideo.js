import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const input = path.resolve("input/video.mp4");
const outputDir = path.resolve("output");
// Change this for each video, e.g. HLS_NAME=bahubali-part-1 pnpm chunk.
// It is also used as the playlist filename and segment filename prefix.
const hlsName = process.env.HLS_NAME || "video";

if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(hlsName)) {
  console.error("❌ HLS_NAME may contain only letters, numbers, hyphens, and underscores.");
  process.exit(1);
}

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Ensure input video exists
if (!fs.existsSync(input)) {
  console.error(`❌ Input video not found: ${input}`);
  process.exit(1);
}

const args = [
  "-i", input,
  "-map", "0:v:0",
  "-map", "0:a:0",
  "-sn",
  "-dn",
  "-c:v", "libx264",
  "-pix_fmt", "yuv420p",
  "-c:a", "aac",
  "-ac", "2",
  "-ar", "48000",
  "-preset", "veryfast",
  "-crf", "23",
  "-g", "48",
  "-keyint_min", "48",
  "-sc_threshold", "0",
  "-hls_time", "10",
  "-hls_playlist_type", "vod",
  "-hls_flags", "independent_segments",
  "-hls_segment_filename", path.join(outputDir, `${hlsName}_%03d.ts`),
  "-f", "hls",
  path.join(outputDir, `${hlsName}.m3u8`),
];

console.log(`🎬 Processing: ${input}`);

const ffmpeg = spawn("ffmpeg", args, {
  stdio: "inherit",
});

ffmpeg.on("error", (err) => {
  console.error("❌ Failed to start FFmpeg:", err.message);
  console.error("Make sure FFmpeg is installed and available in your PATH.");
});

ffmpeg.on("close", (code) => {
  if (code === 0) {
    console.log("\n✅ HLS conversion completed successfully.");
    console.log(`📂 Output directory: ${outputDir}`);
    console.log(`📄 Playlist: ${path.join(outputDir, `${hlsName}.m3u8`)}`);
  } else {
    console.error(`\n❌ FFmpeg exited with code ${code}`);
  }
});
