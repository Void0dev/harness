import type { Plugin } from "@opencode-ai/plugin";
import { requestTechnicalRetry } from "/opt/opencode/lib/retry.mjs";
import { createRetryHooks } from "/opt/opencode/lib/retry-plugin.mjs";

export const RetryCommandPlugin: Plugin = async () => createRetryHooks({
  requestRetry: requestTechnicalRetry,
  harnessUrl: process.env.HARNESS_RETRY_URL ?? "",
  commandToken: process.env.HARNESS_COMMAND_TOKEN ?? "",
});
