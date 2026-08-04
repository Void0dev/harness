import { config } from "./env.js";
import { assertDraftPullRequestMatchesRun, humanAttentionQuestion } from "./completion.js";
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
  branchHead,
  githubGitAuthEnv,
  githubRepositoryRemote,
  prepareIsolatedExecutionWorkspace,
} from "./repository.js";
import { nextRunAction, StateStore, type IssueRunState } from "./state.js";
import {
  acquireProcessLock,
  ensurePrivateRuntimeDirectory,
  ensureRuntimeIdentity,
} from "./security.js";
import { RunScheduler } from "./scheduler.js";
import { parseIssueModelId, parseParentSessionId } from "./opencode.js";
import { prepareProjectWorkspace as prepareWorkspaceCheckout } from "./context.js";
import { OpenCodeClient } from "./opencode-client.js";
import { retryTransient } from "./retry.js";
import { cleanupExpiredWorkspaces, cleanupPrunedFinishedWorkspaces } from "./retention.js";
import { appendObservedStage, stageFromMessageParts } from "./progress.js";
import { workerFailureQuestion } from "./worker-error.js";
import { acceptsHumanAnswer, acceptsTechnicalRetry, sanitizeTaskView, taskViewsForParent, technicalRetryTransition, workerSessionDirectory, type TaskStatus, type TaskView } from "./task-view.js";
import { evaluateHumanCommentWindow } from "./human-comments.js";
import { HarnessRuntime } from "./runtime.js";
import { startPublicGateway } from "../../../opencode/lib/public-gateway.mjs";

const state = new StateStore(config.dataDir);
const remoteUrl = githubRepositoryRemote(config.owner, config.repo);
const openCode = new OpenCodeClient({
  baseUrl: config.openCodeServerUrl,
  internalToken: config.openCodeInternalToken,
  modelId: config.openCodeModelId,
  parentDirectory: config.openCodeParentDirectory,
});

function openCodeForIssue(body: string | null | undefined) {
  return new OpenCodeClient({
    baseUrl: config.openCodeServerUrl,
    internalToken: config.openCodeInternalToken,
    modelId: parseIssueModelId(body, config.openCodeModelId),
    parentDirectory: config.openCodeParentDirectory,
  });
}

let tracker: GithubTracker;
let getGitHubToken: () => Promise<string>;
const scheduler = new RunScheduler<NonNullable<Awaited<ReturnType<GithubTracker["nextIssue"]>>>>(
  config.maxConcurrentRuns,
  (issue) => issue.number,
);
const runtime = new HarnessRuntime();
let lastSuccessfulPollAt: number | null = null;
let lastWorkerHeartbeatAt: number | null = null;
let pollState: "waiting" | "polling" = "waiting";
let runState: "idle" | "running" = "idle";
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

async function prepareProjectWorkspace() {
  const { revision, updated } = await prepareWorkspaceCheckout({
    contextDir: config.contextDir,
    remoteUrl,
    baseBranch: config.baseBranch,
    gitEnv: await currentGitAuthEnvironment(),
  });
  console.log(`OpenCode project workspace ready at ${revision}${updated ? " (fast-forwarded)" : ""}`);
}

async function tick() {
  if (workspaceCleanupInProgress) return;
  lastWorkerHeartbeatAt = Date.now();
  await reconcileHumanCommentReplies();
  lastWorkerHeartbeatAt = Date.now();
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
      lastWorkerHeartbeatAt = Date.now();
      try {
        await processIssue(issue);
      } finally {
        runState = "idle";
        lastWorkerHeartbeatAt = Date.now();
      }
    },
  );
}

async function cleanupWorkspaceStorage(options: { onlyWhenIdle?: boolean } = {}) {
  if (workspaceCleanupInProgress) return;
  if (options.onlyWhenIdle && (pollState !== "waiting" || runState !== "idle")) return;
  workspaceCleanupInProgress = true;
  try {
    const states = state.all();
    await cleanupExpiredWorkspaces({
      dataDir: config.dataDir,
      states,
      retentionMs: config.workspaceRetentionMs,
    });
    await state.pruneFinished(500, async (pruned) => {
      await cleanupPrunedFinishedWorkspaces({ dataDir: config.dataDir, states: pruned });
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
  client: OpenCodeClient,
) {
  const linked = existing?.parentSessionId ?? parseParentSessionId(issue.body);
  if (linked) return linked;
  const parentSessionId = await client.createParent({ title: `GitHub Issue #${issue.number}: ${issue.title}` });
  return parentSessionId;
}

async function processIssue(issue: NonNullable<Awaited<ReturnType<GithubTracker["nextIssue"]>>>) {
  const existing = state.get(issue.number);
  const branch = existing?.branch ?? branchName(issue.number, issue.title);
  const issueOpenCode = openCodeForIssue(issue.body);
  let parentSessionId: string | undefined;
  try {
    parentSessionId = await ensureParentSession(issue, existing, issueOpenCode);
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
  if (action === "wait" && existing) {
    await synchronizeWaitingIssue(issue, existing);
    return;
  }
  if (action === "reconcile-publication" && existing) {
    await reconcilePublication(issue, existing);
    return;
  }

  await tracker.moveStatus(issue.number, "running");
  if (!existing) await tracker.comment(issue.number, `OpenCode picked this up on branch \`${branch}\`.`);

  if (action === "resume" && existing) {
    await resumeCoding(issue, existing, parentSessionId, issueOpenCode);
    return;
  }

  await startCoding(issue, branch, parentSessionId, existing, issueOpenCode);
}

async function startCoding(
  issue: NonNullable<Awaited<ReturnType<GithubTracker["nextIssue"]>>>,
  branch: string,
  parentSessionId: string,
  existing: IssueRunState | undefined,
  client: OpenCodeClient,
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
      client,
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
      client,
      signal: runtime.signal,
      onProgress: async (parts) => {
        lastWorkerHeartbeatAt = Date.now();
        const observed = stageFromMessageParts(parts);
        if (!observed) return;
        const current = state.get(issue.number);
        if (!current) return;
        if (current.taskView?.stages.includes(observed)) return;
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
  client: OpenCodeClient,
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
      client,
      signal: runtime.signal,
      onProgress: async (parts) => {
        lastWorkerHeartbeatAt = Date.now();
        const observed = stageFromMessageParts(parts);
        if (!observed) return;
        const current = state.get(issue.number);
        if (!current) return;
        if (current.taskView?.stages.includes(observed)) return;
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

async function reconcilePublication(
  issue: NonNullable<Awaited<ReturnType<GithubTracker["nextIssue"]>>>,
  run: IssueRunState,
) {
  if (!run.workspace) {
    await waitForHuman(issue, {
      ...withoutTimestamp(run),
      status: "awaiting_human",
      awaitingAction: "rerun",
    }, "Harness не смог восстановить рабочую копию для проверки draft PR. Отправьте /retry в этом чате.", "failed");
    return;
  }
  let pullRequest;
  try {
    const headSha = await branchHead(run.workspace, run.branch);
    pullRequest = await retryTransient(async () => {
      const found = await tracker.findHarnessPullRequest(issue.number, run.branch);
      if (!found) throw new Error("The expected draft pull request is not visible yet");
      assertDraftPullRequestMatchesRun({
        pullRequest: found,
        branch: run.branch,
        headSha,
        baseBranch: config.baseBranch,
      });
      return found;
    }, { attempts: 3, delayMs: 1_000 });
  } catch (error) {
    console.error("Persisted pull request reconciliation failed", error);
    await waitForHuman(issue, {
      ...withoutTimestamp(run),
      status: "awaiting_human",
      awaitingAction: run.lastSessionId && run.workspace && run.baseSha ? "resume_child" : "rerun",
    }, "Harness не смог подтвердить draft PR после перезапуска. Проверьте GitHub и отправьте /retry в этом чате.", "failed");
    return;
  }
  await state.set(withTaskView({
    ...withoutTimestamp(run),
    status: "finished",
    prUrl: pullRequest.url,
  }, issue, { status: "finished", prUrl: pullRequest.url, question: undefined }));
  try {
    await tracker.moveStatus(issue.number, "finished");
    await tracker.comment(issue.number, `Finished. Pull request: ${pullRequest.url}`);
  } catch (error) {
    console.error("Reconciled Issue synchronization failed", error);
  }
  await cleanupWorkspaceStorage();
}

async function synchronizeWaitingIssue(
  issue: NonNullable<Awaited<ReturnType<GithubTracker["nextIssue"]>>>,
  run: IssueRunState,
) {
  if (run.status !== "awaiting_human") return;
  await synchronizePersistedAttention(issue.number, run);
}

async function synchronizePersistedAttention(issueNumber: number, run: IssueRunState) {
  const question = run.taskView?.question;
  if (!question) {
    await tracker.markNeedsHuman(issueNumber);
    return;
  }
  const comment = await tracker.ensureHumanQuestion(issueNumber, question);
  const current = state.get(issueNumber);
  if (current && acceptsHumanAnswer(current) && !current.humanQuestionCommentId) {
    await state.set({ ...withoutTimestamp(current), humanQuestionCommentId: comment.id });
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
  const verifying = withTaskView({
    ...currentRun,
    status: "running",
    lastSessionId: result.sessionId,
    awaitingAction: undefined,
    pendingHumanReply: undefined,
  }, issue, {
    status: "publishing",
    stages: appendObservedStage(currentRun.taskView?.stages ?? ["accepted", "studying", "coding"], "publishing"),
    workerSessionPath: result.childSessionPath,
    summary: result.summary,
    files: result.files,
    ...generationPatch(result),
  });
  await state.set(verifying);
  let pullRequest;
  try {
    pullRequest = await retryTransient(async () => {
      const found = await tracker.findHarnessPullRequest(issue.number, activeState.branch);
      if (!found) throw new Error("The coding agent did not create the expected draft pull request");
      if (!result.headSha) throw new Error("The completed coding run is missing its branch head SHA");
      assertDraftPullRequestMatchesRun({
        pullRequest: found,
        branch: activeState.branch,
        headSha: result.headSha,
        baseBranch: config.baseBranch,
      });
      return found;
    }, { attempts: 3, delayMs: 1_000 });
  } catch (error) {
    console.error("Pull request verification failed", error);
    await waitForHuman(issue, {
      ...verifying,
      status: "awaiting_human",
      awaitingAction: "resume_child",
    }, "Агент завершил работу, но ожидаемый draft PR в stage не найден. Проверьте GitHub и отправьте /retry в этом чате, чтобы агент повторил публикацию.", "failed");
    return;
  }
  await state.set(withTaskView({
    ...verifying,
    status: "finished",
    prUrl: pullRequest.url,
  }, issue, { status: "finished", prUrl: pullRequest.url, question: undefined }));
  try {
    await tracker.moveStatus(issue.number, "finished");
    await tracker.comment(issue.number, `Finished. Pull request: ${pullRequest.url}`);
  } catch (error) {
    console.error("Finished Issue synchronization failed", error);
  }
  await cleanupWorkspaceStorage();
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
    {
      ...run,
      status: "awaiting_human",
      pendingHumanReply: undefined,
      humanQuestionCommentId: undefined,
      humanLatestCommentId: undefined,
      humanCommentResumeAfter: undefined,
    },
    issue,
    { status: cardStatus, question },
  ));
  const questionComment = await tracker.ensureHumanQuestion(issue.number, question);
  if (cardStatus !== "awaiting_human") return;
  const current = state.get(issue.number);
  if (
    !current
    || !acceptsHumanAnswer(current)
    || current.taskView?.question !== question
  ) return;
  await state.set({
    ...withoutTimestamp(current),
    humanQuestionCommentId: questionComment.id,
  });
}

async function reconcileHumanCommentReplies() {
  for (const snapshot of state.all()) {
    if (
      snapshot.pendingHumanReply
      && snapshot.awaitingAction === "resume_child"
      && snapshot.humanQuestionCommentId
    ) {
      await tracker.moveStatus(snapshot.issueNumber, "todo");
      const current = state.get(snapshot.issueNumber);
      if (current?.pendingHumanReply === snapshot.pendingHumanReply) {
        await state.set(clearHumanCommentWindow(current));
      }
      continue;
    }
    if (!acceptsHumanAnswer(snapshot) || !snapshot.humanQuestionCommentId) continue;

    const comments = await tracker.humanReplies(snapshot.issueNumber, snapshot.humanQuestionCommentId);
    const current = state.get(snapshot.issueNumber);
    if (
      !current
      || !acceptsHumanAnswer(current)
      || current.humanQuestionCommentId !== snapshot.humanQuestionCommentId
    ) continue;

    const result = evaluateHumanCommentWindow({
      questionCommentId: current.humanQuestionCommentId,
      latestCommentId: current.humanLatestCommentId,
      resumeAfter: current.humanCommentResumeAfter,
      comments,
      now: Date.now(),
    });
    if (result.kind === "idle") continue;
    if (result.kind === "waiting") {
      if (
        current.humanLatestCommentId === result.latestCommentId
        && current.humanCommentResumeAfter === result.resumeAfter
      ) continue;
      await state.set({
        ...withoutTimestamp(current),
        humanLatestCommentId: result.latestCommentId,
        humanCommentResumeAfter: result.resumeAfter,
      });
      continue;
    }
    await queueHumanReply(current, result.reply);
  }
}

async function queueHumanReply(current: IssueRunState, text: string) {
  if (!acceptsHumanAnswer(current) || !current.awaitingAction) return null;
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
  const queued = state.get(current.issueNumber);
  if (queued?.pendingHumanReply === text) await state.set(clearHumanCommentWindow(queued));
  return { issueNumber: current.issueNumber };
}

function clearHumanCommentWindow(run: IssueRunState): Omit<IssueRunState, "updatedAt"> {
  const {
    humanQuestionCommentId: _questionCommentId,
    humanLatestCommentId: _latestCommentId,
    humanCommentResumeAfter: _resumeAfter,
    ...rest
  } = withoutTimestamp(run);
  return rest;
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
        : run.status === "awaiting_human" || run.status === "failed" ? "failed" : "running";
      const migratedStages = run.status === "finished"
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
    if (run.status === "failed" || run.status === "awaiting_human") {
      const awaitingAction = run.awaitingAction
        ?? (run.lastSessionId && run.workspace && run.baseSha ? "resume_child" : "rerun");
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
        } catch (error) {
          console.error("Persisted session failure recovery failed", error);
        }
      }
      await state.set(reconciled);
      await synchronizePersistedAttention(run.issueNumber, state.get(run.issueNumber)!);
      continue;
    }
    if (run.taskView?.status === "publishing" && run.workspace && run.baseSha) {
      await tracker.moveStatus(run.issueNumber, "running");
      continue;
    }
    if (run.taskView?.status === "queued") {
      await tracker.moveStatus(run.issueNumber, "todo");
      continue;
    }
    const awaitingAction = run.lastSessionId && run.workspace && run.baseSha ? "resume_child" : "rerun";
    await state.set(withTaskView({
      ...withoutTimestamp(run),
      status: "awaiting_human",
      awaitingAction,
    }, {
      number: run.issueNumber,
      title: run.taskView?.title ?? `Issue #${run.issueNumber}`,
      html_url: run.taskView?.issueUrl,
    }, {
      status: "failed",
      question: "Harness был перезапущен во время выполнения. Отправьте /retry, чтобы безопасно продолжить или перезапустить задачу.",
    }));
    await synchronizePersistedAttention(run.issueNumber, state.get(run.issueNumber)!);
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
  const processLock = await acquireProcessLock(config.dataDir);
  await state.load();
  await tracker.assertRepositoryAccess();
  await tracker.ensureLabels();
  await reconcilePersistedStates();
  await cleanupWorkspaceStorage();
  await prepareProjectWorkspace();
  runtime.registerServer(await startHealthServer({
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
    submitHumanAnswer: async ({ text, parentSessionId }) => {
      const current = state.getByParentSession(parentSessionId);
      return current ? await queueHumanReply(current, text) : null;
    },
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
  }));
  runtime.registerServer(await startPublicGateway({
    port: config.publicWebPort,
    upstreamUrl: config.openCodeServerUrl,
    username: config.webUsername,
    password: config.webPassword,
    sessionSecret: config.webSessionSecret,
    internalToken: config.openCodeInternalToken,
    sessionTtlSeconds: config.webSessionTtlSeconds,
  }));
  console.log(`Issue harness started for ${config.owner}/${config.repo}`);

  lastWorkerHeartbeatAt = Date.now();
  const poll = () => {
    runtime.runExclusive(tick).catch((error) => console.error("Harness poll failed", error));
  };
  runtime.registerInterval(poll, config.pollIntervalMs);
  runtime.registerInterval(() => {
    runtime.runExclusive(async () => cleanupWorkspaceStorage({ onlyWhenIdle: true }))
      .catch((error) => console.error("Workspace cleanup failed", error));
  }, 60 * 60 * 1000);
  const shutdown = async (signal: string) => {
    console.log(`Issue harness stopping after ${signal}`);
    const forcedExit = setTimeout(() => {
      console.error("Issue harness shutdown grace period expired; forcing process exit");
      process.exit(process.exitCode ?? 0);
    }, 10_000);
    try {
      const result = await runtime.stop(processLock.release, 10_000);
      if (result === "timed-out") {
        return;
      }
      clearTimeout(forcedExit);
    } catch (error) {
      console.error("Issue harness shutdown failed", error);
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  poll();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
