const SESSION_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]{8,128}$/;

export function nativeCommandPlan({ method, pathname, search = "", body }) {
  if (method !== "POST" || !body || typeof body !== "object") return undefined;
  const match = /^\/session\/(ses_[A-Za-z0-9_-]{8,128})\/command$/.exec(pathname);
  if (!match || !SESSION_ID.test(match[1])) return undefined;
  if (body.command !== "issue" && body.command !== "retry") return undefined;
  const argumentsText = typeof body.arguments === "string" ? body.arguments.trim() : "";
  if (body.command === "issue" && !argumentsText) return undefined;
  const needsClarification = body.command === "issue" && issueNeedsClarification(argumentsText);
  const commandText = `/${body.command}${argumentsText ? ` ${argumentsText}` : ""}`;
  const promptBody = {
    ...(typeof body.messageID === "string" && MESSAGE_ID.test(body.messageID) ? { messageID: body.messageID } : {}),
    ...(typeof body.agent === "string" && body.agent ? { agent: body.agent } : {}),
    ...(body.model && typeof body.model === "object" ? { model: body.model } : {}),
    ...(typeof body.variant === "string" && body.variant ? { variant: body.variant } : {}),
    noReply: !needsClarification,
    ...(needsClarification ? {
      system: "Пользователь хотел создать GitHub Issue, но формулировка слишком короткая или неясная. Не создавай Issue и не утверждай, что он создан. Кратко попроси описать цель, ожидаемый результат и затронутую часть проекта. После уточнения напомни, что для создания пользователь должен сам отправить новую команду /issue с окончательной формулировкой.",
    } : {}),
    parts: [{ type: "text", text: commandText }],
  };
  return {
    command: body.command,
    argumentsText,
    commandText,
    sessionID: match[1],
    upstreamPath: `/session/${match[1]}/message${search}`,
    promptBody,
    dispatchToHarness: !needsClarification,
  };
}

export async function persistThenDispatch({ plan, persist, dispatch, onOutcome, onError = console.error }) {
  const persisted = await persist(plan);
  if (persisted.status < 200 || persisted.status >= 300) return persisted;
  if (!plan.dispatchToHarness) return persisted;
  let messageID;
  try {
    const payload = JSON.parse(Buffer.from(persisted.body).toString("utf8"));
    messageID = payload?.info?.id;
  } catch {}
  if (!MESSAGE_ID.test(String(messageID ?? ""))) return persisted;

  void Promise.resolve().then(() => dispatch({ ...plan, messageID })).then((outcome) => {
    return onOutcome({ ...outcome, command: plan.command, commandText: plan.commandText, sessionID: plan.sessionID, messageID });
  }).catch(onError);
  return persisted;
}

export function harnessCommandOutcome(command, response) {
  let payload;
  try { payload = JSON.parse(Buffer.from(response.body).toString("utf8")); } catch {}
  if (command === "issue" && response.status === 409) {
    return {
      status: "busy",
      ...(Number.isSafeInteger(payload?.issueNumber) ? { issueNumber: payload.issueNumber } : {}),
    };
  }
  if (command === "retry" && response.status === 204) return { status: "nothing-to-retry" };
  const issueNumber = command === "issue" ? payload?.number : payload?.issueNumber;
  if (response.status >= 200 && response.status < 300 && Number.isSafeInteger(issueNumber)) {
    return { status: "accepted", issueNumber };
  }
  return { status: "failed", failure: safeFailure(payload?.error, response.status) };
}

function issueNeedsClarification(text) {
  const words = String(text).match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  return words.length < 2 || /(.)\1{4,}/u.test(text);
}

function safeFailure(value, status) {
  const known = new Set([
    "invalid-request",
    "issue-queue-check-failed",
    "github-issue-creation-failed",
    "request-too-large",
  ]);
  return typeof value === "string" && known.has(value) ? value : `harness-http-${status}`;
}
