export const HUMAN_COMMENT_DEBOUNCE_MS = 3 * 60 * 1000;

const MAX_HUMAN_REPLY_LENGTH = 16_000;

export type TrustedHumanComment = {
  id: number;
  author: string;
  body: string;
  createdAt: string;
};

type HumanCommentWindowInput = {
  questionCommentId: number;
  latestCommentId?: number;
  resumeAfter?: string;
  comments: TrustedHumanComment[];
  now: number;
  debounceMs?: number;
};

export type HumanCommentWindowResult =
  | { kind: "idle" }
  | { kind: "waiting"; latestCommentId: number; resumeAfter: string }
  | { kind: "resume"; latestCommentId: number; reply: string };

export function evaluateHumanCommentWindow(
  input: HumanCommentWindowInput,
): HumanCommentWindowResult {
  const comments = [...input.comments]
    .filter((comment) => comment.id > input.questionCommentId)
    .sort((left, right) => left.id - right.id);
  if (!comments.length) return { kind: "idle" };

  const latest = comments.at(-1)!;
  const debounceMs = input.debounceMs ?? HUMAN_COMMENT_DEBOUNCE_MS;
  const observedResumeAfter = new Date(Date.parse(latest.createdAt) + debounceMs).toISOString();
  const resumeAfter = latest.id === input.latestCommentId && input.resumeAfter
    ? input.resumeAfter
    : observedResumeAfter;

  if (input.now < Date.parse(resumeAfter)) {
    return { kind: "waiting", latestCommentId: latest.id, resumeAfter };
  }
  return {
    kind: "resume",
    latestCommentId: latest.id,
    reply: formatHumanReply(comments),
  };
}

function formatHumanReply(comments: TrustedHumanComment[]) {
  const header = "GitHub comments from trusted repository collaborators:";
  const body = comments.map((comment) => `@${comment.author}:\n${comment.body}`).join("\n\n---\n\n");
  const full = `${header}\n\n${body}`;
  if (full.length <= MAX_HUMAN_REPLY_LENGTH) return full;

  const truncation = `${header}\n\n[Earlier comment content was omitted to fit the worker input limit.]\n\n`;
  return `${truncation}${body.slice(-(MAX_HUMAN_REPLY_LENGTH - truncation.length))}`;
}
