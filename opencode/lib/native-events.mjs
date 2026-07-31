import { DatabaseSync } from "node:sqlite";

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
