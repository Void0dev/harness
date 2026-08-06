import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export function encodeNativeEvent(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function terminalSessionIdleEvent(sessionID) {
  return { type: "session.status", properties: { sessionID, status: { type: "idle" } } };
}

export function taskCompletionEvents(snapshotEvents, sessionID, isTerminal = true) {
  return isTerminal ? [...snapshotEvents, terminalSessionIdleEvent(sessionID)] : snapshotEvents;
}

export function createNativeEventHub() {
  const subscribers = new Set();
  return {
    subscribe(writer, options = {}) {
      const subscriber = { writer, options };
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    publish(events) {
      if (events.length === 0) return;
      for (const { writer, options } of subscribers) {
        const frames = events.map((event) => encodeNativeEvent(eventEnvelope(event, options))).join("");
        writer(frames);
      }
    },
  };
}

function eventEnvelope(event, { pathname, directory }) {
  if (pathname === "/global/event") return { directory, payload: event };
  return event;
}

export function createSseForwarder(write) {
  const decoder = new TextDecoder();
  let pending = "";
  return {
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      while (true) {
        const match = /\r?\n\r?\n/.exec(pending);
        if (!match) break;
        const end = match.index + match[0].length;
        write(pending.slice(0, end));
        pending = pending.slice(end);
      }
    },
    end() {
      pending += decoder.decode();
      if (pending) write(pending);
      pending = "";
    },
  };
}

export function captureSessionMessageIds(dbPath, sessionID) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      messages: captureRows(db, "message", sessionID),
      parts: captureRows(db, "part", sessionID),
    };
  } finally {
    db.close();
  }
}

export function findGitHubIssueParentSession(dbPath, issueNumber, directory) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0 || typeof directory !== "string" || !directory) {
    throw new Error("Invalid GitHub Issue parent-session lookup");
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const title = `GitHub Issue #${issueNumber}`;
    return db.prepare(`
      SELECT id FROM session
      WHERE parent_id IS NULL AND directory = ?
        AND (title = ? COLLATE NOCASE OR title LIKE ? COLLATE NOCASE)
      ORDER BY time_created ASC, id ASC
      LIMIT 1
    `).get(directory, title, `${title}:%`)?.id;
  } finally {
    db.close();
  }
}

export function listGitHubIssueParentSessions(dbPath, directory) {
  if (typeof directory !== "string" || !directory) throw new Error("Invalid GitHub Issue session directory");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(`
      SELECT id, title, time_created, time_updated FROM session
      WHERE parent_id IS NULL AND directory = ? AND title LIKE 'GitHub Issue #%'
      ORDER BY time_created ASC, id ASC
    `).all(directory).flatMap((row) =>
      /^GitHub Issue #\d+(?:\b|:)/i.test(String(row.title ?? ""))
        ? [{ id: row.id, title: row.title, time: { created: row.time_created, updated: row.time_updated } }]
        : []);
  } finally {
    db.close();
  }
}


export function sessionCreatedEvent(dbPath, sessionID) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT id, project_id, parent_id, slug, directory, path, title, version, cost,
        tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
        time_created, time_updated
      FROM session WHERE id = ?
    `).get(sessionID);
    if (!row) return undefined;
    return {
      id: `evt_${randomUUID().replaceAll("-", "")}`,
      type: "session.created",
      properties: {
        sessionID: row.id,
        info: {
          id: row.id,
          projectID: row.project_id,
          ...(row.parent_id ? { parentID: row.parent_id } : {}),
          slug: row.slug,
          directory: row.directory,
          path: row.path,
          title: row.title,
          version: row.version,
          cost: row.cost,
          tokens: {
            input: row.tokens_input,
            output: row.tokens_output,
            reasoning: row.tokens_reasoning,
            cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
          },
          time: { created: row.time_created, updated: row.time_updated },
        },
      },
    };
  } finally {
    db.close();
  }
}

export function sessionSnapshotEvents(dbPath, sessionID, previousState = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const messages = db.prepare(`
      SELECT id, session_id, time_created, time_updated, data FROM message
      WHERE session_id = ? ORDER BY time_created, id
    `).all(sessionID);
    const parts = db.prepare(`
      SELECT id, message_id, session_id, time_created, time_updated, data FROM part
      WHERE session_id = ? ORDER BY time_created, id
    `).all(sessionID);
    const previousMessages = previousState?.messages instanceof Map ? previousState.messages : new Map();
    const previousParts = previousState?.parts instanceof Map ? previousState.parts : new Map();
    const current = new Set(messages.map((row) => row.id));
    const events = [...previousMessages.keys()]
      .filter((messageID) => !current.has(messageID))
      .map((messageID) => ({ type: "message.removed", properties: { sessionID, messageID } }));
    for (const row of messages) {
      if (previousMessages.get(row.id) === rowFingerprint(row)) continue;
      const data = parseJson(row.data);
      if (!data) continue;
      events.push({
        type: "message.updated",
        properties: { info: { id: row.id, sessionID: row.session_id, ...data } },
      });
    }
    for (const row of parts) {
      if (previousParts.get(row.id) === rowFingerprint(row)) continue;
      const data = parseJson(row.data);
      if (!data) continue;
      events.push({
        type: "message.part.updated",
        properties: { part: { id: row.id, messageID: row.message_id, sessionID: row.session_id, ...data } },
      });
    }
    return events;
  } finally {
    db.close();
  }
}

function captureRows(db, table, sessionID) {
  const rows = db.prepare(`
    SELECT id, time_created, time_updated, data FROM ${table}
    WHERE session_id = ?
  `).all(sessionID);
  return new Map(rows.map((row) => [row.id, rowFingerprint(row)]));
}

function rowFingerprint(row) {
  return `${row.time_created}\u0000${row.time_updated}\u0000${row.data}`;
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return undefined; }
}
