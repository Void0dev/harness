import { harnessRequestHeaders, validatedHarnessUrl } from "./harness-endpoint.mjs";

const SESSION_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;

export function issueCommandMessage(issueNumber, argumentsText) {
  const text = String(argumentsText ?? "");
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0 || !text.trim()) {
    throw new Error("Invalid persisted Issue command");
  }
  return `/issue ${text}\n\n<!-- opencode-harness-issue: ${issueNumber} -->`;
}

export async function createIssueFromCommand({
  argumentsText,
  parentSessionId,
  harnessUrl,
  commandToken,
  fetchImpl = fetch,
  timeoutMs = 15_000,
}) {
  const text = argumentsText.trim();
  if (!text) throw new Error("Issue text is required after /issue");
  if (!SESSION_ID.test(parentSessionId)) throw new Error("Invalid OpenCode parent session ID");
  const endpoint = validatedHarnessUrl(harnessUrl, "Harness command URL");
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
          body: JSON.stringify({ text, parentSessionId }),
        });
        if (response.status === 409) {
          const payload = await response.json();
          return {
            busy: true,
            ...(Number.isSafeInteger(payload.issueNumber) ? { issueNumber: payload.issueNumber } : {}),
          };
        }
        if (!response.ok) throw new Error(`Harness Issue creation failed with HTTP ${response.status}`);
        const payload = await response.json();
        if (!Number.isSafeInteger(payload.number) || typeof payload.url !== "string") {
          throw new Error("Harness returned an invalid Issue response");
        }
        return { number: payload.number, url: payload.url };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Harness Issue creation timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
