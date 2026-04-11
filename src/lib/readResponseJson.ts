/**
 * Parse a fetch Response as JSON. Avoids `Unexpected token …` when the server
 * returns HTML or plain text (e.g. "Internal Server Error") instead of JSON.
 */
export async function readResponseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(`Empty response from server (HTTP ${response.status}).`);
  }
  if (trimmed[0] === "<") {
    throw new Error(
      `Server returned HTML instead of JSON (HTTP ${response.status}). If you are on localhost, stop dev, run "npm run dev:clean", then "npm run dev".`
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const preview = trimmed.slice(0, 120).replace(/\s+/g, " ");
    throw new Error(
      `Server response was not JSON (HTTP ${response.status}): ${preview}${trimmed.length > 120 ? "…" : ""}`
    );
  }
}
