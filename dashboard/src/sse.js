const MAX_SSE_FRAME_CHARS = 1_000_000;

export async function* readSseData(body) {
  const reader = body?.getReader?.();
  if (!reader) throw new Error("The response stream is unavailable.");

  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
        for (const data of parseFrame(frame)) yield data;
      }
      if (buffer.length > MAX_SSE_FRAME_CHARS) throw new Error("The response stream sent an oversized event.");
      if (done) break;
    }
    if (buffer.trim()) {
      for (const data of parseFrame(buffer)) yield data;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame) {
  const lines = frame.split(/\r?\n/);
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
  return data ? [data] : [];
}
