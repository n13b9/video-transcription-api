import axios from "axios";
import FormData from "form-data";
import fs from "fs";

export interface GroqWord {
  word: string;
  start: number;
  end: number;
}

export interface GroqTranscriptionResponse {
  text?: string;
  words?: GroqWord[];
}

function isUrl(input: string): boolean {
  try {
    new URL(input);
    return input.startsWith("http://") || input.startsWith("https://");
  } catch (_) {
    return false;
  }
}

export async function transcribeAudioWithGroq(
  filePathOrUrl: string,
  apiKey: string | undefined,
  apiUrl: string,
  model: string
): Promise<GroqTranscriptionResponse> {
  if (!apiKey) {
    throw new Error("[Groq API Helper] API Key is missing.");
  }

  const form = new FormData();
  form.append("model", model);
  form.append("response_format", "verbose_json");

  form.append("timestamp_granularities[]", "word");

  if (isUrl(filePathOrUrl)) {
    console.log(
      `[Groq API Helper] Transcribing from URL: ${filePathOrUrl} using model ${model}...`
    );

    form.append("url", filePathOrUrl);
  } else {
    console.log(
      `[Groq API Helper] Transcribing from file: ${filePathOrUrl} using model ${model}...`
    );
    if (!fs.existsSync(filePathOrUrl)) {
      console.error(
        `[Groq API Helper] Audio file not found at: ${filePathOrUrl}`
      );
      throw new Error(`Audio file not found: ${filePathOrUrl}`);
    }

    form.append("file", fs.createReadStream(filePathOrUrl));
  }

  try {
    const response = await axios.post<GroqTranscriptionResponse>(apiUrl, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${apiKey}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    console.log("[Groq API Helper] API call successful.");
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
      if (isUrl(filePathOrUrl) && error.response?.status === 413) {
        throw new Error(
          `Groq API Error: 413 - Request Entity Too Large. The file specified by the URL likely exceeds Groq's processing size limit.`
        );
      }
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
