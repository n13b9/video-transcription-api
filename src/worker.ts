import { Worker, Job } from "bullmq";
import { Redis } from "ioredis";
import { execFile } from "node:child_process";
import util from "node:util";
const execFilePromise = util.promisify(execFile);

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import axios from "axios";
import { Readable, Writable } from "node:stream";
import { QUEUE_NAME } from "./queue.ts";

import { transcribeAudioWithGroq } from "./utils/groq-api.ts";
import { createTranscriptChunks } from "./utils/transcript-helpers.ts";
import { extractYouTubeVideoId } from "./utils/youtube-helpers.ts";

import "dotenv/config";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL =
  process.env.GROQ_API_URL ||
  "https://api.groq.com/openai/v1/audio/transcriptions";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "whisper-large-v3";
const MAX_WORDS_PER_CHUNK = parseInt(
  process.env.MAX_WORDS_PER_CHUNK || "15",
  10
);
const MAX_DURATION_MS = parseInt(process.env.MAX_DURATION_MS || "6000", 10);

const YTDLP_EXECUTABLE_PATH = process.env.YTDLP_PATH;
const FFMPEG_DIR_PATH = process.env.FFMPEG_DIR_PATH;

if (!GROQ_API_KEY) {
  console.error("FATAL ERROR: GROQ_API_KEY environment variable is not set.");
  process.exit(1);
}

const redisConnection = new Redis({
  ...(process.env.REDIS_URL
    ? { connectionString: process.env.REDIS_URL }
    : { host: "127.0.0.1", port: 6379 }),
  maxRetriesPerRequest: null,
});

redisConnection.on("error", (err) =>
  console.error("[Worker] Redis connection error:", err)
);
redisConnection.on("connect", () =>
  console.log("[Worker] Connected to Redis successfully.")
);

interface GroqWord {
  word: string;
  start: number;
  end: number;
}

interface GroqTranscriptionResponse {
  text?: string;
  words?: GroqWord[];
}

interface TranscriptChunk {
  text: string;
  offset: number;
  duration: number;
}

function pipeStreamManually(
  readable: Readable,
  writable: Writable
): Promise<void> {
  return new Promise((resolve, reject) => {
    readable.on("error", (err) => {
      if (!writable.destroyed) writable.destroy(err);
      reject(err);
    });
    writable.on("error", (err) => {
      if (!readable.destroyed) readable.destroy(err);
      reject(err);
    });
    writable.on("finish", resolve);
    readable.pipe(writable);
  });
}

const processTranscriptionJob = async (
  job: Job
): Promise<TranscriptChunk[]> => {
  const originalUrl = job.data.videoUrl;
  let tempAudioPath: string | null = null;

  console.log(`[Worker] Received job ${job.id} for URL: ${originalUrl}`);

  try {
    const isLikelyYouTube = !!extractYouTubeVideoId(originalUrl);
    const tempDir = os.tmpdir();

    if (isLikelyYouTube) {
      console.log(
        `[Worker] Job ${job.id}: Identified as YouTube URL. Initializing yt-dlp download...`
      );

      const uniqueFilename = `job_${job.id}_yt_${Date.now()}.%(ext)s`;
      const tempOutputPath = path.join(tempDir, uniqueFilename);
      let finalDownloadedPath: string | null = null;

      console.log(
        `[Worker] Job ${job.id}: Downloading YouTube audio using yt-dlp command to template: ${tempOutputPath}...`
      );

      const ytDlpArgs = [
        "--no-check-certificate",
        "--ffmpeg-location",
        FFMPEG_DIR_PATH,
        "-f",
        "worstaudio/worst",
        "-x",
        "--no-playlist",
        "-o",
        tempOutputPath,
        originalUrl,
      ];

      try {
        if (
          !YTDLP_EXECUTABLE_PATH ||
          typeof YTDLP_EXECUTABLE_PATH !== "string"
        ) {
          throw new Error("YTDLP_EXECUTABLE_PATH is not configured correctly.");
        }
        console.log(
          `[Worker] Executing: ${YTDLP_EXECUTABLE_PATH} ${ytDlpArgs.join(" ")}`
        );
        const processEnv = {
          ...process.env,
          PATH: `${FFMPEG_DIR_PATH}:${process.env.PATH}`,
        };
        const { stdout, stderr } = await execFilePromise(
          YTDLP_EXECUTABLE_PATH,
          ytDlpArgs,
          { env: processEnv }
        );

        if (stdout) console.log(`[yt-dlp stdout] ${stdout}`);
        if (stderr) console.warn(`[yt-dlp stderr] ${stderr}`);

        const extractAudioMatch =
          stderr.match(/\[ExtractAudio\] Destination: (.*)/) ||
          stdout.match(/\[ExtractAudio\] Destination: (.*)/);
        const downloadMatch =
          stderr.match(/\[download\] Destination: (.*)/) ||
          stdout.match(/\[download\] Destination: (.*)/);

        if (extractAudioMatch && extractAudioMatch[1]) {
          finalDownloadedPath = extractAudioMatch[1].trim();
          console.log(
            `[Worker] Job ${job.id}: yt-dlp reported [ExtractAudio] destination: ${finalDownloadedPath}`
          );
        } else if (downloadMatch && downloadMatch[1]) {
          finalDownloadedPath = downloadMatch[1].trim();
          console.log(
            `[Worker] Job ${job.id}: yt-dlp reported [download] destination (using as fallback): ${finalDownloadedPath}`
          );
        } else {
          console.warn(
            `[Worker] Job ${job.id}: Could not find 'Destination:' in yt-dlp output. Attempting to guess path...`
          );
          const possibleExts = ["webm", "m4a", "mp3", "opus"];
          const baseOutputPath = tempOutputPath.replace(".%(ext)s", "");
          for (const ext of possibleExts) {
            const guessedPath = `${baseOutputPath}.${ext}`;
            if (await fsp.stat(guessedPath).catch(() => null)) {
              finalDownloadedPath = guessedPath;
              console.warn(
                `[Worker] Job ${job.id}: Guessed downloaded path: ${finalDownloadedPath}`
              );
              break;
            }
          }
        }

        if (
          !finalDownloadedPath ||
          !(await fsp.stat(finalDownloadedPath).catch(() => null))
        ) {
          if (stderr?.includes("Video unavailable"))
            throw new Error("yt-dlp reported: Video unavailable");
          if (stderr?.includes("Private video"))
            throw new Error("yt-dlp reported: Private video");
          if (stderr?.includes("ffprobe") && stderr?.includes("not found"))
            throw new Error(
              `yt-dlp requires ffprobe, but it was not found in the specified --ffmpeg-location directory: ${FFMPEG_DIR_PATH}.`
            );
          if (stderr?.includes("ffmpeg") && stderr?.includes("not found"))
            throw new Error(
              `yt-dlp requires ffmpeg, but it was not found in the specified --ffmpeg-location directory: ${FFMPEG_DIR_PATH}.`
            );
          throw new Error(
            `yt-dlp finished, but could not determine or find output file from template ${tempOutputPath}. Check stderr: ${stderr}`
          );
        }
        tempAudioPath = finalDownloadedPath;
        console.log(
          `[Worker] Job ${job.id}: YouTube audio downloaded successfully to ${tempAudioPath}`
        );
      } catch (ytDlpError: any) {
        console.error(
          `[Worker] Job ${job.id}: Failed during yt-dlp execution (execFile):`,
          ytDlpError
        );
        if (ytDlpError.stderr)
          console.error(`[yt-dlp stderr on error] ${ytDlpError.stderr}`);
        if (ytDlpError.stderr?.includes("Video unavailable"))
          throw new Error("yt-dlp reported: Video unavailable");
        if (ytDlpError.stderr?.includes("Private video"))
          throw new Error("yt-dlp reported: Private video");
        if (
          ytDlpError.stderr?.includes("ffprobe") &&
          ytDlpError.stderr?.includes("not found")
        )
          throw new Error(
            `yt-dlp requires ffprobe, but it was not found in the specified --ffmpeg-location directory: ${FFMPEG_DIR_PATH}.`
          );
        if (
          ytDlpError.stderr?.includes("ffmpeg") &&
          ytDlpError.stderr?.includes("not found")
        )
          throw new Error(
            `yt-dlp requires ffmpeg, but it was not found in the specified --ffmpeg-location directory: ${FFMPEG_DIR_PATH}.`
          );
        if (ytDlpError.message?.includes("ENOENT"))
          throw new Error(
            `yt-dlp execution failed: Cannot find yt-dlp executable at ${YTDLP_EXECUTABLE_PATH}. Ensure it's installed and the path is correct.`
          );
        throw new Error(`yt-dlp execution failed: ${ytDlpError.message}`);
      }
    } else {
      console.warn(
        `[Worker] Job ${job.id}: Not a YouTube URL or ID extraction failed. Attempting direct download from: ${originalUrl}`
      );
      let extension = path.extname(new URL(originalUrl).pathname).slice(1);
      if (!extension || extension.length > 5) {
        extension = "bin";
      }
      tempAudioPath = path.join(
        tempDir,
        `job_${job.id}_direct_${Date.now()}.${extension}`
      );
      console.log(
        `[Worker] Job ${job.id}: Downloading direct URL content to ${tempAudioPath}...`
      );
      const response = await axios({
        method: "get",
        url: originalUrl,
        responseType: "stream",
        timeout: 30000,
      });
      if (response.status < 200 || response.status >= 300)
        throw new Error(
          `Direct download failed with status code: ${response.status}`
        );
      const contentType = response.headers["content-type"];
      console.log(
        `[Worker] Job ${job.id}: Direct URL Content-Type: ${contentType}`
      );
      if (
        contentType &&
        !contentType.startsWith("audio/") &&
        !contentType.startsWith("video/") &&
        contentType !== "application/octet-stream"
      ) {
        console.warn(
          `[Worker] Job ${job.id}: Content-Type (${contentType}) might not be suitable for transcription.`
        );
      }
      const writable = fs.createWriteStream(tempAudioPath);
      await pipeStreamManually(response.data as Readable, writable);
      console.log(
        `[Worker] Job ${job.id}: Direct URL content downloaded successfully.`
      );
    }

    if (!tempAudioPath) {
      throw new Error("Temporary audio file path is not set.");
    }
    const transcriptionResult = (await transcribeAudioWithGroq(
      tempAudioPath,
      GROQ_API_KEY,
      GROQ_API_URL,
      WHISPER_MODEL
    )) as GroqTranscriptionResponse;

    const chunks = createTranscriptChunks(
      transcriptionResult.words,
      MAX_WORDS_PER_CHUNK,
      MAX_DURATION_MS
    );

    console.log(
      `[Worker] Job ${job.id} processing finished. Returning ${chunks.length} chunks.`
    );
    return chunks;
  } catch (error) {
    console.error(
      `[Worker] Job ${job.id} failed for URL: ${originalUrl}`,
      error
    );
    throw error;
  } finally {
    if (tempAudioPath) {
      try {
        console.log(
          `[Worker] Job ${job.id}: Cleaning up temporary file ${tempAudioPath}...`
        );
        await fsp.unlink(tempAudioPath);
        console.log(`[Worker] Job ${job.id}: Temporary file deleted.`);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException)?.code !== "ENOENT") {
          console.error(
            `[Worker] Job ${job.id}: Error deleting temporary file ${tempAudioPath}`,
            unlinkError
          );
        }
      }
    }
  }
};

const worker = new Worker(QUEUE_NAME, processTranscriptionJob, {
  connection: redisConnection,
  concurrency: 2,
});

worker.on("completed", (job: Job, result: any) => {
  const resultCount = Array.isArray(result) ? result.length : "?";
  console.log(
    `[Worker] Job ${job.id} completed successfully. Result: ${resultCount} chunks.`
  );
});
worker.on("failed", (job: Job | undefined, err: Error) => {
  const jobId = job ? job.id : "unknown";
  console.error(`[Worker] Job ${jobId} failed with error: ${err.message}`);
});
worker.on("error", (err: Error) => {
  console.error(`[Worker] Worker encountered an error: ${err.message}`);
});

console.log(`Worker started for queue "${QUEUE_NAME}"... Waiting for jobs.`);

const shutdown = async () => {
  console.log("[Worker] Shutting down worker...");
  await worker.close();
  await redisConnection.quit();
  console.log("[Worker] Worker shutdown complete.");
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
