import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const SESSION_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;

export function materializeTaskMessages({ dbPath, parentSessionId, tasks, projectDirectory }) {
  if (!SESSION_ID.test(parentSessionId) || !Array.isArray(tasks)) throw new Error("Invalid task materialization request");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    let changed = cleanupSyntheticCommandUsers(db, parentSessionId);
    changed = normalizeStandaloneRetryMessages(db, parentSessionId, projectDirectory) || changed;
    changed = normalizeAllCommandEnvelopes(db, parentSessionId, projectDirectory) || changed;
    changed = normalizeStandaloneSystemMessages(db, parentSessionId, projectDirectory) || changed;
    changed = cleanupRepliesToSystemAssistants(db, parentSessionId) || changed;
    changed = cleanupDuplicateCommandReplies(db, parentSessionId) || changed;
    for (const task of tasks) changed = materializeOne(db, parentSessionId, task, projectDirectory) || changed;
    db.exec("COMMIT");
    return { changed };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

function cleanupDuplicateCommandReplies(db, sessionID) {
  const rows = db.prepare(`
    SELECT m.id, json_extract(m.data, '$.parentID') AS parent_id,
      COALESCE(GROUP_CONCAT(json_extract(p.data, '$.text'), ''), '') AS text
    FROM message m LEFT JOIN part p ON p.message_id = m.id
      AND json_extract(p.data, '$.type') = 'text'
    WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'assistant'
      AND json_extract(m.data, '$.parentID') IS NOT NULL
    GROUP BY m.id ORDER BY m.time_created, m.id
  `).all(sessionID);
  const groups = new Map();
  for (const row of rows) {
    const text = String(row.text ?? "").trim();
    if (!text) continue;
    const key = `${row.parent_id}\u0000${text}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  let changed = false;
  for (const group of groups.values()) {
    const keep = group.find((row) => row.id.includes("_harness_command_"));
    if (!keep) continue;
    for (const row of group) {
      if (row.id === keep.id) continue;
      deleteMessageTree(db, sessionID, row.id);
      changed = true;
    }
  }
  return changed;
}

export function materializeCommandOutcome({
  dbPath,
  parentSessionId,
  messageID,
  commandText,
  outcome,
  projectDirectory,
  updatedAt = Date.now(),
}) {
  if (!SESSION_ID.test(parentSessionId) || !/^msg_[A-Za-z0-9_-]{8,128}$/.test(messageID)) {
    throw new Error("Invalid command materialization request");
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare(`
      SELECT m.id AS message_id, m.data AS message_data, m.time_created,
        p.id AS part_id, p.data AS part_data
      FROM message m JOIN part p ON p.message_id = m.id
      WHERE m.id = ? AND m.session_id = ? AND json_extract(m.data, '$.role') = 'user'
        AND json_extract(p.data, '$.type') = 'text'
      ORDER BY p.time_created LIMIT 1
    `).get(messageID, parentSessionId);
    if (!row) {
      db.exec("COMMIT");
      return { changed: false };
    }
    const part = parseJson(row.part_data) ?? { type: "text" };
    const issueNumber = Number(outcome?.issueNumber);
    const accepted = outcome?.status === "accepted"
      && Number.isSafeInteger(issueNumber)
      && issueNumber > 0;
    const exactText = accepted
      ? `${commandText}\n\n<!-- opencode-harness-issue: ${issueNumber} -->`
      : commandText;
    let changed = false;
    if (part.text !== exactText) {
      db.prepare("UPDATE part SET data = ?, time_updated = ? WHERE id = ?")
        .run(JSON.stringify({ ...part, text: exactText }), updatedAt, row.part_id);
      changed = true;
    }
    let reply;
    if (outcome?.status === "busy") {
      reply = Number.isSafeInteger(issueNumber) && issueNumber > 0
        ? `Нельзя создать новый Issue: Issue #${issueNumber} уже выполняется или ожидает выполнения. Дождитесь его завершения.`
        : "Нельзя создать новый Issue: в этом чате уже выполняется или ожидает выполнения другая задача.";
    } else if (outcome?.status === "failed") {
      reply = failureText(outcome.failure);
    } else if (outcome?.status === "nothing-to-retry") {
      reply = "В этом чате сейчас нечего повторять: нет технической ошибки с доступным восстановлением.";
    }
    if (reply) changed = upsertCommandReply(db, row, reply, {}, projectDirectory, updatedAt) || changed;
    if (changed) db.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(updatedAt, parentSessionId);
    db.exec("COMMIT");
    return { changed };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

function failureText(failure) {
  const messages = {
    "invalid-request": "Harness отклонил запрос: команда `/issue` имеет неверный формат.",
    "request-too-large": "Harness отклонил запрос: текст для Issue слишком большой.",
    "issue-queue-check-failed": "Не удалось проверить очередь задач: Harness временно недоступен.",
    "github-issue-creation-failed": "GitHub не создал Issue: API вернул ошибку. Проверьте логи контейнера `issue-harness`.",
    "harness-unreachable": "Не удалось связаться с Harness: сервис недоступен или не ответил вовремя.",
    "opencode-persist-response-invalid": "OpenCode сохранил команду, но вернул некорректный ответ. Повторите команду.",
  };
  if (typeof failure === "string" && /^harness-http-\d{3}$/.test(failure)) {
    return `Harness вернул HTTP ${failure.slice("harness-http-".length)} при создании Issue. Проверьте логи контейнера \`issue-harness\`.`;
  }
  return messages[failure] ?? "Harness отклонил создание Issue. Проверьте логи контейнера `issue-harness`.";
}

function cleanupSyntheticCommandUsers(db, sessionID) {
  const syntheticRows = db.prepare(`
    SELECT m.id, m.data, m.time_created, p.data AS part_data
    FROM message m JOIN part p ON p.message_id = m.id
    WHERE m.session_id = ? AND m.id LIKE 'msg_harness_command_user_%'
      AND json_extract(p.data, '$.type') = 'text'
  `).all(sessionID);
  let changed = false;
  for (const synthetic of syntheticRows) {
    const commandPart = parseJson(synthetic.part_data);
    const issueNumber = Number(/opencode-harness-issue:\s*(\d+)/i.exec(String(commandPart?.text ?? ""))?.[1]);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) continue;
    const candidates = db.prepare(`
      SELECT m.id, m.data, m.time_created, p.id AS part_id, p.data AS part_data
      FROM message m JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ? AND m.id <> ? AND json_extract(p.data, '$.type') = 'text'
    `).all(sessionID, synthetic.id).filter((row) => legacySystemText(String(parseJson(row.part_data)?.text ?? ""), issueNumber));
    const replacement = candidates.sort((left, right) =>
      Math.abs(Number(left.time_created) - Number(synthetic.time_created))
      - Math.abs(Number(right.time_created) - Number(synthetic.time_created)))[0];
    if (!replacement) continue;

    const syntheticData = parseJson(synthetic.data) ?? {};
    const replacementData = parseJson(replacement.data) ?? {};
    const userData = {
      role: "user",
      time: { created: Number(replacement.time_created) },
      agent: "build",
      model: replacementData.model ?? syntheticData.model ?? { providerID: "void", modelID: "unknown" },
      summary: syntheticData.summary ?? replacementData.summary ?? { diffs: [] },
    };
    db.prepare("UPDATE message SET data = ? WHERE id = ?").run(JSON.stringify(userData), replacement.id);
    const replacementPart = parseJson(replacement.part_data) ?? { type: "text" };
    db.prepare("UPDATE part SET data = ? WHERE id = ?")
      .run(JSON.stringify({ ...replacementPart, text: commandPart.text }), replacement.part_id);

    repairSyntheticChildren(db, sessionID, synthetic.id, replacement.id);
    db.prepare("DELETE FROM part WHERE message_id = ?").run(synthetic.id);
    db.prepare("DELETE FROM message WHERE id = ?").run(synthetic.id);
    changed = true;
  }
  return changed;
}

function repairSyntheticChildren(db, sessionID, syntheticID, replacementID) {
  const children = db.prepare("SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created")
    .all(sessionID)
    .filter((row) => parseJson(row.data)?.parentID === syntheticID);
  const ordinaryUsers = db.prepare("SELECT m.id, m.data AS message_data, m.time_created, p.data AS part_data FROM message m JOIN part p ON p.message_id=m.id WHERE m.session_id=?")
    .all(sessionID)
    .filter((row) => {
      const text = String(parseJson(row.part_data)?.text ?? "").trim();
      return parseJson(row.message_data)?.role === "user"
        && !row.id.startsWith("msg_harness_command_user_")
        && text && !text.startsWith("/") && !standaloneSystemText(text);
    });
  const ordinaryGroups = new Map();
  for (const child of children) {
    const data = parseJson(child.data);
    if (child.id.startsWith("msg_harness_")) {
      db.prepare("UPDATE message SET data = ? WHERE id = ?")
        .run(JSON.stringify({ ...data, parentID: replacementID }), child.id);
      continue;
    }
    const parent = ordinaryUsers
      .filter((user) => Number(user.time_created) <= Number(child.time_created))
      .sort((left, right) => Number(right.time_created) - Number(left.time_created))[0];
    if (!parent || !Number.isSafeInteger(data?.time?.completed)) {
      deleteMessage(db, child.id);
      continue;
    }
    const previous = ordinaryGroups.get(parent.id);
    if (!previous || Number(child.time_created) > Number(previous.time_created)) {
      if (previous) deleteMessage(db, previous.id);
      ordinaryGroups.set(parent.id, child);
      db.prepare("UPDATE message SET data = ? WHERE id = ?")
        .run(JSON.stringify({ ...data, parentID: parent.id }), child.id);
    } else {
      deleteMessage(db, child.id);
    }
  }
}

function deleteMessage(db, messageID) {
  db.prepare("DELETE FROM part WHERE message_id = ?").run(messageID);
  db.prepare("DELETE FROM message WHERE id = ?").run(messageID);
}

function cleanupRepliesToSystemAssistants(db, sessionID) {
  const rows = db.prepare(`
    SELECT child.id AS child_id,
      COALESCE(GROUP_CONCAT(json_extract(parent_part.data, '$.text'), ''), '') AS parent_text
    FROM message child
    JOIN message parent ON parent.id = json_extract(child.data, '$.parentID')
    LEFT JOIN part parent_part ON parent_part.message_id = parent.id
      AND json_extract(parent_part.data, '$.type') = 'text'
    WHERE child.session_id = ?
      AND json_extract(child.data, '$.role') = 'assistant'
      AND json_extract(parent.data, '$.role') = 'assistant'
    GROUP BY child.id
  `).all(sessionID);
  let changed = false;
  for (const row of rows) {
    if (!standaloneSystemText(String(row.parent_text ?? "").trim())) continue;
    deleteMessageTree(db, sessionID, row.child_id);
    changed = true;
  }
  return changed;
}

function deleteMessageTree(db, sessionID, messageID) {
  const children = db.prepare(`
    SELECT id FROM message
    WHERE session_id = ? AND json_extract(data, '$.parentID') = ?
  `).all(sessionID, messageID);
  for (const child of children) deleteMessageTree(db, sessionID, child.id);
  deleteMessage(db, messageID);
}

function normalizeStandaloneRetryMessages(db, sessionID, projectDirectory) {
  const rows = db.prepare(`
    SELECT m.id AS message_id, m.data AS message_data, m.time_created,
      p.id AS part_id, p.data AS part_data, p.time_updated
    FROM message m JOIN part p ON p.message_id = m.id
    WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user'
      AND json_extract(p.data, '$.type') = 'text'
  `).all(sessionID);
  let changed = false;
  for (const row of rows) {
    const part = parseJson(row.part_data);
    const match = /^Повторный запуск Issue #(\d+) поставлен в очередь\.?$/i.exec(String(part?.text ?? "").trim());
    const issueNumber = Number(match?.[1]);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) continue;
    const children = db.prepare(`
      SELECT id FROM message WHERE session_id = ?
        AND json_extract(data, '$.role') = 'assistant'
        AND json_extract(data, '$.parentID') = ?
    `).all(sessionID, row.message_id);
    for (const child of children) deleteMessageTree(db, sessionID, child.id);
    const text = `/retry\n\n<!-- opencode-harness-issue: ${issueNumber} -->`;
    db.prepare("UPDATE part SET data = ? WHERE id = ?").run(JSON.stringify({ ...part, text }), row.part_id);
    changed = true;
    changed = upsertCommandReply(db, row, `Повторный запуск Issue #${issueNumber} поставлен в очередь.`, {}, projectDirectory, Number(row.time_updated) || Number(row.time_created)) || changed;
  }
  return changed;
}

function normalizeStandaloneSystemMessages(db, sessionID, projectDirectory) {
  const rows = db.prepare(`
    SELECT m.id, m.data, m.time_created, p.data AS part_data
    FROM message m JOIN part p ON p.message_id=m.id
    WHERE m.session_id=? AND json_extract(m.data, '$.role')='user'
      AND json_extract(p.data, '$.type')='text'
    ORDER BY m.time_created
  `).all(sessionID);
  let changed = false;
  for (const row of rows) {
    const text = String(parseJson(row.part_data)?.text ?? "").trim();
    if (!standaloneSystemText(text)) continue;
    const parent = [...rows].reverse().find((candidate) =>
      Number(candidate.time_created) < Number(row.time_created)
      && candidate.id !== row.id
      && !standaloneSystemText(String(parseJson(candidate.part_data)?.text ?? "").trim()));
    if (!parent) continue;
    const current = parseJson(row.data) ?? {};
    const created = Number(row.time_created);
    const data = {
      parentID: parent.id,
      role: "assistant",
      mode: "chat",
      agent: "build",
      path: { cwd: projectDirectory, root: projectDirectory },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
      modelID: current.model?.modelID ?? "unknown",
      providerID: current.model?.providerID ?? "void",
      time: { created, completed: created },
      finish: "stop",
    };
    db.prepare("UPDATE message SET data = ? WHERE id = ?").run(JSON.stringify(data), row.id);
    changed = true;
  }
  return changed;
}

function standaloneSystemText(text) {
  return /^(?:Нельзя создать новый Issue|Не удалось создать Issue|В этом чате сейчас нечего повторять|Не удалось повторить задачу)/i.test(text);
}

function normalizeAllCommandEnvelopes(db, sessionID, projectDirectory) {
  const rows = db.prepare(`
    SELECT p.id, p.data, p.time_updated, m.id AS message_id, m.data AS message_data, m.time_created
    FROM part p JOIN message m ON m.id = p.message_id
    WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user'
      AND json_extract(p.data, '$.type') = 'text'
  `).all(sessionID);
  let changed = false;
  for (const row of rows) {
    const part = parseJson(row.data);
    const text = String(part?.text ?? "").trim();
    if (!text || /<!--\s*opencode-harness-issue:/i.test(text)) continue;
    const success = /^Issue #(\d+):\s*(\/issue(?:\s+[\s\S]+)?)$/i.exec(text);
    let command;
    let issueNumber;
    let systemText;
    if (success) {
      issueNumber = Number(success[1]);
      command = success[2].trim();
    } else {
      const envelope = /^([\s\S]+?)\n\n(\/(?:issue|retry)(?:\s+[\s\S]*)?)$/i.exec(text);
      if (!envelope) continue;
      systemText = envelope[1].trim();
      command = envelope[2].trim();
      const observed = Number(/Issue #(\d+)/i.exec(systemText)?.[1]);
      if (/^\/retry(?:\s|$)/i.test(command) && Number.isSafeInteger(observed) && observed > 0) issueNumber = observed;
    }
    const normalized = issueNumber
      ? `${command}\n\n<!-- opencode-harness-issue: ${issueNumber} -->`
      : command;
    const stableUpdatedAt = Number(row.time_updated) || Number(row.time_created);
    db.prepare("UPDATE part SET data = ?, time_updated = ? WHERE id = ?")
      .run(JSON.stringify({ ...part, text: normalized }), stableUpdatedAt, row.id);
    changed = true;
    if (systemText) {
      const current = parseJson(row.message_data) ?? {};
      changed = upsertCommandReply(db, row, systemText, {
        modelId: current.model?.modelID,
      }, projectDirectory, stableUpdatedAt) || changed;
    }
  }
  return changed;
}

function materializeOne(db, parentSessionId, task, projectDirectory) {
  if (!task || !Number.isSafeInteger(task.issueNumber) || task.issueNumber <= 0) return false;
  const now = validTime(task.updatedAt) ?? Date.now();
  let changed = normalizeIssueCommands(db, parentSessionId, task, projectDirectory, now);
  const child = task.status === "finished"
    ? childResult(db, task.workerSessionPath, parentSessionId, task.issueNumber)
    : undefined;
  let anchor = selectAnchor(db, parentSessionId, task.issueNumber);
  if (anchor && anchor.rank < 30 && !directIssueSession(db, parentSessionId, task.issueNumber)) {
    const recovered = recoverLegacyCommandAnchor(db, parentSessionId, task, child, anchor);
    changed = recovered.changed || changed;
    anchor = recovered.anchor;
  }
  anchor ??= createDirectIssueAnchor(db, parentSessionId, task);
  if (!anchor) return false;
  changed = normalizeLegacySystemMessages(db, parentSessionId, task, anchor, projectDirectory, now) || changed;

  if (task.status === "finished" && !child) return false;
  const started = validTime(task.generationStartedAt) ?? anchor.createdAt;
  const completed = task.status === "running" || task.status === "queued" || task.status === "publishing"
    ? undefined
    : validTime(task.generationCompletedAt) ?? now;
  const modelID = safeText(task.modelId, 128) ?? child?.message.modelID ?? "unknown";
  const providerID = child?.message.providerID ?? "void";
  const text = resultText(task, child);
  if (!text) return false;

  if (child?.diffs) changed = updateAnchorDiffs(db, anchor.id, child.diffs, now) || changed;

  const suffix = crypto.createHash("sha256").update(`${parentSessionId}:${task.issueNumber}`).digest("hex").slice(0, 24);
  const messageID = orderedHarnessMessageID(anchor.id, "task", suffix);
  const partID = `prt_${messageID.slice(4)}`;
  changed = cleanupObsoleteTaskMessages(db, parentSessionId, task.issueNumber, messageID) || changed;
  const deterministicLegacyID = `msg_harness_${suffix}`;
  if (db.prepare("SELECT 1 FROM message WHERE id = ?").get(deterministicLegacyID)) {
    deleteMessageTree(db, parentSessionId, deterministicLegacyID);
  }
  const legacy = db.prepare(`
    SELECT id FROM message
    WHERE session_id = ? AND json_extract(data, '$.parentID') = ?
      AND id LIKE 'msg_harness_%' AND id NOT LIKE 'msg_harness_command_%'
  `).all(parentSessionId, anchor.id);
  for (const row of legacy) deleteMessageTree(db, parentSessionId, row.id);
  const message = {
    parentID: anchor.id,
    role: "assistant",
    mode: "chat",
    agent: "build",
    path: { cwd: projectDirectory, root: projectDirectory },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
    modelID,
    providerID,
    time: { created: started, ...(completed === undefined ? {} : { completed }) },
    ...(completed === undefined ? {} : { finish: "stop" }),
  };
  const part = {
    type: "text",
    text,
    time: { start: started, ...(completed === undefined ? {} : { end: completed }) },
  };
  changed = upsertJson(db, "message", messageID, {
    sessionID: parentSessionId, messageID: undefined, createdAt: started, updatedAt: now, data: message,
  }) || changed;
  changed = upsertJson(db, "part", partID, {
    sessionID: parentSessionId, messageID, createdAt: started, updatedAt: now, data: part,
  }) || changed;
  if (changed) db.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(now, parentSessionId);
  return changed;
}

function cleanupObsoleteTaskMessages(db, sessionID, issueNumber, currentMessageID) {
  const rows = db.prepare(`
    SELECT m.id, m.data,
      COALESCE(GROUP_CONCAT(json_extract(p.data, '$.text'), ''), '') AS text
    FROM message m LEFT JOIN part p ON p.message_id = m.id
    WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'assistant'
    GROUP BY m.id
  `).all(sessionID);
  const anchors = new Set(db.prepare(`
    SELECT m.id,
      COALESCE(GROUP_CONCAT(json_extract(p.data, '$.text'), ''), '') AS text
    FROM message m LEFT JOIN part p ON p.message_id = m.id
    WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user'
    GROUP BY m.id
  `).all(sessionID).filter((row) => anchorRank(String(row.text ?? ""), issueNumber) > 0).map((row) => row.id));
  let changed = false;
  for (const row of rows) {
    if (row.id === currentMessageID) continue;
    const message = parseJson(row.data);
    if (!anchors.has(message?.parentID)) continue;
    const text = String(row.text ?? "").trim();
    const obsoleteHarnessTask = row.id.includes("_harness_task_");
    const generatedProgress = /^(?:Задача принята\.|Изучаю код…|Пишу код…|Запускаю проверки…|Публикую изменения…|Выполняю задачу…)$/i.test(text);
    if (!obsoleteHarnessTask && !generatedProgress) continue;
    deleteMessageTree(db, sessionID, row.id);
    changed = true;
  }
  return changed;
}

function selectAnchor(db, sessionID, issueNumber) {
  const rows = db.prepare(`
    SELECT m.id, m.time_created, m.data,
      COALESCE(GROUP_CONCAT(json_extract(p.data, '$.text'), ''), '') AS text
    FROM message m LEFT JOIN part p ON p.message_id = m.id
    WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user'
    GROUP BY m.id ORDER BY m.time_created
  `).all(sessionID);
  let selected;
  for (const row of rows) {
    const rank = anchorRank(String(row.text ?? ""), issueNumber);
    if (!rank) continue;
    if (!selected || rank > selected.rank || (rank === selected.rank && row.time_created > selected.createdAt)) {
      selected = { id: row.id, createdAt: Number(row.time_created), rank };
    }
  }
  return selected;
}

function anchorRank(text, issueNumber) {
  const escaped = String(issueNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`Issue #${escaped}[^\\n]*[\\s\\S]*\\/retry(?:\\s|$)`, "i").test(text)) return 40;
  if (new RegExp(`<!--\\s*opencode-harness-issue:\\s*${escaped}\\s*-->`, "i").test(text)
    && /\/retry(?:\s|$)/i.test(text)) return 40;
  if (new RegExp(`<!--\\s*opencode-harness-issue:\\s*${escaped}\\s*-->`, "i").test(text)
    && /\/issue(?:\s|$)/i.test(text)) return 30;
  if (new RegExp(`^Issue #${escaped}:\\s*\\/issue(?:\\s|$)`, "i").test(text.trim())) return 30;
  if (new RegExp(`Повторный запуск Issue #${escaped} поставлен в очередь`, "i").test(text)) return 20;
  if (new RegExp(`^Issue #${escaped} принят`, "i").test(text.trim())) return 10;
  return 0;
}

function normalizeIssueCommands(db, sessionID, task, projectDirectory, updatedAt) {
  const rows = db.prepare(`
    SELECT p.id, p.data, m.id AS message_id, m.data AS message_data, m.time_created FROM part p
    JOIN message m ON m.id = p.message_id
    WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user'
      AND json_extract(p.data, '$.type') = 'text'
  `).all(sessionID);
  let changed = false;
  for (const row of rows) {
    const part = parseJson(row.data);
    const exact = exactCommand(part?.text, task.issueNumber);
    if (!exact) continue;
    const text = exact.anchor
      ? `${exact.command}\n\n<!-- opencode-harness-issue: ${task.issueNumber} -->`
      : exact.command;
    if (part.text !== text) {
      db.prepare("UPDATE part SET data = ?, time_updated = ? WHERE id = ?")
        .run(JSON.stringify({ ...part, text }), updatedAt, row.id);
      changed = true;
    }
    if (exact.systemText) {
      changed = upsertCommandReply(db, row, exact.systemText, task, projectDirectory, updatedAt) || changed;
    }
  }
  return changed;
}

function exactCommand(value, issueNumber) {
  const text = String(value ?? "").trim();
  const escaped = String(issueNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const oldIssue = new RegExp(`^Issue #${escaped}:\\s*(\\/issue(?:\\s+[\\s\\S]+)?)$`, "i").exec(text)?.[1];
  if (oldIssue) return { command: oldIssue.trim(), anchor: true };
  const envelope = new RegExp(`^([\\s\\S]*Issue #${escaped}[\\s\\S]*?)\\n\\n(\\/(?:issue|retry)(?:\\s+[\\s\\S]*)?)$`, "i").exec(text);
  if (!envelope) return undefined;
  const command = envelope[2].trim();
  return {
    command,
    anchor: /^\/retry(?:\s|$)/i.test(command),
    systemText: envelope[1].trim(),
  };
}

function upsertCommandReply(db, row, text, task, projectDirectory, updatedAt) {
  const current = parseJson(row.message_data) ?? {};
  const createdAt = Number(row.time_created);
  const suffix = crypto.createHash("sha256").update(`${row.message_id}:command-reply`).digest("hex").slice(0, 24);
  const messageID = orderedHarnessMessageID(row.message_id, "command", suffix);
  const partID = `prt_${messageID.slice(4)}`;
  const legacyMessageID = `msg_harness_command_${suffix}`;
  if (legacyMessageID !== messageID && db.prepare("SELECT 1 FROM message WHERE id = ?").get(legacyMessageID)) {
    deleteMessageTree(db, rowSessionID(db, row.message_id), legacyMessageID);
  }
  const message = {
    parentID: row.message_id,
    role: "assistant",
    mode: "chat",
    agent: "build",
    path: { cwd: projectDirectory, root: projectDirectory },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
    modelID: safeText(task.modelId, 128) ?? current.model?.modelID ?? "unknown",
    providerID: current.model?.providerID ?? "void",
    time: { created: createdAt, completed: createdAt },
    finish: "stop",
  };
  const messageChanged = upsertJson(db, "message", messageID, {
    sessionID: rowSessionID(db, row.message_id), createdAt, updatedAt, data: message,
  });
  const partChanged = upsertJson(db, "part", partID, {
    sessionID: rowSessionID(db, row.message_id), messageID, createdAt, updatedAt,
    data: { type: "text", text, time: { start: createdAt, end: createdAt } },
  });
  return messageChanged || partChanged;
}

function rowSessionID(db, messageID) {
  return db.prepare("SELECT session_id FROM message WHERE id = ?").get(messageID).session_id;
}

function normalizeLegacySystemMessages(db, sessionID, task, anchor, projectDirectory, updatedAt) {
  const rows = db.prepare(`
    SELECT m.id, m.data, m.time_created,
      COALESCE(GROUP_CONCAT(json_extract(p.data, '$.text'), ''), '') AS text
    FROM message m LEFT JOIN part p ON p.message_id = m.id
    WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user'
    GROUP BY m.id
  `).all(sessionID);
  let changed = false;
  for (const row of rows) {
    if (row.id === anchor.id || !legacySystemText(String(row.text ?? ""), task.issueNumber)) continue;
    const current = parseJson(row.data);
    if (!current) continue;
    const created = Number(row.time_created);
    const data = {
      parentID: anchor.id,
      role: "assistant",
      mode: "chat",
      agent: "build",
      path: { cwd: projectDirectory, root: projectDirectory },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
      modelID: safeText(task.modelId, 128) ?? current.model?.modelID ?? "unknown",
      providerID: current.model?.providerID ?? "void",
      time: { created, completed: created },
      finish: "stop",
    };
    db.prepare("UPDATE message SET data = ?, time_updated = ? WHERE id = ?")
      .run(JSON.stringify(data), updatedAt, row.id);
    changed = true;
  }
  return changed;
}

function legacySystemText(text, issueNumber) {
  const escaped = String(issueNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^Issue #${escaped}(?: принят\\.|: (?:пишу код|код подготовлен|код готов|выполнение остановилось))|^Issue #${escaped} готов\\.`,
    "i",
  ).test(text.trim());
}

function createDirectIssueAnchor(db, sessionID, task) {
  const session = db.prepare("SELECT title, directory FROM session WHERE id = ?").get(sessionID);
  if (!session || !new RegExp(`^GitHub Issue #${task.issueNumber}(?:\\b|:)`, "i").test(session.title)) return undefined;
  const createdAt = validTime(task.updatedAt) ?? Date.now();
  const suffix = crypto.createHash("sha256").update(`${sessionID}:${task.issueNumber}:user`).digest("hex").slice(0, 24);
  const id = `msg_harness_user_${suffix}`;
  const partID = `prt_harness_user_${suffix}`;
  const data = { role: "user", time: { created: createdAt }, agent: "build", model: { providerID: "void", modelID: safeText(task.modelId, 128) ?? "unknown" }, summary: { diffs: [] } };
  const text = { type: "text", text: `GitHub Issue #${task.issueNumber}: ${task.title}` };
  upsertJson(db, "message", id, { sessionID, createdAt, updatedAt: createdAt, data });
  upsertJson(db, "part", partID, { sessionID, messageID: id, createdAt, updatedAt: createdAt, data: text });
  return { id, createdAt, rank: 1 };
}

function directIssueSession(db, sessionID, issueNumber) {
  const session = db.prepare("SELECT title FROM session WHERE id = ?").get(sessionID);
  return Boolean(session && new RegExp(`^GitHub Issue #${issueNumber}(?:\\b|:)`, "i").test(session.title));
}

function recoverLegacyCommandAnchor(db, sessionID, task, child, anchor) {
  const hasRetry = db.prepare(`
    SELECT 1 FROM message m JOIN part p ON p.message_id = m.id
    WHERE m.session_id = ? AND json_extract(p.data, '$.text') LIKE ? LIMIT 1
  `).get(sessionID, `%Повторный запуск Issue #${task.issueNumber}%`);
  const command = hasRetry
    ? "/retry"
    : `/issue ${child?.issueText || task.title}`;
  const row = db.prepare("SELECT id, data, time_updated FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text' ORDER BY time_created LIMIT 1").get(anchor.id);
  if (!row) return { anchor, changed: false };
  const part = parseJson(row.data);
  const text = `${command}\n\n<!-- opencode-harness-issue: ${task.issueNumber} -->`;
  if (part?.text !== text) {
    db.prepare("UPDATE part SET data = ? WHERE id = ?").run(JSON.stringify({ ...part, text }), row.id);
  }
  return {
    anchor: { ...anchor, rank: hasRetry ? 40 : 30 },
    changed: part?.text !== text,
  };
}

function childResult(db, workerSessionPath, parentSessionId, issueNumber) {
  const match = /\/session\/(ses_[A-Za-z0-9_-]{8,128})$/.exec(String(workerSessionPath ?? ""));
  let sessionID = match?.[1];
  let directory;
  if (!sessionID) {
    const session = db.prepare(`
      SELECT id, directory FROM session
      WHERE parent_id = ? AND title LIKE ?
      ORDER BY time_updated DESC LIMIT 1
    `).get(parentSessionId, `%Issue #${issueNumber}%`);
    sessionID = session?.id;
    directory = session?.directory;
  }
  if (!sessionID) return undefined;
  const messages = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created").all(sessionID);
  let final;
  let diffs;
  let issueText;
  for (const row of messages) {
    const data = parseJson(row.data);
    if (data?.role === "user") {
      if (Array.isArray(data.summary?.diffs)) diffs = data.summary.diffs;
      const prompt = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created").all(row.id)
        .map((part) => parseJson(part.data)).find((part) => part?.type === "text")?.text;
      const title = /(?:^|\n)Title:\n([^\n]+)\n\nBody:/i.exec(String(prompt ?? ""))?.[1]?.trim();
      if (title) issueText = title;
    }
    if (data?.role === "assistant" && data.finish === "stop" && Number.isSafeInteger(data.time?.completed)) final = { id: row.id, message: data };
  }
  if (!final) return undefined;
  const parts = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created").all(final.id)
    .map((row) => parseJson(row.data))
    .filter((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim());
  const text = parts.at(-1)?.text?.replace(/\s*<promise>COMPLETE<\/promise>\s*/gi, "").trim();
  if (!text) return undefined;
  return {
    ...final,
    text,
    diffs: Array.isArray(diffs) ? diffs : [],
    issueText,
    sessionPath: workerSessionPath || (directory
      ? `/${Buffer.from(directory, "utf8").toString("base64url")}/session/${sessionID}`
      : undefined),
  };
}

function resultText(task, child) {
  const links = [];
  if (child?.sessionPath || task.workerSessionPath) links.push(`[История изменений](${child?.sessionPath ?? task.workerSessionPath})`);
  if (task.prUrl) links.push(`[Открыть Pull Request](${task.prUrl})`);
  if (task.status === "finished") return [child?.text, links.join(" · ")].filter(Boolean).join("\n\n");
  if (task.status === "awaiting_human") return task.question || "Нужен ответ пользователя, чтобы продолжить работу.";
  if (task.status === "failed") return [task.question || task.summary || "Выполнение остановилось из-за технической ошибки.", "Можно повторить командой `/retry` или `/retry уточнение`."].join("\n\n");
  const labels = { accepted: "Задача принята.", studying: "Изучаю код…", coding: "Пишу код…", testing: "Запускаю проверки…", publishing: "Публикую изменения…" };
  return labels[task.stages?.at(-1)] ?? "Выполняю задачу…";
}

function updateAnchorDiffs(db, id, diffs, updatedAt) {
  const row = db.prepare("SELECT data FROM message WHERE id = ?").get(id);
  const data = parseJson(row?.data);
  if (!data) return false;
  const next = { ...data, summary: { ...(data.summary ?? {}), diffs } };
  const serialized = JSON.stringify(next);
  if (serialized === row.data) return false;
  db.prepare("UPDATE message SET data = ?, time_updated = ? WHERE id = ?").run(serialized, updatedAt, id);
  return true;
}

function upsertJson(db, table, id, value) {
  const serialized = JSON.stringify(value.data);
  const current = db.prepare(`SELECT session_id, ${table === "part" ? "message_id," : ""} time_created, time_updated, data FROM ${table} WHERE id = ?`).get(id);
  if (current && current.session_id === value.sessionID
    && (table !== "part" || current.message_id === value.messageID)
    && current.time_created === value.createdAt && current.time_updated === value.updatedAt && current.data === serialized) return false;
  if (table === "message") {
    db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, time_created=excluded.time_created, time_updated=excluded.time_updated, data=excluded.data")
      .run(id, value.sessionID, value.createdAt, value.updatedAt, serialized);
  } else {
    db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET message_id=excluded.message_id, session_id=excluded.session_id, time_created=excluded.time_created, time_updated=excluded.time_updated, data=excluded.data")
      .run(id, value.messageID, value.sessionID, value.createdAt, value.updatedAt, serialized);
  }
  return true;
}

function validTime(value) {
  const time = Date.parse(String(value ?? ""));
  return Number.isSafeInteger(time) ? time : undefined;
}

function safeText(value, maximum) {
  return typeof value === "string" && value.trim() && value.length <= maximum ? value.trim() : undefined;
}

function orderedHarnessMessageID(parentMessageID, kind, suffix) {
  const value = `${parentMessageID}_harness_${kind}_${suffix}`;
  if (!/^msg_[A-Za-z0-9_-]{8,128}$/.test(value)) throw new Error("Cannot derive an ordered Harness message ID");
  return value;
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return undefined; }
}
