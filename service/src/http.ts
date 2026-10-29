// HTTP 応答と本文読み取りの共通処理 / Shared helpers for HTTP responses and body reading

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// 本文は {error: code, detail?} / Body is {error: code, detail?}
export function error(status: number, code: string, detail?: string): Response {
  return json(status, detail === undefined ? { error: code } : { error: code, detail });
}

// JSON 本文を上限付きで読む。超過は 413、壊れた JSON は 400 の Response を throw する
// Reads a JSON body with a size cap. Throws a 413 Response when too large, 400 when malformed
export async function readJson<T>(request: Request, maxBytes = 1_000_000): Promise<T> {
  const declared = Number(request.headers.get('content-length'));
  if (declared > maxBytes) throw error(413, 'payload_too_large');
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw error(413, 'payload_too_large');
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw error(400, 'invalid_json');
  }
}
