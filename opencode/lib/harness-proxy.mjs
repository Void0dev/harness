import { validatedHarnessUrl } from "./harness-endpoint.mjs";
import { fetchBounded } from "./bounded-fetch.mjs";

export async function forwardHarnessProxy({
  targetUrl,
  commandToken,
  body,
  fetchImpl = fetch,
  timeoutMs = 20_000,
  maximumResponseBytes = 256 * 1024,
}) {
  const endpoint = validatedHarnessUrl(targetUrl, "Harness proxy target URL");
  if (!commandToken || /\s/.test(commandToken)) throw new Error("Invalid Harness command token");
  return fetchBounded({
    url: endpoint,
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${commandToken}`,
      "Content-Type": "application/json",
    },
    body,
    fetchImpl,
    timeoutMs,
    maximumBytes: maximumResponseBytes,
  });
}
