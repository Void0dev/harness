import path from "node:path";
import fs from "node:fs/promises";
import { codex, run } from "@ai-hero/sandcastle";
import { config } from "./env.js";
import { assertAgentRunPublishable, COMPLETION_MARKER, hasHumanAttention } from "./completion.js";
import { TrackerIssue } from "./github.js";
import { branchHasCommits } from "./repository.js";
import { createPublicationArtifact, PublicationArtifactReference } from "./artifact.js";
import {
  assertNoRepositoryEnvironmentPassthrough,
  ensurePrivateRuntimeDirectory,
  sandboxControlEnvironment,
  withSanitizedProcessEnvironment,
} from "./security.js";
import { hardenedDocker, mintBrokerToken } from "./runtime.js";

export type AgentRunResult = {
  stdout: string;
  logFilePath?: string;
  sessionId?: string;
  publicationArtifact?: PublicationArtifactReference;
};

export async function runAgent(
  issue: NonNullable<TrackerIssue>,
  branch: string,
  comments: string,
  workspace: string,
  baseSha: string,
) {
  const runRoot = path.join(config.dataDir, "runs");
  const sandcastleLogDir = path.join(config.dataDir, "sandcastle");
  await ensurePrivateRuntimeDirectory(runRoot);
  await ensurePrivateRuntimeDirectory(sandcastleLogDir);
  await assertNoRepositoryEnvironmentPassthrough(workspace);
  const codexHome = await fs.mkdtemp(path.join(runRoot, `issue-${issue.number}-codex-`));
  await fs.chmod(codexHome, 0o700);
  const brokerToken = mintBrokerToken({
    signingSecret: config.codexBrokerSigningSecret,
    audience: config.codexBrokerAudience,
    repository: `${config.owner}/${config.repo}`,
    issueNumber: issue.number,
    ttlSeconds: config.codexBrokerTokenTtlSeconds,
  });

  let result;
  try {
    result = await withSanitizedProcessEnvironment(() => run({
      cwd: workspace,
      agent: codex(config.codexModel, {
        effort: config.codexReasoningEffort as "low" | "medium" | "high" | "xhigh",
        env: codexAgentEnv(brokerToken),
      }),
      sandbox: hardenedDocker({
        imageName: config.sandcastleImage,
        containerUid: 10001,
        containerGid: 10001,
        environment: {
          HOME: "/home/agent",
          GIT_CONFIG_GLOBAL: "/tmp/agent.gitconfig",
          ...sandboxControlEnvironment(),
        },
        network: config.sandboxNetwork,
        memoryMb: config.sandboxMemoryMb,
        cpus: config.sandboxCpus,
        pidsLimit: config.sandboxPidsLimit,
        tmpfsMb: config.sandboxTmpfsMb,
        maxOutputBytes: config.sandboxMaxOutputBytes,
        requireRootlessDaemon: config.sandboxDaemonMode === "local-rootless",
        expectedDaemonId: config.sandboxDockerDaemonId,
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
      promptFile: path.join(workspace, ".sandcastle", "prompt.md"),
      promptArgs: {
        ISSUE_NUMBER: String(issue.number),
        ISSUE_TITLE: issue.title,
        ISSUE_BODY: issue.body ?? "",
        ISSUE_COMMENTS: comments || "No comments yet.",
        REPO: `${config.owner}/${config.repo}`,
      },
      maxIterations: 1,
      idleTimeoutSeconds: 900,
      completionSignal: COMPLETION_MARKER,
      logging: {
        type: "file",
        path: path.join(sandcastleLogDir, `issue-${issue.number}-${Date.now()}.log`),
      },
    }));
  } catch (error) {
    const detail = await latestCodexSessionDiagnostic(codexHome);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(detail ? `${message}\n\n${detail}` : message);
  } finally {
    await fs.rm(codexHome, { recursive: true, force: true });
  }

  const stdout = result.stdout ?? "";
  const needsHuman = hasHumanAttention(stdout);
  const hasBranchCommits = needsHuman
    ? false
    : result.commits.length > 0 || await branchHasCommits(
      workspace,
      baseSha,
      branch,
    );
  assertAgentRunPublishable({
    stdout,
    completionSignal: result.completionSignal,
    hasBranchCommits,
  });

  const publicationArtifact = needsHuman
    ? undefined
    : await createPublicationArtifact({
      dataDir: config.dataDir,
      issueNumber: issue.number,
      branch,
      workspace,
      baseSha,
      configuredSecrets: [
        config.githubToken,
        config.codexBrokerSigningSecret,
        config.healthDetailsToken,
      ],
    });

  return {
    stdout,
    logFilePath: result.logFilePath,
    sessionId: result.iterations.at(-1)?.sessionId,
    publicationArtifact,
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

  const content = await readFileTail(latest.filePath, 256 * 1024);
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

function codexAgentEnv(brokerToken: string) {
  return {
    CODEX_HOME: "/home/agent/.codex",
    OPENAI_BASE_URL: config.codexBrokerUrl,
    OPENAI_API_KEY: brokerToken,
  };
}

async function readFileTail(filePath: string, maxBytes: number) {
  const stat = await fs.stat(filePath);
  const length = Math.min(stat.size, maxBytes);
  const file = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, stat.size - length);
    return buffer.toString("utf8");
  } finally {
    await file.close();
  }
}
