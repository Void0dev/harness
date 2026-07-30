import { DatabaseSync } from "node:sqlite";

export function encodeNativeEvent(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
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
    return new Set(db.prepare("SELECT id FROM message WHERE session_id = ?").all(sessionID).map((row) => row.id));
  } finally {
    db.close();
  }
}

export function sessionSnapshotEvents(dbPath, sessionID, previousMessageIds = new Set()) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const messages = db.prepare(`
      SELECT id, session_id, data FROM message
      WHERE session_id = ? ORDER BY time_created, id
    `).all(sessionID);
    const current = new Set(messages.map((row) => row.id));
    const events = [...previousMessageIds]
      .filter((messageID) => !current.has(messageID))
      .map((messageID) => ({ type: "message.removed", properties: { sessionID, messageID } }));
    for (const row of messages) {
      const data = parseJson(row.data);
      if (!data) continue;
      events.push({
        type: "message.updated",
        properties: { info: { id: row.id, sessionID: row.session_id, ...data } },
      });
    }
    const parts = db.prepare(`
      SELECT id, message_id, session_id, data FROM part
      WHERE session_id = ? ORDER BY time_created, id
    `).all(sessionID);
    for (const row of parts) {
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

function parseJson(value) {
  try { return JSON.parse(value); } catch { return undefined; }
}
