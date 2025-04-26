import { Hono } from "hono";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { transcriptionQueue } from "./queue";

const app = new Hono();

app.use("*", logger());
app.get("/", (c) => c.text("Hono Hono!"));

app.post("/transcribe", async (c) => {
  try {
    const body = await c.req.json();

    if (!body || typeof body.url !== "string" || body.url.trim() === "") {
      return c.json({ error: 'Missing or invalid "url" in request body' }, 400);
    }

    const videoUrl = body.url;
    console.log(`Received request to transcribe URL: ${videoUrl}`);

    const job = await transcriptionQueue.add("process-video", {
      videoUrl: videoUrl,
    });

    console.log(`Added job ${job.id} to the queue for URL: ${videoUrl}`);

    return c.json({ jobId: job.id });
  } catch (error) {
    console.error("Error processing /transcribe request:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

app.get("/getTranscriptionResult/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  console.log(`Received request for job ID: ${jobId}`);

  try {
    const job = await transcriptionQueue.getJob(jobId);

    if (!job) {
      console.log(`Job ${jobId} not found.`);
      return c.json({ error: `Job with ID ${jobId} not found.` }, 404);
    }

    const state = await job.getState();
    console.log(`Job ${jobId} state: ${state}`);

    switch (state) {
      case "completed":
        return c.json({
          status: "success",
          content: job.returnvalue,
        });
      case "failed":
        return c.json({
          status: "error",
          error: job.failedReason || "Job failed with an unknown error",
        });
      case "active":
      case "waiting":
      case "delayed":
      case "paused":
        return c.json({ status: "processing" });
      default:
        console.warn(`Job ${jobId} is in an unexpected state: ${state}`);
        return c.json({ status: "unknown", state: state });
    }
  } catch (error) {
    console.error(`Error fetching status for job ${jobId}:`, error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return c.json(
      {
        error: "Internal Server Error retrieving job status",
        details: errorMessage,
      },
      500
    );
  }

  return c.json({ status: "processing" });
});

const port = 4000;
console.log(`Server is running on port ${port}`);

serve({
  fetch: app.fetch,
  port: port,
});
