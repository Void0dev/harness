export async function fetchBounded({
  url,
  headers = {},
  method = "GET",
  body,
  fetchImpl = fetch,
  timeoutMs = 10_000,
  maximumBytes = 2 * 1024 * 1024,
}) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, {
          method,
          signal: controller.signal,
          headers,
          ...(body === undefined ? {} : { body }),
        });
        const chunks = [];
        let size = 0;
        if (response.body) {
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maximumBytes) {
              controller.abort();
              throw new Error("Upstream response body is too large");
            }
            chunks.push(Buffer.from(value));
          }
        }
        return {
          status: response.status,
          contentType: response.headers.get("content-type") ?? "application/json",
          body: Buffer.concat(chunks),
        };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Upstream request timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
