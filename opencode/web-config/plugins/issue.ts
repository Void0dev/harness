import type { Plugin } from "@opencode-ai/plugin";
import { createIssueFromCommand } from "/opt/opencode/lib/issue.mjs";
import { createIssueHooks } from "/opt/opencode/lib/issue-plugin.mjs";

export const IssueCommandPlugin: Plugin = async () => createIssueHooks({
  createIssue: createIssueFromCommand,
  harnessUrl: process.env.HARNESS_COMMAND_URL ?? "",
  commandToken: process.env.HARNESS_COMMAND_TOKEN ?? "",
});
