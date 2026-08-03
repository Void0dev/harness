const SESSION_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]{8,128}$/;
const MERGE_COMMAND = /^\/merge (?:stage(?: #\d+)?|prod)$/;
const MERGE_STATUSES = new Set([
  "merged",
  "already-merged",
  "ambiguous",
  "no-candidate",
  "blocked",
  "failed",
]);

export function parseMergeOutcomeRequest(value) {
  if (!value || typeof value !== "object") throw new Error("invalid merge outcome request");
  const { parentSessionId, messageID, commandText, outcome } = value;
  if (!SESSION_ID.test(String(parentSessionId ?? ""))) throw new Error("invalid parent session");
  if (!MESSAGE_ID.test(String(messageID ?? ""))) throw new Error("invalid message id");
  if (typeof commandText !== "string" || !MERGE_COMMAND.test(commandText)) {
    throw new Error("invalid merge command text");
  }
  if (!outcome || typeof outcome !== "object" || outcome.command !== "merge") {
    throw new Error("invalid merge outcome");
  }
  if (!MERGE_STATUSES.has(outcome.status) || !new Set(["stage", "prod"]).has(outcome.target)) {
    throw new Error("invalid merge outcome status");
  }
  if (outcome.reason !== undefined && (typeof outcome.reason !== "string" || outcome.reason.length > 2_000)) {
    throw new Error("invalid merge outcome reason");
  }
  if (outcome.mergeSha !== undefined && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(outcome.mergeSha)) {
    throw new Error("invalid merge sha");
  }
  if (outcome.pullRequestNumber !== undefined && (
    !Number.isSafeInteger(outcome.pullRequestNumber) || outcome.pullRequestNumber <= 0
  )) throw new Error("invalid pull request number");
  if (outcome.candidates !== undefined && (
    !Array.isArray(outcome.candidates) || outcome.candidates.length > 10
  )) throw new Error("invalid merge candidates");
  return { parentSessionId, messageID, commandText, outcome };
}
