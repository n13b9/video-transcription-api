interface GroqWord {
  word: string;
  start: number;
  end: number;
}

interface TranscriptChunk {
  text: string;
  offset: number;
  duration: number;
}

export function createTranscriptChunks(
  words: GroqWord[] | undefined,
  maxWords: number,
  maxDurationMs: number
): TranscriptChunk[] {
  if (!words || words.length === 0) {
    console.log("[Transcript Helper] No words provided for chunking.");
    return [];
  }

  const chunks: TranscriptChunk[] = [];
  let currentChunkWords: GroqWord[] = [];

  let currentChunkStartTimeSec = words[0]?.start ?? 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const wordStartSec = typeof word.start === "number" ? word.start : 0;
    const wordEndSec = typeof word.end === "number" ? word.end : wordStartSec;

    const wordEndMs = Math.round(wordEndSec * 1000);

    const potentialNextWordCount = currentChunkWords.length + 1;
    const potentialDurationMs =
      wordEndMs - Math.round(currentChunkStartTimeSec * 1000);

    if (
      currentChunkWords.length > 0 &&
      (potentialNextWordCount > maxWords || potentialDurationMs > maxDurationMs)
    ) {
      const finalChunkText = currentChunkWords
        .map((w) => w.word)
        .join(" ")
        .trim();
      const finalChunkOffsetMs = Math.round(currentChunkStartTimeSec * 1000);
      const finalChunkEndMs = Math.round(
        (currentChunkWords[currentChunkWords.length - 1]?.end ??
          currentChunkStartTimeSec) * 1000
      );
      const finalChunkDurationMs = Math.max(
        0,
        finalChunkEndMs - finalChunkOffsetMs
      );

      if (finalChunkText) {
        chunks.push({
          text: finalChunkText,
          offset: finalChunkOffsetMs,
          duration: finalChunkDurationMs,
        });
      }

      currentChunkWords = [word];
      currentChunkStartTimeSec = wordStartSec;
    } else {
      if (currentChunkWords.length === 0) {
        currentChunkStartTimeSec = wordStartSec;
      }
      currentChunkWords.push(word);
    }
  }

  if (currentChunkWords.length > 0) {
    const finalChunkText = currentChunkWords
      .map((w) => w.word)
      .join(" ")
      .trim();
    const finalChunkOffsetMs = Math.round(currentChunkStartTimeSec * 1000);
    const finalChunkEndMs = Math.round(
      (currentChunkWords[currentChunkWords.length - 1]?.end ??
        currentChunkStartTimeSec) * 1000
    );
    const finalChunkDurationMs = Math.max(
      0,
      finalChunkEndMs - finalChunkOffsetMs
    );

    if (finalChunkText) {
      chunks.push({
        text: finalChunkText,
        offset: finalChunkOffsetMs,
        duration: finalChunkDurationMs,
      });
    }
  }

  console.log(
    `[Transcript Helper] Created ${chunks.length} chunks from ${words.length} words.`
  );
  return chunks;
}
