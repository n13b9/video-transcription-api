import { Queue } from "bullmq";
import { Redis, RedisOptions } from "ioredis";
import { URL } from "node:url";

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

const baseRedisOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  connectTimeout: 15000,
  retryStrategy(times: number): number | null {
    const delay = Math.min(times * 150, 3000);
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
};

let redisConnectionOptions: RedisOptions;

if (redisUrlFromEnv) {
  console.log(
    `[Queue Setup] Parsing REDIS_URL and connecting with explicit options including family: 0.`
  );
  try {
    const parsedUrl = new URL(redisUrlFromEnv);
    redisConnectionOptions = {
      host: parsedUrl.hostname,
      port: parseInt(parsedUrl.port, 10),
      password: parsedUrl.password,
      family: 0,
      ...baseRedisOptions,
    };
  } catch (e) {
    console.error("[Queue Setup] FATAL ERROR: Could not parse REDIS_URL.", e);
    throw new Error("FATAL ERROR: Could not parse REDIS_URL.");
  }
} else {
  console.log(
    `[Queue Setup] REDIS_URL not found. Connecting using localhost default (intended for local dev only).`
  );
  redisConnectionOptions = {
    host: "127.0.0.1",
    port: 6379,
    family: 4,
    ...baseRedisOptions,
  };
}

console.log(`[Queue Setup] Config object being passed to Redis constructor:`, {
  host: redisConnectionOptions.host,
  port: redisConnectionOptions.port,
  family: redisConnectionOptions.family,
  hasPassword: !!redisConnectionOptions.password,
});

const redisConnection = new Redis(redisConnectionOptions);

redisConnection.on("error", (err) => {
  if ((err as NodeJS.ErrnoException).code === "ENOTFOUND") {
    console.error(
      `[Queue Setup] Redis connection error: Could not resolve Redis hostname (${
        (err as any).host || "N/A"
      }). Check network/DNS settings or REDIS_URL validity. Error:`,
      err.message
    );
  } else if ((err as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    console.error(
      `[Queue Setup] Redis connection error: Connection timed out. Check network latency or Redis service status. Error:`,
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
