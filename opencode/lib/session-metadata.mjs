const MESSAGE_ID = /^msg_[A-Za-z0-9_-]{8,128}$/;

export function projectSessionMetadata(value) {
  if (!Array.isArray(value)) throw new Error("Invalid OpenCode message list");
  const users = [];
  const anchors = new Map();
  const assistantByParent = new Map();

  for (const [index, message] of value.entries()) {
    const info = message?.info;
    if (!info || typeof info !== "object") continue;
    if (info.role === "user" && validMessageId(info.id) && validTime(info.time?.created)) {
      users.push({ messageId: info.id, createdAt: iso(info.time.created) });
      const candidate = issueAnchor(message?.parts);
      if (candidate) {
        const current = anchors.get(candidate.issueNumber);
        if (!current
          || candidate.priority > current.priority
          || (candidate.priority === current.priority && index > current.index)) {
          anchors.set(candidate.issueNumber, { ...candidate, messageId: info.id, index });
        }
      }
      continue;
    }
    if (info.role !== "assistant" || !validMessageId(info.parentID)) continue;
    if (typeof info.modelID !== "string" || !info.modelID.trim() || info.modelID.length > 128) continue;
    if (!validTime(info.time?.created) || !validTime(info.time?.completed)) continue;
    const current = assistantByParent.get(info.parentID);
    assistantByParent.set(info.parentID, {
      parentMessageId: info.parentID,
      modelId: info.modelID.trim(),
      generationStartedAt: iso(Math.min(info.time.created, current?.started ?? info.time.created)),
      generationCompletedAt: iso(Math.max(info.time.completed, current?.completed ?? info.time.completed)),
      started: Math.min(info.time.created, current?.started ?? info.time.created),
      completed: Math.max(info.time.completed, current?.completed ?? info.time.completed),
    });
  }

  const issueByMessage = new Map([...anchors.values()].map((anchor) => [anchor.messageId, anchor.issueNumber]));
  return {
    users: users.map((user) => ({
      ...user,
      ...(issueByMessage.has(user.messageId) ? { issueNumber: issueByMessage.get(user.messageId) } : {}),
    })),
    assistants: [...assistantByParent.values()].map(({ started: _started, completed: _completed, ...item }) => item),
  };
}

function issueAnchor(parts) {
  if (!Array.isArray(parts)) return undefined;
  const text = parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
  const explicit = [
    /\/issue(?:\s+[\s\S]+)?\s*<!--\s*opencode-harness-issue:\s*(\d+)\s*-->$/i,
    /\/retry(?:\s+[\s\S]+)?\s*<!--\s*opencode-harness-issue:\s*(\d+)\s*-->$/i,
    /^Issue #(\d+):\s*\/issue(?:\s+[\s\S]+)?$/i,
    /^Повторный запуск Issue #(\d+)[\s\S]*\n\n\/retry(?:\s+[\s\S]+)?$/i,
    /^Повторный запуск Issue #(\d+) поставлен в очередь\.?$/i,
  ].map((pattern) => pattern.exec(text)).find(Boolean);
  const explicitIssue = Number(explicit?.[1]);
  if (Number.isSafeInteger(explicitIssue) && explicitIssue > 0) {
    return { issueNumber: explicitIssue, priority: 2 };
  }
  const accepted = /^Issue #(\d+) принят\.\s*Изучаю код и готовлю изменения[….]*$/i.exec(text);
  const acceptedIssue = Number(accepted?.[1]);
  return Number.isSafeInteger(acceptedIssue) && acceptedIssue > 0
    ? { issueNumber: acceptedIssue, priority: 1 }
    : undefined;
}

function validMessageId(value) {
  return typeof value === "string" && MESSAGE_ID.test(value);
}

function validTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function iso(value) {
  return new Date(value).toISOString();
}
