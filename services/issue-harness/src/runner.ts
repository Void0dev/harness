import path from "node:path";
import { codex, run } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { config } from "./env.js";
import { TrackerIssue } from "./github.js";

export type AgentRunResult = {
  stdout: string;
  logFilePath?: string;
  sessionId?: string;
};

export async function runAgent(issue: NonNullable<TrackerIssue>, branch: string, comments: string) {
  const result = await run({
    cwd: process.cwd(),
    agent: codex(config.codexModel, {
      effort: config.codexReasoningEffort as "low" | "medium" | "high" | "xhigh",
      env: {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
        CODEX_HOME: path.join(config.dataDir, "codex"),
      },
    }),
    sandbox: docker({
      imageName: config.sandcastleImage,
      env: {
        HOME: "/home/agent",
      },
      mounts: [
        {
          hostPath: path.join(config.dataDir, "codex"),
          sandboxPath: "/home/agent/.codex",
        },
      ],
    }),
    branchStrategy: {
      type: "branch",
      branch,
    },
    promptFile: ".sandcastle/prompt.md",
    promptArgs: {
      ISSUE_NUMBER: String(issue.number),
      ISSUE_TITLE: issue.title,
      ISSUE_BODY: issue.body ?? "",
      ISSUE_COMMENTS: comments || "No comments yet.",
      REPO: `${config.owner}/${config.repo}`,
    },
    maxIterations: 1,
    idleTimeoutSeconds: 900,
    completionSignal: "<promise>COMPLETE</promise>",
    logging: {
      type: "file",
      path: path.join(config.dataDir, "sandcastle", `issue-${issue.number}-${Date.now()}.log`),
    },
  });

  return {
    stdout: result.stdout ?? "",
    logFilePath: result.logFilePath,
    sessionId: result.iterations.at(-1)?.sessionId,
  } satisfies AgentRunResult;
}

export function extractHumanQuestion(stdout: string) {
  const match = stdout.match(/<human-attention>([\s\S]*?)<\/human-attention>/i);
  return match?.[1]?.trim();
}
