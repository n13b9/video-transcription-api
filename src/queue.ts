import { Queue } from "bullmq";
import { Redis } from "ioredis";

const QUEUE_NAME = "transcriptionQueue";

const redisConnection = new Redis({
  ...(process.env.REDIS_URL
    ? { connectionString: process.env.REDIS_URL }
    : { host: "127.0.0.1", port: 6379 }),
  maxRetriesPerRequest: null,
});

redisConnection.on("error", (err) => {
  console.error("Redis connection error:", err);
});

redisConnection.on("connect", () => {
  console.log("Connected to Redis successfully.");
});

const transcriptionQueue = new Queue(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: {
      age: 3600,
    },
    removeOnFail: {
      count: 1000,
    },
  },
});

console.log(`BullMQ Queue "${QUEUE_NAME}" initialized.`);

export { transcriptionQueue, QUEUE_NAME };
