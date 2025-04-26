import axios from "axios";
import FormData from "form-data";
import fs from "fs";

interface GroqWord {
  word: string;
  start: number;
  end: number;
}

interface GroqTranscriptionResponse {
  text?: string;
  words?: GroqWord[];
}

/**
 * Calls the Groq API to transcribe an audio file.
 * @param filePath - Path to the audio file.
 * @param apiKey - Groq API Key.
 * @param apiUrl - Groq API Endpoint URL.
 * @param model - Whisper model name.
 * @returns The transcription response from Groq.
 */
export async function transcribeAudioWithGroq(
  filePath: string,
  apiKey: string | undefined,
  apiUrl: string,
  model: string
): Promise<GroqTranscriptionResponse> {
  console.log(
    `[Groq API Helper] Transcribing file: ${filePath} using model ${model}...`
  );

  if (!fs.existsSync(filePath)) {
    console.error(`[Groq API Helper] Audio file not found at: ${filePath}`);
    throw new Error(`Audio file not found: ${filePath}`);
  }
  if (!apiKey) {
    throw new Error("[Groq API Helper] API Key is missing.");
  }

  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");

  try {
    const response = await axios.post<GroqTranscriptionResponse>(apiUrl, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${apiKey}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    if (!response.data || !Array.isArray(response.data.words)) {
      console.warn(
        '[Groq API Helper] Response missing expected "words" array.'
      );
      return response.data || {};
    }
    return response.data;
  } catch (error: any) {
    console.error("[Groq API Helper] API call failed.");
    if (axios.isAxiosError(error)) {
      console.error(
        "Axios error details:",
        error.response?.status,
        error.response?.data
      );
      throw new Error(
        `Groq API Error: ${error.response?.status} - ${JSON.stringify(
          error.response?.data
        )}`
      );
    } else {
      console.error("Non-Axios error during Groq API call:", error);
      throw new Error(`Failed to call Groq API: ${error.message}`);
    }
  }
}
