# Video Transcription API 

A simple API server proof-of-concept that accepts a video URL (YouTube or direct link), downloads the audio, transcribes it using the Groq Whisper API, and returns the timestamped transcript chunks.

## Overview

This project demonstrates an asynchronous workflow for video transcription:

1.  A client sends a video URL to the `/transcribe` endpoint.
2.  The API server adds a job to a BullMQ queue (backed by Redis) and immediately returns a `jobId`.
3.  A separate worker process picks up the job from the queue.
4.  The worker downloads the audio from the provided URL (handling YouTube links via `yt-dlp` and direct links via HTTP requests).
5.  The worker sends the downloaded audio file to the Groq API for transcription using the Whisper model, requesting word-level timestamps.
6.  The worker processes the timestamped words into logical chunks based on configured limits (max words, max duration).
7.  The client can poll the `/getTranscriptionResult/{jobId}` endpoint to check the job status (`processing`, `error`, `success`) and retrieve the final chunked transcript upon success.

## Tech Stack

* **API Framework:** Hono
* **Language:** TypeScript
* **Job Queue:** BullMQ
* **Queue Backend:** Redis
* **Transcription:** Groq API (Whisper Large v3)
* **YouTube Download:** yt-dlp (executed via Node.js `child_process`)
* **Audio Extraction:** ffmpeg (required by `yt-dlp`)
* **HTTP Client:** axios

## Prerequisites (Local Setup)

* **Node.js:** v18 or later recommended.
* **npm** or **yarn:** Package manager for Node.js.
* **Redis:** A Redis server running locally. The easiest way is often using Docker: `docker run -d -p 6379:6379 redis`
* **yt-dlp:** The command-line tool must be installed.
    * *macOS (Homebrew):* `brew install yt-dlp`
    * *Other:* Follow instructions at [https://github.com/yt-dlp/yt-dlp#installation](https://github.com/yt-dlp/yt-dlp#installation). You might need to manually place it in a known location.
* **ffmpeg:** Required by `yt-dlp` for audio extraction (`-x` flag).
    * *macOS (Homebrew):* `brew install ffmpeg`
    * *Other:* Download from [https://ffmpeg.org/download.html](https://ffmpeg.org/download.html) and ensure it's accessible or its location is specified.

## Installation

1.  **Clone the repository:**
    ```bash
    git clone <your-repo-url>
    cd <your-repo-name>
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    # or
    yarn install
    ```

## Environment Setup (.env file)

1.  Create a file named `.env` in the root directory of the project.
2.  Add the following variables, replacing the placeholder values:

    ```dotenv
    # .env

    # --- Required ---
    GROQ_API_KEY=your_groq_api_key_here

    # --- Optional: Only needed if executables aren't in your system PATH ---
    # Full path to your yt-dlp executable if not found automatically
    # YTDLP_PATH=/full/path/to/your/yt-dlp

    # Full path to the DIRECTORY containing ffmpeg and ffprobe if not found automatically
    # FFMPEG_DIR_PATH=/full/path/to/directory/containing/ffmpeg_and_ffprobe

    # --- Optional: Redis connection if not default localhost:6379 ---
    # REDIS_URL=redis://user:password@host:port

    # --- Optional: API Port ---
    # PORT=3000

    # --- Optional: Chunking parameters ---
    # MAX_WORDS_PER_CHUNK=15
    # MAX_DURATION_MS=6000
    ```
    * **`GROQ_API_KEY` is mandatory.**
    * Set `YTDLP_PATH` and `FFMPEG_DIR_PATH` **only** if running the worker gives errors that it cannot find `yt-dlp` or `ffmpeg`/`ffprobe`.

## Running Locally

1.  **Ensure Redis is running** locally (e.g., start the Docker container).
2.  **Compile TypeScript (Optional but recommended for checking):**
    ```bash
    npm run build
    ```
3.  **Run the API Server and Worker:** You need two separate terminal windows.
    * **Terminal 1 (API Server):**
        ```bash
        npm run dev:api
        # Or use your specific script if different
        ```
    * **Terminal 2 (Worker):**
        ```bash
        npm run dev:worker
        # Or use your specific script like 'npm run start1'
        ```
    * **Alternatively (if you installed `npm-run-all`):** Run both concurrently in one terminal:
        ```bash
        npm run dev
        ```



