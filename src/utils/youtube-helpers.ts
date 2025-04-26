export function extractYouTubeVideoId(url: string): string | null {
  if (!url) return null;
  try {
    const parsedUrl = new URL(url);
    if (
      parsedUrl.hostname === "www.youtube.com" ||
      parsedUrl.hostname === "youtube.com"
    ) {
      const videoId = parsedUrl.searchParams.get("v");
      if (videoId) return videoId;
    }
    if (parsedUrl.hostname === "youtu.be") {
      const pathParts = parsedUrl.pathname.split("/");
      if (pathParts.length > 1 && pathParts[1]) {
        return pathParts[1].split("?")[0];
      }
    }
  } catch (e) {
    console.warn(
      `[YouTube Helper] Could not parse URL for video ID: ${url}`,
      e
    );
  }
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) {
    return url;
  }
  return null;
}
