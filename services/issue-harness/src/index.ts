import { config } from "./env.js";
import { humanAttentionQuestion } from "./completion.js";
import { branchName } from "./git.js";
import { GithubTracker } from "./github.js";
import { createGitHubAppCredentials } from "./github-app.js";
import { startHealthServer } from "./health.js";
import {
  completeAgentSession,
  resumeAgentSession,
  startAgentSession,
  type AgentRunResult,
} from "./runner.js";
import {
  githubGitAuthEnv,
  githubRepositoryRemote,
  prepareIsolatedExecutionWorkspace,
} from "./repository.js";
import { nextRunAction, recoverStalePublication, StateStore, type IssueRunState } from "./state.js";
import {
  acquireProcessLock,
  ensurePrivateRuntimeDirectory,
  ensureRuntimeIdentity,
} from "./security.js";
import { publishArtifact, StalePublicationArtifactError } from "./publisher.js";
import { RunScheduler } from "./scheduler.js";
import { parseParentSessionId } from "./opencode.js";
import { refreshContextCheckout, withFreshContext } from "./context.js";
import { OpenCodeClient } from "./opencode-client.js";
import { retryTransient } from "./retry.js";
import { cleanupExpiredWorkspaces } from "./retention.js";
import { appendObservedStage, stageFromMessageParts } from "./progress.js";
import { workerFailureQuestion } from "./worker-error.js";
import { acceptsHumanAnswer, acceptsTechnicalRetry, sanitizeTaskView, taskViewsForParent, technicalRetryTransition, workerSessionDirectory, type TaskStatus, type TaskView } from "./task-view.js";

const state = new StateStore(config.dataDir);
const remoteUrl = githubRepositoryRemote(config.owner, config.repo);
const outboundSecrets = [config.healthDetailsToken, config.openCodeInternalToken];
const openCode = new OpenCodeClient({
  baseUrl: config.openCodeServerUrl,
  internalToken: config.openCodeInternalToken,
  modelId: config.openCodeModelId,
  parentDirectory: config.openCodeParentDirectory,
});

let tracker: GithubTracker;
let getGitHubToken: () => Promise<string>;
const scheduler = new RunScheduler<NonNullable<Awaited<ReturnType<GithubTracker["nextIssue"]>>>>(
  config.maxConcurrentRuns,
  (issue) => issue.number,
);
let lastSuccessfulPollAt: number | null = null;
let lastWorkerHeartbeatAt: number | null = null;
let pollState: "waiting" | "polling" = "waiting";
let runState: "idle" | "running" = "idle";
let contextRefresh: Promise<void> | undefined;
let workspaceCleanupInProgress = false;
const recoveredGenerationMetadata = new Map<string, Awaited<ReturnType<OpenCodeClient["sessionGenerationMetadata"]>>>();

function taskView(
  issue: { number: number; title: string; html_url?: string },
  existing: TaskView | undefined,
  patch: Partial<Omit<TaskView, "schemaVersion" | "issueNumber" | "title" | "updatedAt">>,
) {
  const timestamp = new Date().toISOString();
  return sanitizeTaskView({
    ...existing,
    schemaVersion: 1,
    issueNumber: issue.number,
    title: issue.title,
    ...(issue.html_url ? { issueUrl: issue.html_url } : existing?.issueUrl ? { issueUrl: existing.issueUrl } : {}),
    status: existing?.status ?? "running",
    stages: existing?.stages ?? ["accepted"],
    ...patch,
    updatedAt: timestamp,
  });
}

function withTaskView(
  run: Omit<IssueRunState, "updatedAt">,
  issue: { number: number; title: string; html_url?: string },
  patch: Partial<Omit<TaskView, "schemaVersion" | "issueNumber" | "title" | "updatedAt">>,
) {
  return { ...run, taskView: taskView(issue, run.taskView, patch) };
}

async function currentGitAuthEnvironment() {
  return githubGitAuthEnv(await getGitHubToken());
}

async function refreshContext() {
  if (contextRefresh) return contextRefresh;
  contextRefresh = currentGitAuthEnvironment().then((gitEnv) => refreshContextCheckout({
    contextDir: config.contextDir,
    remoteUrl,
    baseBranch: config.baseBranch,
    gitEnv,
  })).then(({ revision }) => {
    console.log(`OpenCode read-only context refreshed at ${revision}`);
  }).finally(() => {
    contextRefresh = undefined;
  });
  return contextRefresh;
}

async function tick() {
  if (workspaceCleanupInProgress) return;
  await scheduler.poll(
    async () => {
      pollState = "polling";
      try {
        const issue = await tracker.nextIssue();
        lastSuccessfulPollAt = Date.now();
        return issue;
      } finally {
        pollState = "waiting";
      }
    },
    async (issue) => {
      runState = "running";
      try {
        await processIssue(issue);
      } finally {
        runState = "idle";
      }
    },
  );
}

async function cleanupWorkspaceStorage(options: { onlyWhenIdle?: boolean } = {}) {
  if (workspaceCleanupInProgress) return;
  if (options.onlyWhenIdle && (pollState !== "waiting" || runState !== "idle")) return;
  workspaceCleanupInProgress = true;
  try {
    await cleanupExpiredWorkspaces({
      dataDir: config.dataDir,
      states: state.all(),
      retentionMs: config.workspaceRetentionMs,
    });
  } catch (error) {
    console.error("Workspace cleanup failed", error);
  } finally {
    workspaceCleanupInProgress = false;
  }
}

async function ensureParentSession(
  issue: NonNullable<Awaited<ReturnType<GithubTracker["nextIssue"]>>>,
  existing: IssueRunState | undefined,
) {
  const linked = existing?.parentSessionId ?? parseParentSessionId(issue.body);
  if (linked) return linked;
  const parentSessionId = await openCode.createParent({ title: `GitHub Issue #${issue.number}: ${issue.title}` });
  return parentSessionId;
}

async function processIssue(issue: NonNullable<Awaited<ReturnType<GithubTracker["nextIssue"]>>>) {
  const existing = state.get(issue.number);
  const branch = existing?.branch ?? branchName(issue.number, issue.title);
  let parentSessionId: string | undefined;
  try {
    parentSessionId = await ensureParentSession(issue, existing);
  } catch (error) {
    console.error("OpenCode parent creation failed; Issue remains queued for retry", error);
    return;
  }
  if (!existing) {
    await state.set(withTaskView({
      issueNumber: issue.number,
      branch,
      status: "running",
      parentSessionId,
    }, issue, { status: "running", stages: ["accepted"] }));
  }

  const action = nextRunAction(existing);
  if (action === "finalize") {
    await tracker.moveStatus(issue.number, "finished");
    return;
  }

  await tracker.moveStatus(issue.number, "running");
  if (!existing) await tracker.comment(issue.number, `OpenCode picked this up on branch \`${branch}\`.`);

  if (action === "publish") {
    if (existing) {
      const { updatedAt: _updatedAt, pendingHumanReply: _reply, awaitingAction: _action, ...persisted } = existing;
      await state.set({ ...persisted, status: "publish_pending", parentSessionId });
    }
    await publishIssue(issue, branch);
    return;
  }

  if (action === "resume" && existing) {
    await resumeCoding(issue, existing, parentSessionId);
    return;
  }

  await startCoding(issue, branch, parentSessionId, existing);
}

async function startCoding(
  issue: NonNullable<Awaited<ReturnType<GithubTracker["nextIssue"]>>>,
  branch: string,
  parentSessionId: string,
  existing: IssueRunState | undefined,
) {
  const initial = state.get(issue.number) ?? existing;
  if (initial) await state.set(withTaskView(
    withoutTimestamp(initial),
    issue,
    { status: "running", stages: appendObservedStage(initial.taskView?.stages ?? ["accepted"], "studying") },
  ));
  await ensurePrivateRuntimeDirectory(config.dataDir);
  let execution;
  try {
    execution = await prepareIsolatedExecutionWorkspace({
      dataDir: config.dataDir,
      issueNumber: issue.number,
      remoteUrl,
      baseBranch: config.baseBranch,
      gitEnv: await currentGitAuthEnvironment(),
    });
  } catch (error) {
    console.error("Workspace preparation failed", error);
    const current = state.get(issue.number);
    await waitForHuman(issue, current ? {
      ...withoutTimestamp(current),
      status: "awaiting_human",
      awaitingAction: "rerun",
    } : {
      issueNumber: issue.number,
      branch,
      status: "awaiting_human",
      parentSessionId,
      awaitingAction: "rerun",
    }, "Не удалось подготовить рабочую копию. Проверьте GitHub и отправьте /retry в этом чате.", "failed");
    return;
  }

  try {
    const comments = await tracker.recentComments(issue.number);
    const started = await startAgentSession(
      issue,
      branch,
      comments,
      execution.workspace,
      parentSessionId,
      openCode,
    );
    const activeState: Omit<IssueRunState, "updatedAt"> = withTaskView({
      issueNumber: issue.number,
      branch,
      status: "running",
      parentSessionId,
      lastSessionId: started.sessionId,
      workspace: execution.workspace,
      baseSha: execution.baseSha,
    }, issue, {
      status: "running",
      stages: state.get(issue.number)?.taskView?.stages ?? ["accepted", "studying"],
      workerSessionPath: started.childSessionPath,
    });
    await state.set(activeState);
    await cleanupWorkspaceStorage();
    const result = await completeAgentSession({
      issue,
      branch,
      workspace: execution.workspace,
      baseSha: execution.baseSha,
      sessionId: started.sessionId,
      prompt: started.prompt,
      client: openCode,
      onProgress: async (parts) => {
        const observed = stageFromMessageParts(parts);
        if (!observed) return;
        const current = state.get(issue.number);
        if (!current) return;
        await state.set(withTaskView(withoutTimestamp(current), issue, {
          status: "running",
          stages: appendObservedStage(current.taskView?.stages ?? ["accepted"], observed),
        }));
      },
    });
    await handleAgentResult(issue, activeState, result);
  } catch (error) {
    console.error("Coding run failed", error);
    const current = state.get(issue.number);
    await waitForHuman(issue, current ? {
      ...withoutTimestamp(current),
      status: "awaiting_human",
      awaitingAction: "rerun",
    } : {
      issueNumber: issue.number,
      branch,
      status: "awaiting_human",
      parentSessionId,
      awaitingAction: "rerun",
    }, workerFailureQuestion(error), "failed");
  }
}

async function resumeCoding(
  issue: NonNullable<Awaited<ReturnType<GithubTracker["nextIssue"]>>>,
  existing: IssueRunState,
  parentSessionId: string,
) {
  const { workspace, baseSha, lastSessionId, pendingHumanReply } = existing;
  if (!workspace || !baseSha || !lastSessionId || !pendingHumanReply) {
    await waitForHuman(issue, { ...withoutTimestamp(existing), status: "awaiting_human", awaitingAction: "rerun" },
      "Не удалось восстановить рабочую сессию. Отправьте /retry в этом чате, чтобы начать задачу заново.", "failed");
    return;
  }
  const activeState = withTaskView({
    ...withoutTimestamp(existing),
    status: "running" as const,
    parentSessionId,
    pendingHumanReply: undefined,
    awaitingAction: undefined,
  }, issue, { status: "running", question: undefined });
  await state.set(activeState);
  try {
    const result = await resumeAgentSession({
      issue,
      branch: existing.branch,
      workspace,
      baseSha,
      sessionId: lastSessionId,
      humanReply: pendingHumanReply,
      client: openCode,
      onProgress: async (parts) => {
        const observed = stageFromMessageParts(parts);
        if (!observed) return;
        const current = state.get(issue.number);
        if (!current) return;
        await state.set(withTaskView(withoutTimestamp(current), issue, {
          status: "running",
          question: undefined,
          stages: appendObservedStage(current.taskView?.stages ?? ["accepted"], observed),
        }));
      },
    });
    await handleAgentResult(issue, activeState, result);
  } catch (error) {
    console.error("Coding resume failed", error);
    await waitForHuman(issue, {
      ...activeState,
      status: "awaiting_human",
      awaitingAction: "resume_child",
    }, "Не удалось продолжить рабочую сессию. Проверьте OpenCode и отправьте /retry в этом чате.", "failed");
  }
}

async function handleAgentResult(
  issue: NonNullable<Awaited<ReturnType<GithubTracker["nextIssue"]>>>,
  activeState: Omit<IssueRunState, "updatedAt">,
  result: AgentRunResult,
) {
  const latest = state.get(issue.number);
  const currentRun = latest ? withoutTimestamp(latest) : activeState;
  const question = humanAttentionQuestion(result.stdout);
  if (question) {
    await waitForHuman(issue, withTaskView({
      ...currentRun,
      status: "awaiting_human",
      lastSessionId: result.sessionId,
      awaitingAction: "resume_child",
      pendingHumanReply: undefined,
    }, issue, generationPatch(result)), question);
    return;
  }
  if (!result.publicationArtifact) throw new Error("Completed agent run did not produce a publication artifact");
  await state.set(withTaskView({
    ...currentRun,
    status: "publish_pending",
    lastSessionId: result.sessionId,
    publicationArtifact: result.publicationArtifact,
    awaitingAction: undefined,
    pendingHumanReply: undefined,
  }, issue, {
    status: "publishing",
    stages: appendObservedStage(currentRun.taskView?.stages ?? ["accepted", "studying", "coding"], "publishing"),
    workerSessionPath: result.childSessionPath,
    summary: result.summary,
    files: result.files,
    ...generationPatch(result),
  }));
  await publishIssue(issue, activeState.branch);
}

function generationPatch(result: AgentRunResult) {
  return result.modelId && result.generationStartedAt && result.generationCompletedAt ? {
    modelId: result.modelId,
    generationStartedAt: result.generationStartedAt,
    generationCompletedAt: result.generationCompletedAt,
  } : {};
}

async function projectedTaskViews(parentSessionId: string) {
  const states = state.all();
  const views = taskViewsForParent(states, parentSessionId);
  return Promise.all(views.map(async (view) => {
    if (view.modelId && view.generationStartedAt && view.generationCompletedAt) return view;
    const run = states.find((item) => item.issueNumber === view.issueNumber);
    if (!run?.lastSessionId) return view;
    let generation = recoveredGenerationMetadata.get(run.lastSessionId);
    if (!generation) {
      try {
        generation = await openCode.sessionGenerationMetadata(
          run.lastSessionId,
          workerSessionDirectory(run, config.openCodeParentDirectory),
        );
        recoveredGenerationMetadata.set(run.lastSessionId, generation);
      } catch {
        return view;
      }
    }
    return Object.keys(generation).length ? sanitizeTaskView({ ...view, ...generation }) : view;
  }));
}

async function waitForHuman(
  issue: NonNullable<Awaited<ReturnType<GithubTracker["nextIssue"]>>>,
  run: Omit<IssueRunState, "updatedAt">,
  question: string,
  cardStatus: TaskStatus = "awaiting_human",
) {
  await state.set(withTaskView(
    { ...run, status: "awaiting_human", pendingHumanReply: undefined },
    issue,
    { status: cardStatus, question },
  ));
  await tracker.needsHuman(issue.number, question);
}

async function publishIssue(
  issue: NonNullable<Awaited<ReturnType<GithubTracker["nextIssue"]>>>,
  branch: string,
) {
  let pending = state.get(issue.number);
  if (!pending?.publicationArtifact) throw new Error("Refusing to publish without an immutable publication artifact");
  await state.set(withTaskView(withoutTimestamp(pending), issue, {
    status: "publishing",
    stages: appendObservedStage(pending.taskView?.stages ?? ["accepted", "coding"], "publishing"),
    question: undefined,
  }));
  pending = state.get(issue.number);
  if (!pending?.publicationArtifact) throw new Error("Publication state was lost before publishing");
  try {
    const published = await retryTransient(async () => {
      const artifact = await publishArtifact({
        dataDir: config.dataDir,
        remoteUrl,
        baseBranch: config.baseBranch,
        issueNumber: issue.number,
        branch,
        artifact: pending.publicationArtifact!,
        gitEnv: await currentGitAuthEnvironment(),
        configuredSecrets: outboundSecrets,
      });
      const prUrl = await tracker.findOrCreatePullRequest(
        issue.number,
        branch,
        issue.title,
        `Automated OpenCode child-session run for #${issue.number}.`,
      );
      return { commitSha: artifact.commitSha, prUrl };
    }, {
      attempts: 3,
      delayMs: 1_000,
      shouldRetry: (error) => !(error instanceof StalePublicationArtifactError),
    });

    await state.set(withTaskView({
      ...withoutTimestamp(pending),
      status: "finished",
      publishedCommitSha: published.commitSha,
      prUrl: published.prUrl,
      awaitingAction: undefined,
      pendingHumanReply: undefined,
    }, issue, { status: "finished", prUrl: published.prUrl, question: undefined }));
    await tracker.moveStatus(issue.number, "finished");
    await tracker.comment(issue.number, `Finished. Pull request: ${published.prUrl}`);
    await cleanupWorkspaceStorage();
  } catch (error) {
    console.error("Publication failed", error);
    if (error instanceof StalePublicationArtifactError) {
      const recovered = recoverStalePublication(pending, new Date().toISOString());
      await waitForHuman(
        issue,
        recovered,
        "Ветка stage изменилась во время работы. Отправьте /retry в этом чате, чтобы повторить задачу на свежем коде.",
        "failed",
      );
      return;
    }
    await waitForHuman(issue, {
      ...withoutTimestamp(pending),
      status: "awaiting_human",
      awaitingAction: "retry_publish",
    }, "Код готов, но после трёх попыток не удалось опубликовать PR. Проверьте соединение с GitHub и отправьте /retry в этом чате, чтобы повторить только публикацию.", "failed");
  }
}

function withoutTimestamp(run: IssueRunState): Omit<IssueRunState, "updatedAt"> {
  const { updatedAt: _updatedAt, ...persisted } = run;
  return persisted;
}

async function reconcilePersistedStates() {
  for (const loaded of state.all()) {
    let run = loaded;
    if (!run.taskView && run.parentSessionId) {
      const migratedStatus: TaskStatus = run.status === "finished" ? "finished"
        : run.status === "publish_pending" ? "publishing"
          : run.status === "awaiting_human" || run.status === "failed" ? "failed" : "running";
      const migratedStages = run.status === "finished" || run.status === "publish_pending"
        ? ["accepted", "studying", "coding", "publishing"] as const
        : ["accepted", "studying"] as const;
      await state.set(withTaskView(withoutTimestamp(run), {
        number: run.issueNumber,
        title: `Issue #${run.issueNumber}`,
      }, {
        status: migratedStatus,
        stages: [...migratedStages],
        ...(run.prUrl ? { prUrl: run.prUrl } : {}),
        ...(run.lastSessionId && run.workspace ? {
          workerSessionPath: openCode.childSessionPath(run.workspace, run.lastSessionId),
        } : {}),
      }));
      run = state.get(run.issueNumber)!;
    }
    if (run.status === "finished") {
      await tracker.moveStatus(run.issueNumber, "finished");
      continue;
    }
    if (run.status === "publish_pending") {
      await tracker.moveStatus(run.issueNumber, "todo");
      continue;
    }
    if (run.status === "failed" || run.status === "awaiting_human") {
      const awaitingAction = run.awaitingAction
        ?? (run.publicationArtifact ? "retry_publish"
          : run.lastSessionId && run.workspace && run.baseSha ? "resume_child" : "rerun");
      let reconciled: Omit<IssueRunState, "updatedAt"> = {
        ...withoutTimestamp(run),
        status: "awaiting_human",
        awaitingAction,
      };
      if (run.lastSessionId && run.workspace) {
        try {
          const failure = await openCode.sessionFailure(run.lastSessionId, run.workspace);
          if (failure) {
            reconciled = withTaskView(reconciled, {
              number: run.issueNumber,
              title: run.taskView?.title ?? `Issue #${run.issueNumber}`,
              html_url: run.taskView?.issueUrl,
            }, { status: "failed", question: workerFailureQuestion(failure) });
          }
        } catch {}
      }
      await state.set(reconciled);
      await tracker.markNeedsHuman(run.issueNumber);
      continue;
    }
    await tracker.moveStatus(run.issueNumber, "running");
  }
}

async function main() {
  const githubCredentials = await createGitHubAppCredentials({
    appId: config.githubAppId,
    installationId: config.githubAppInstallationId,
    privateKeyPath: config.githubAppPrivateKeyPath,
  });
  tracker = new GithubTracker(githubCredentials.octokit);
  getGitHubToken = githubCredentials.getToken;
  await ensureRuntimeIdentity(config.dataDir, `${config.owner}/${config.repo}`);
  await acquireProcessLock(config.dataDir);
  await state.load();
  await tracker.assertRepositoryAccess();
  await tracker.ensureLabels();
  await reconcilePersistedStates();
  await cleanupWorkspaceStorage();
  await refreshContext();
  await startHealthServer({
    port: config.healthPort,
    repository: `${config.owner}/${config.repo}`,
    workspaceOrigin: remoteUrl,
    isReady: () => {
      const staleAfterMs = Math.max(config.pollIntervalMs * 3, 180_000);
      const pollIsFresh = lastSuccessfulPollAt !== null && Date.now() - lastSuccessfulPollAt < staleAfterMs;
      const heartbeatIsFresh = lastWorkerHeartbeatAt !== null && Date.now() - lastWorkerHeartbeatAt < staleAfterMs;
      return pollIsFresh || (runState === "running" && heartbeatIsFresh);
    },
    getWorkerHeartbeatAt: () => lastWorkerHeartbeatAt,
    getWorkerActivity: () => ({ poll: pollState, run: runState }),
    workerHeartbeatStaleAfterMs: Math.max(config.pollIntervalMs * 3, 180_000),
    healthDetailsToken: config.healthDetailsToken,
    commandToken: config.harnessCommandToken,
    getBlockingIssue: async (parentSessionId) => {
      const persisted = state.getByParentSession(parentSessionId);
      if (persisted) return { number: persisted.issueNumber };
      const issue = await tracker.findBlockingIssue(parentSessionId);
      return issue ? { number: issue.number } : null;
    },
    createIssue: async (request) => {
      const created = await tracker.createIssue(request);
      const parentSessionId = parseParentSessionId(request.body);
      if (!parentSessionId) throw new Error("Harness-created Issue is missing its parent session marker");
      const issue = { number: created.number, title: request.title, html_url: created.url };
      const claimed = state.get(created.number);
      await state.set(withTaskView(
        claimed ? withoutTimestamp(claimed) : {
          issueNumber: created.number,
          branch: branchName(created.number, request.title),
          status: "running",
          parentSessionId,
        },
        issue,
        claimed?.taskView
          ? { status: claimed.taskView.status, stages: claimed.taskView.stages }
          : { status: "queued", stages: ["accepted"] },
      ));
      return created;
    },
    getTaskViews: projectedTaskViews,
    submitHumanAnswer: withFreshContext(refreshContext, async ({ text, parentSessionId }) => {
      const current = state.getByParentSession(parentSessionId);
      if (!current || !acceptsHumanAnswer(current) || !current.awaitingAction) return null;
      await state.set(withTaskView({
        ...withoutTimestamp(current),
        status: "running",
        pendingHumanReply: text,
      }, {
        number: current.issueNumber,
        title: current.taskView?.title ?? `Issue #${current.issueNumber}`,
        html_url: current.taskView?.issueUrl,
      }, { status: "running", question: undefined }));
      await tracker.moveStatus(current.issueNumber, "todo");
      return { issueNumber: current.issueNumber };
    }),
    submitRetry: async ({ parentSessionId, instruction }) => {
      const current = state.getByParentSession(parentSessionId);
      if (!current || !acceptsTechnicalRetry(current)) return null;
      const retry = technicalRetryTransition(withoutTimestamp(current), instruction ?? "");
      if (instruction) {
        await tracker.comment(current.issueNumber, `Дополнительное указание для повторного запуска:\n\n${instruction}`);
      }
      await state.set(withTaskView(retry, {
        number: current.issueNumber,
        title: current.taskView?.title ?? `Issue #${current.issueNumber}`,
        html_url: current.taskView?.issueUrl,
      }, { status: "queued", question: undefined }));
      await tracker.moveStatus(current.issueNumber, "todo");
      return { issueNumber: current.issueNumber };
    },
  });
  console.log(`Issue harness started for ${config.owner}/${config.repo}`);

  const heartbeatIntervalMs = Math.min(10_000, Math.max(1_000, Math.floor(config.pollIntervalMs / 3)));
  lastWorkerHeartbeatAt = Date.now();
  setInterval(() => { lastWorkerHeartbeatAt = Date.now(); }, heartbeatIntervalMs).unref();
  const poll = () => { tick().catch((error) => console.error(error)); };
  setInterval(poll, config.pollIntervalMs);
  setInterval(() => {
    refreshContext().catch((error) => console.error("Context refresh failed", error));
  }, config.contextRefreshMs).unref();
  setInterval(() => {
    cleanupWorkspaceStorage({ onlyWhenIdle: true }).catch((error) => console.error("Workspace cleanup failed", error));
  }, 60 * 60 * 1000).unref();
  poll();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
