import { COMPLETION_MARKER } from "./completion.js";
import { taskStages, type TaskStage } from "./task-view.js";
import type { TaskFileView } from "./task-view.js";

export function stageFromMessageParts(parts: unknown): TaskStage | undefined {
  if (!Array.isArray(parts)) return undefined;
  let observed: TaskStage | undefined;
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const value = part as Record<string, unknown>;
    if (value.type !== "tool") continue;
    const tool = String(value.tool ?? value.name ?? "").toLowerCase();
    const serialized = safeSerialize(value.state ?? value.input ?? value);
    const candidate = toolStage(tool, serialized);
    if (candidate && (!observed || taskStages.indexOf(candidate) > taskStages.indexOf(observed))) {
      observed = candidate;
    }
  }
  return observed;
}

export function appendObservedStage(stages: TaskStage[], stage: TaskStage) {
  if (stages.includes(stage)) return [...stages];
  const currentIndex = stages.reduce((maximum, item) => Math.max(maximum, taskStages.indexOf(item)), -1);
  if (taskStages.indexOf(stage) <= currentIndex) return [...stages];
  return [...stages, stage];
}

export function summarizeWorkerResult(stdout: string) {
  const summary = stdout
    .replaceAll(COMPLETION_MARKER, "")
    .replace(/<human-attention>[\s\S]*?<\/human-attention>/gi, "")
    .trim();
  if (!summary) return undefined;
  return summary.slice(0, 4_000);
}

export function parseChangedFileStats(output: string, trustedPaths: string[]): TaskFileView[] {
  const trusted = new Set(trustedPaths);
  const observed = new Map<string, TaskFileView>();
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const [added, removed, ...pathParts] = line.split("\t");
    const changedPath = pathParts.join("\t");
    if (!trusted.has(changedPath)) continue;
    if (/^\d+$/.test(added) && /^\d+$/.test(removed)) {
      observed.set(changedPath, {
        path: changedPath,
        additions: Number(added),
        deletions: Number(removed),
      });
    } else {
      observed.set(changedPath, { path: changedPath });
    }
  }
  return [...trustedPaths].sort().map((changedPath) => observed.get(changedPath) ?? { path: changedPath });
}

function toolStage(tool: string, serialized: string): TaskStage | undefined {
  if (/\b(test|spec|lint|check|typecheck|build)\b/i.test(serialized)
    && /bash|shell|terminal|command|exec/.test(tool)) return "testing";
  if (/edit|write|patch|apply|replace|create/.test(tool)) return "coding";
  if (/read|grep|search|glob|list|find|view|inspect/.test(tool)) return "studying";
  return undefined;
}

function safeSerialize(value: unknown) {
  try {
    return JSON.stringify(value).slice(0, 16_000);
  } catch {
    return "";
  }
}
