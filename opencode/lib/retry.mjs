import { harnessRequestHeaders, validatedHarnessUrl } from "./harness-endpoint.mjs";

const SESSION_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;

export async function requestTechnicalRetry({
  parentSessionId,
  instruction,
  harnessUrl,
  commandToken,
  fetchImpl = fetch,
  timeoutMs = 15_000,
}) {
  if (!SESSION_ID.test(parentSessionId)) throw new Error("Invalid OpenCode parent session ID");
  const retryInstruction = typeof instruction === "string" ? instruction.trim() : "";
  if (retryInstruction.length > 16_000) throw new Error("Retry instruction is too long");
  const endpoint = validatedHarnessUrl(harnessUrl, "Harness retry URL");
  const authorization = harnessRequestHeaders(endpoint, commandToken);
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(endpoint.toString(), {
          method: "POST",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            ...authorization,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            parentSessionId,
            ...(retryInstruction ? { instruction: retryInstruction } : {}),
          }),
        });
        if (response.status === 204) return { accepted: false };
        if (!response.ok) throw new Error(`Harness retry failed with HTTP ${response.status}`);
        const payload = await response.json();
        if (!Number.isSafeInteger(payload.issueNumber)) throw new Error("Harness returned an invalid retry response");
        return { accepted: true, issueNumber: payload.issueNumber };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Harness retry timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
