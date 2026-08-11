export class ResponseBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Provider response body exceeds ${maxBytes} bytes`);
    this.name = "ResponseBodyTooLargeError";
  }
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
) {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ResponseBodyTooLargeError(maxBytes);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        try {
          await reader.cancel("Provider response body limit exceeded");
        } catch {
          // The bounded-read error remains authoritative if cancellation fails.
        }
        throw new ResponseBodyTooLargeError(maxBytes);
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function readBoundedResponseJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const text = await readBoundedResponseText(response, maxBytes);
  return text.trim() ? JSON.parse(text) : null;
}
