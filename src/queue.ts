// src/queue.ts

import { Queue } from "bullmq";
import { Redis, RedisOptions } from "ioredis";

const QUEUE_NAME = "transcription";

const redisUrlFromEnv = process.env.REDIS_URL;
const nodeEnv = process.env.NODE_ENV;

console.log(`[Queue Setup] NODE_ENV: ${nodeEnv}`);
console.log(
  `[Queue Setup] process.env.REDIS_URL value: ${
    redisUrlFromEnv
      ? redisUrlFromEnv.substring(0, 15) + "..."
      : "<NOT SET or undefined>"
  }`
);

if (!redisUrlFromEnv && nodeEnv === "production") {
  console.error(
    "[Queue Setup] FATAL ERROR: REDIS_URL environment variable is missing in production environment!"
  );
  throw new Error("FATAL ERROR: REDIS_URL environment variable is missing.");
}

const redisConnectionOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  retryStrategy(times: number): number | null {
    const delay = Math.min(times * 100, 2000);
    console.warn(
      `[Queue Setup] Redis connection failed, retrying in ${delay}ms (attempt ${times})`
    );
    if (times > 10) {
      console.error(
        "[Queue Setup] Redis connection failed after multiple retries. Giving up."
      );
      return null;
    }
    return delay;
  },
  family: 0,
};

let redisConnection: Redis;

if (redisUrlFromEnv) {
  console.log(`[Queue Setup] Connecting using REDIS_URL string.`);
  redisConnection = new Redis(redisUrlFromEnv, redisConnectionOptions);
} else {
  console.log(
    `[Queue Setup] REDIS_URL not found. Connecting using localhost default (intended for local dev only).`
  );
  redisConnection = new Redis({
    host: "127.0.0.1",
    port: 6379,
    ...redisConnectionOptions,
  });
}

redisConnection.on("error", (err) => {
  if ((err as NodeJS.ErrnoException).code === "ENOTFOUND") {
    console.error(
      `[Queue Setup] Redis connection error: Could not resolve Redis hostname. Check network/DNS settings or REDIS_URL validity. Error:`,
      err.message
    );
  } else {
    console.error("[Queue Setup] Redis connection error:", err);
  }
});

redisConnection.on("connect", () => {
  console.log("[Queue Setup] Connected to Redis successfully.");
});

const transcriptionQueue = new Queue(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: { age: 3600 },
    removeOnFail: { count: 1000 },
  },
});

console.log(`BullMQ Queue "${QUEUE_NAME}" initialized.`);

export { transcriptionQueue, QUEUE_NAME };
