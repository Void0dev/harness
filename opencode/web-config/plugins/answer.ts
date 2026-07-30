import type { Plugin } from "@opencode-ai/plugin";
import { forwardHumanAnswer } from "/opt/opencode/lib/answer.mjs";
import { createAnswerHooks } from "/opt/opencode/lib/answer-plugin.mjs";

export const HarnessAnswerPlugin: Plugin = async () => createAnswerHooks({
  forward: forwardHumanAnswer,
  harnessUrl: process.env.HARNESS_ANSWER_URL ?? "",
  commandToken: process.env.HARNESS_COMMAND_TOKEN ?? "",
});
