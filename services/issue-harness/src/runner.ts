import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./env.js";
import { TrackerIssue } from "./github.js";
import { createExecutionBranch, branchHasCommits } from "./repository.js";
import { assertAgentRunPublishable, COMPLETION_MARKER, hasHumanAttention } from "./completion.js";
import { createPublicationArtifact, loadPublicationArtifact } from "./artifact.js";
import { OpenCodeClient } from "./opencode-client.js";
import { parseChangedFileStats, summarizeWorkerResult } from "./progress.js";
import type { TaskFileView } from "./task-view.js";
import { buildIssuePrompt, resumeWorkerPrompt } from "./worker-prompt.js";

export { buildIssuePrompt } from "./worker-prompt.js";

const execFileAsync = promisify(execFile);

export type AgentRunResult = {
  stdout: string;
  sessionId: string;
  childSessionPath: string;
  summary?: string;
  files?: TaskFileView[];
  modelId?: string;
  generationStartedAt?: string;
  generationCompletedAt?: string;
  publicationArtifact?: Awaited<ReturnType<typeof createPublicationArtifact>>;
};

function defaultClient() {
  return new OpenCodeClient({
    baseUrl: config.openCodeServerUrl,
    internalToken: config.openCodeInternalToken,
    modelId: config.openCodeModelId,
    parentDirectory: config.openCodeParentDirectory,
  });
}

export async function startAgentSession(
  issue: NonNullable<TrackerIssue>,
  branch: string,
  comments: string,
  workspace: string,
  parentSessionId?: string,
  client = defaultClient(),
) {
  await createExecutionBranch(workspace, branch);
  const sessionId = await client.createChild({
    parentSessionId,
    directory: workspace,
    title: `Issue #${issue.number}: ${issue.title}`,
  });
  return {
    sessionId,
    childSessionPath: client.childSessionPath(workspace, sessionId),
    prompt: buildIssuePrompt(issue, branch, comments),
  };
}

export async function completeAgentSession(options: {
  issue: NonNullable<TrackerIssue>;
  branch: string;
  workspace: string;
  baseSha: string;
  sessionId: string;
  prompt: string;
  client?: OpenCodeClient;
  onProgress?: (parts: unknown[]) => void | Promise<void>;
}) {
  const client = options.client ?? defaultClient();
  const result = await client.continueSession({
    sessionId: options.sessionId,
    directory: options.workspace,
    prompt: options.prompt,
    onProgress: options.onProgress,
  });
  return finalizeAgentResponse({ ...options, ...result, stdout: result.text, client });
}

export async function resumeAgentSession(options: {
  issue: NonNullable<TrackerIssue>;
  branch: string;
  workspace: string;
  baseSha: string;
  sessionId: string;
  humanReply: string;
  client?: OpenCodeClient;
  onProgress?: (parts: unknown[]) => void | Promise<void>;
}) {
  return completeAgentSession({
    ...options,
    prompt: resumeWorkerPrompt(options.humanReply),
  });
}

export async function runAgent(
  issue: NonNullable<TrackerIssue>,
  branch: string,
  comments: string,
  workspace: string,
  baseSha: string,
  parentSessionId?: string,
  client = defaultClient(),
) {
  const started = await startAgentSession(issue, branch, comments, workspace, parentSessionId, client);
  return completeAgentSession({
    issue,
    branch,
    workspace,
    baseSha,
    sessionId: started.sessionId,
    prompt: started.prompt,
    client,
  });
}

async function finalizeAgentResponse(options: {
  issue: NonNullable<TrackerIssue>;
  branch: string;
  workspace: string;
  baseSha: string;
  sessionId: string;
  stdout: string;
  modelId?: string;
  generationStartedAt?: string;
  generationCompletedAt?: string;
  client: OpenCodeClient;
}) {
  const hasBranchCommits = await branchHasCommits(options.workspace, options.baseSha, options.branch);
  assertAgentRunPublishable({
    stdout: options.stdout,
    completionSignal: options.stdout.includes(COMPLETION_MARKER) ? COMPLETION_MARKER : undefined,
    hasBranchCommits,
  });
  const publicationArtifact = hasHumanAttention(options.stdout)
    ? undefined
    : await createPublicationArtifact({
        dataDir: config.dataDir,
        issueNumber: options.issue.number,
        branch: options.branch,
        workspace: options.workspace,
        baseSha: options.baseSha,
        configuredSecrets: [config.healthDetailsToken, config.openCodeInternalToken],
      });
  const files = publicationArtifact
    ? await changedFileViews(options, (await loadPublicationArtifact({
        dataDir: config.dataDir,
        issueNumber: options.issue.number,
        branch: options.branch,
        reference: publicationArtifact,
      })).manifest.paths)
    : undefined;
  return {
    stdout: options.stdout,
    sessionId: options.sessionId,
    childSessionPath: options.client.childSessionPath(options.workspace, options.sessionId),
    summary: summarizeWorkerResult(options.stdout),
    files,
    ...(options.modelId ? { modelId: options.modelId } : {}),
    ...(options.generationStartedAt ? { generationStartedAt: options.generationStartedAt } : {}),
    ...(options.generationCompletedAt ? { generationCompletedAt: options.generationCompletedAt } : {}),
    publicationArtifact,
  } satisfies AgentRunResult;
}

async function changedFileViews(
  options: { workspace: string; baseSha: string; branch: string },
  trustedPaths: string[],
) {
  const result = await execFileAsync("git", [
    "-c", "core.hooksPath=/dev/null",
    "diff", "--numstat", "--no-renames", options.baseSha, options.branch, "--",
  ], {
    cwd: options.workspace,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: "/dev/null",
      XDG_CONFIG_HOME: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
    },
    maxBuffer: 2 * 1024 * 1024,
  });
  return parseChangedFileStats(result.stdout, trustedPaths);
}
