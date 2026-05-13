import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
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
  const codexHome = path.join(config.dataDir, "codex");
  const sandcastleLogDir = path.join(config.dataDir, "sandcastle");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(sandcastleLogDir, { recursive: true });
  if (config.codexAuthMode === "api-key") {
    await ensureCodexApiKeyLogin(codexHome);
  }

  let result;
  try {
    result = await run({
      cwd: config.repoRoot,
      agent: codex(config.codexModel, {
        effort: config.codexReasoningEffort as "low" | "medium" | "high" | "xhigh",
        env: codexAgentEnv(),
      }),
      sandbox: docker({
        imageName: config.sandcastleImage,
        containerUid: 10001,
        containerGid: 10001,
        env: {
          HOME: "/home/agent",
          GIT_CONFIG_GLOBAL: "/tmp/agent.gitconfig",
        },
        mounts: [
          {
            hostPath: codexHome,
            sandboxPath: "/home/agent/.codex",
          },
        ],
      }),
      branchStrategy: {
        type: "branch",
        branch,
      },
      promptFile: path.join(config.repoRoot, ".sandcastle", "prompt.md"),
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
        path: path.join(sandcastleLogDir, `issue-${issue.number}-${Date.now()}.log`),
      },
    });
  } catch (error) {
    const detail = await latestCodexSessionDiagnostic(codexHome);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(detail ? `${message}\n\n${detail}` : message);
  }

  return {
    stdout: result.stdout ?? "",
    logFilePath: result.logFilePath,
    sessionId: result.iterations.at(-1)?.sessionId,
  } satisfies AgentRunResult;
}

async function latestCodexSessionDiagnostic(codexHome: string) {
  const now = new Date();
  const sessionsDir = path.join(
    codexHome,
    "sessions",
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  );

  let files;
  try {
    files = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return "";
  }

  const jsonlFiles = await Promise.all(
    files
      .filter((file) => file.isFile() && file.name.endsWith(".jsonl"))
      .map(async (file) => {
        const filePath = path.join(sessionsDir, file.name);
        const stat = await fs.stat(filePath);
        return { filePath, mtimeMs: stat.mtimeMs };
      }),
  );

  const latest = jsonlFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!latest) return "";

  const content = await fs.readFile(latest.filePath, "utf8");
  const diagnosticLines: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        payload?: {
          type?: string;
          message?: string;
          error?: { message?: string };
          last_agent_message?: string | null;
        };
      };
      if (event.payload?.type === "error" && event.payload.message) {
        diagnosticLines.push(event.payload.message);
      }
      if (event.payload?.type === "turn.failed" && event.payload.error?.message) {
        diagnosticLines.push(event.payload.error.message);
      }
      if (event.payload?.type === "task_complete" && event.payload.last_agent_message === null) {
        diagnosticLines.push("Codex task completed without an assistant message.");
      }
    } catch {
      // Ignore malformed lines from partially-written JSONL logs.
    }
  }

  const unique = [...new Set(diagnosticLines)].slice(-5);
  if (unique.length === 0) return "";
  return `Latest Codex session diagnostics (${latest.filePath}):\n${unique.join("\n")}`;
}

function codexAgentEnv() {
  const env: Record<string, string> = {
    CODEX_HOME: "/home/agent/.codex",
  };

  if (config.codexAuthMode === "api-key") {
    env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
  }

  return env;
}

async function ensureCodexApiKeyLogin(codexHome: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for Codex login.");
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "--user",
        "10001:10001",
        "-i",
        "-e",
        "HOME=/home/agent",
        "-e",
        "CODEX_HOME=/home/agent/.codex",
        "-v",
        `${codexHome}:/home/agent/.codex`,
        config.sandcastleImage,
        "codex",
        "login",
        "--with-api-key",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end(`${apiKey}\n`);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `codex login failed with exit code ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ),
      );
    });
  });
}

export function extractHumanQuestion(stdout: string) {
  const match = stdout.match(/<human-attention>([\s\S]*?)<\/human-attention>/i);
  return match?.[1]?.trim();
}
