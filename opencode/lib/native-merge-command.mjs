const SESSION_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]{8,128}$/;

export function nativeMergePlan({ method, pathname, search = "", body }) {
  if (method !== "POST" || !body || typeof body !== "object" || body.command !== "merge") {
    return undefined;
  }
  const match = /^\/session\/(ses_[A-Za-z0-9_-]{8,128})\/command$/.exec(pathname);
  if (!match || !SESSION_ID.test(match[1])) return undefined;
  const argumentsText = typeof body.arguments === "string" ? body.arguments.trim() : "";
  if (!argumentsText) return undefined;
  const commandText = `/merge ${argumentsText}`;
  return {
    command: "merge",
    argumentsText,
    commandText,
    sessionID: match[1],
    upstreamPath: `/session/${match[1]}/message${search}`,
    promptBody: {
      ...(typeof body.messageID === "string" && MESSAGE_ID.test(body.messageID)
        ? { messageID: body.messageID }
        : {}),
      ...(typeof body.agent === "string" && body.agent ? { agent: body.agent } : {}),
      ...(body.model && typeof body.model === "object" ? { model: body.model } : {}),
      ...(typeof body.variant === "string" && body.variant ? { variant: body.variant } : {}),
      noReply: true,
      parts: [{ type: "text", text: commandText }],
    },
  };
}

export function persistedMessageId(response) {
  if (response.status < 200 || response.status >= 300) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(response.body).toString("utf8"));
    const messageID = payload?.info?.id;
    return MESSAGE_ID.test(String(messageID ?? "")) ? messageID : undefined;
  } catch {
    return undefined;
  }
}

export function isMergeCommandPayload(value) {
  return Boolean(value && typeof value === "object" && value.command === "merge");
}
