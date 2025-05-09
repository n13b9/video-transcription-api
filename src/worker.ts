import { Worker, Job } from "bullmq";
import { Redis, RedisOptions } from "ioredis";
import { execFile } from "node:child_process";
import util from "node:util";
const execFilePromise = util.promisify(execFile);
import { URL } from "node:url";

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import axios from "axios";
import FormData from "form-data";
import { Readable, Writable } from "node:stream";
import { QUEUE_NAME } from "./queue";

import { transcribeAudioWithGroq } from "./utils/groq-api";
import { createTranscriptChunks } from "./utils/transcript-helpers";
import { extractYouTubeVideoId } from "./utils/youtube-helpers";

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

const YTDLP_EXECUTABLE_PATH = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG_DIR_PATH = process.env.FFMPEG_DIR_PATH;
const NODE_ENV = process.env.NODE_ENV;

if (!GROQ_API_KEY) {
  console.error("FATAL ERROR: GROQ_API_KEY environment variable is not set.");
  process.exit(1);
}

console.log(`[Worker Setup] Checking environment variables...`);
const redisUrlFromEnv_Worker = process.env.REDIS_URL;
console.log(
  `[Worker Setup] process.env.REDIS_URL value: ${
    redisUrlFromEnv_Worker
      ? redisUrlFromEnv_Worker.substring(0, 15) + "..."
      : "<NOT SET or undefined>"
  }`
);

if (!redisUrlFromEnv_Worker && NODE_ENV === "production") {
  console.error(
    "[Worker Setup] FATAL ERROR: REDIS_URL environment variable is missing in production environment!"
  );
  throw new Error("FATAL ERROR: REDIS_URL environment variable is missing.");
}

const baseRedisOptions_Worker: RedisOptions = {
  maxRetriesPerRequest: null,
  connectTimeout: 15000,
  retryStrategy(times: number): number | null {
    const delay = Math.min(times * 150, 3000);
    console.warn(
      `[Worker Setup] Redis connection failed, retrying in ${delay}ms (attempt ${times})`
    );
    if (times > 10) {
      console.error(
        "[Worker Setup] Redis connection failed after multiple retries. Giving up."
      );
      return null;
    }
    return delay;
  },
};

let redisConnectionOptions_Worker: RedisOptions;

if (redisUrlFromEnv_Worker) {
  console.log(
    `[Worker Setup] Parsing REDIS_URL and connecting with explicit options including family: 0.`
  );
  try {
    const parsedUrl = new URL(redisUrlFromEnv_Worker);
    redisConnectionOptions_Worker = {
      host: parsedUrl.hostname,
      port: parseInt(parsedUrl.port, 10),
      password: parsedUrl.password,
      family: 0,
      ...baseRedisOptions_Worker,
    };
  } catch (e) {
    console.error("[Worker Setup] FATAL ERROR: Could not parse REDIS_URL.", e);
    throw new Error("FATAL ERROR: Could not parse REDIS_URL.");
  }
} else {
  console.log(
    `[Worker Setup] REDIS_URL not found. Connecting using localhost default (intended for local dev only).`
  );
  redisConnectionOptions_Worker = {
    host: "127.0.0.1",
    port: 6379,
    family: 4,
    ...baseRedisOptions_Worker,
  };
}

console.log(`[Worker Setup] Config object being passed to Redis constructor:`, {
  host: redisConnectionOptions_Worker.host,
  port: redisConnectionOptions_Worker.port,
  family: redisConnectionOptions_Worker.family,
  hasPassword: !!redisConnectionOptions_Worker.password,
});

const redisConnection = new Redis(redisConnectionOptions_Worker);

redisConnection.on("error", (err) => {
  if ((err as NodeJS.ErrnoException).code === "ENOTFOUND") {
    console.error(
      `[Worker] Redis connection error: Could not resolve Redis hostname (${
        (err as any).host || "N/A"
      }). Check network/DNS settings or REDIS_URL validity. Error:`,
      err.message
    );
  } else if ((err as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    console.error(
      `[Worker] Redis connection error: Connection timed out. Check network latency or Redis service status. Error:`,
      err.message
    );
  } else {
    console.error("[Worker] Redis connection error:", err);
  }
});
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
  let inputForGroq: string | null = null;
  let tempAudioPathToDelete: string | null = null;

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
        ...(FFMPEG_DIR_PATH ? ["--ffmpeg-location", FFMPEG_DIR_PATH] : []),
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
          ...(FFMPEG_DIR_PATH && {
            PATH: `${FFMPEG_DIR_PATH}:${process.env.PATH}`,
          }),
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
          if (
            (stderr?.includes("ffprobe") || stderr?.includes("ffmpeg")) &&
            stderr?.includes("not found")
          )
            throw new Error(
              `yt-dlp requires ffmpeg/ffprobe, but they were not found. Ensure they are installed in the deployment environment or FFMPEG_DIR_PATH is set correctly.`
            );
          throw new Error(
            `yt-dlp finished, but could not determine or find output file from template ${tempOutputPath}. Check stderr: ${stderr}`
          );
        }
        inputForGroq = finalDownloadedPath;
        tempAudioPathToDelete = finalDownloadedPath;
        console.log(
          `[Worker] Job ${job.id}: YouTube audio downloaded successfully to ${inputForGroq}`
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
          (ytDlpError.stderr?.includes("ffprobe") ||
            ytDlpError.stderr?.includes("ffmpeg")) &&
          ytDlpError.stderr?.includes("not found")
        )
          throw new Error(
            `yt-dlp requires ffmpeg/ffprobe, but they were not found in the system PATH. Ensure they are installed in the deployment environment or FFMPEG_DIR_PATH is set correctly.`
          );
        if (ytDlpError.message?.includes("ENOENT"))
          throw new Error(
            `yt-dlp execution failed: Cannot find yt-dlp executable ('${YTDLP_EXECUTABLE_PATH}'). Ensure it's installed via nixpacks.toml and in PATH, or set YTDLP_PATH env var.`
          );
        throw new Error(`yt-dlp execution failed: ${ytDlpError.message}`);
      }
    } else {
      console.warn(
        `[Worker] Job ${job.id}: Not a YouTube URL. Passing URL directly to Groq API: ${originalUrl}`
      );
      inputForGroq = originalUrl;
      tempAudioPathToDelete = null;
    }

    if (!inputForGroq) {
      throw new Error("Input for Groq (file path or URL) is not set.");
    }

    const transcriptionResult = (await transcribeAudioWithGroq(
      inputForGroq,
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
    if (tempAudioPathToDelete) {
      try {
        console.log(
          `[Worker] Job ${job.id}: Cleaning up temporary file ${tempAudioPathToDelete}...`
        );
        await fsp.unlink(tempAudioPathToDelete);
        console.log(`[Worker] Job ${job.id}: Temporary file deleted.`);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException)?.code !== "ENOENT") {
          console.error(
            `[Worker] Job ${job.id}: Error deleting temporary file ${tempAudioPathToDelete}`,
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
    `[Worker Events] Job ${job.id} completed successfully. Result: ${resultCount} chunks.`
  );
});
worker.on("failed", (job: Job | undefined, err: Error) => {
  const jobId = job ? job.id : "unknown";
  console.error(
    `[Worker Events] Job ${jobId} failed with error: ${err.message}`
  );
});
worker.on("error", (err: Error) => {
  console.error(`[Worker Events] Worker encountered an error: ${err.message}`);
});

console.log(
  `[Worker Setup] Worker started for queue "${QUEUE_NAME}"... Waiting for jobs.`
);

const shutdown = async () => {
  console.log("[Worker Shutdown] Shutting down worker...");
  await worker.close();
  await redisConnection.quit();
  console.log("[Worker Shutdown] Worker shutdown complete.");
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
