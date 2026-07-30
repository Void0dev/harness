import { harnessRequestHeaders, validatedHarnessUrl } from "./harness-endpoint.mjs";

const SESSION_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;
const HARNESS_UPDATE_MARKER = "<!-- opencode-harness-update -->";

export async function forwardHumanAnswer({
  text,
  parentSessionId,
  harnessUrl,
  commandToken,
  fetchImpl = fetch,
  timeoutMs = 20_000,
}) {
  const answer = text.trim();
  if (!answer || answer.startsWith("/") || answer.includes(HARNESS_UPDATE_MARKER)) {
    return { accepted: false };
  }
  if (!SESSION_ID.test(parentSessionId)) throw new Error("Invalid OpenCode parent session ID");
  const endpoint = validatedHarnessUrl(harnessUrl, "Harness answer URL");
  const authorization = harnessRequestHeaders(endpoint, commandToken);
  let timer;
  const controller = new AbortController();
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
          body: JSON.stringify({ text: answer, parentSessionId }),
        });
        if (response.status === 204) return { accepted: false };
        if (!response.ok) throw new Error(`Harness answer forwarding failed with HTTP ${response.status}`);
        const payload = await response.json();
        if (!Number.isSafeInteger(payload.issueNumber)) throw new Error("Harness returned an invalid answer response");
        return { accepted: true, issueNumber: payload.issueNumber };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Harness answer forwarding timed out"));
        }, timeoutMs);
      }),
    ]);
  } catch {
    return { accepted: false };
  } finally {
    clearTimeout(timer);
  }
}
