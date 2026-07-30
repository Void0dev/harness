const SESSION_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;

export function sessionIdFromPath(pathname) {
  const match = /\/session\/(ses_[A-Za-z0-9_-]{8,128})(?:\/)?$/.exec(pathname);
  return match && SESSION_ID.test(match[1]) ? match[1] : undefined;
}

export function visibleCommandText(value) {
  const text = String(value ?? "").replace(/\s*<!--\s*opencode-harness-issue:\s*\d+\s*-->\s*$/i, "").trim();
  const command = /(?:^Issue #\d+:\s*|(?:^|\n\n))(\/(?:issue|retry)(?:\s+[\s\S]*)?)$/i.exec(text)?.[1];
  return command?.trim();
}

export function taskTimestamp(value, locale = "ru-RU", timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const time = Date.parse(String(value ?? ""));
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(time);
}

export function createRefreshCoordinator() {
  let sessionID;
  let activeController;
  return {
    begin(nextSessionID, { restart = false } = {}) {
      if (nextSessionID !== sessionID || restart) {
        sessionID = nextSessionID;
        activeController?.abort();
        activeController = undefined;
      } else if (activeController) return undefined;
      const controller = new AbortController();
      activeController = controller;
      return {
        signal: controller.signal,
        isCurrent: () => activeController === controller && sessionID === nextSessionID,
        finish: () => { if (activeController === controller) activeController = undefined; },
      };
    },
    clear() {
      sessionID = undefined;
      activeController?.abort();
      activeController = undefined;
    },
  };
}

const refreshCoordinator = createRefreshCoordinator();

function applyNativeMessageFixes(metadata = { users: [] }) {
  const users = new Map((metadata.users ?? []).map((item) => [item.messageId, item]));
  for (const row of document.querySelectorAll('[data-timeline-row="UserMessage"][data-message-id]')) {
    const message = row.querySelector('[data-slot="user-message-text"]');
    const command = visibleCommandText(message?.textContent);
    if (command && message.textContent !== command) message.textContent = command;

    const item = users.get(row.dataset.messageId);
    const wrap = row.querySelector('[data-slot="user-message-meta-wrap"]');
    const main = wrap?.querySelector('[data-slot="user-message-meta"]');
    const separator = wrap?.querySelector('[data-slot="user-message-meta-sep"]');
    const tail = wrap?.querySelector('[data-slot="user-message-meta-tail"]');
    const clock = item ? taskTimestamp(item.createdAt) : "";
    if (main && clock) main.textContent = clock;
    if (separator) separator.hidden = true;
    if (tail) tail.hidden = true;
  }
}

async function sessionMetadata(sessionID, signal) {
  const response = await fetch(`/__harness/api/session-metadata?sessionId=${encodeURIComponent(sessionID)}`, {
    signal, headers: { Accept: "application/json" },
  });
  return response.ok ? response.json() : { users: [] };
}

async function refresh({ restart = false } = {}) {
  if (document.visibilityState === "hidden") return;
  const sessionID = sessionIdFromPath(location.pathname);
  if (!sessionID) { refreshCoordinator.clear(); return; }
  const request = refreshCoordinator.begin(sessionID, { restart });
  if (!request) return;
  try {
    const response = await fetch(`/__harness/api/tasks?parentSessionId=${encodeURIComponent(sessionID)}`, {
      signal: request.signal, headers: { Accept: "application/json" },
    });
    if (!response.ok || !request.isCurrent()) return;
    await response.json();
    const metadata = await sessionMetadata(sessionID, request.signal);
    applyNativeMessageFixes(metadata);
  } catch (error) {
    if (error?.name !== "AbortError") console.warn("Harness native message refresh failed");
  } finally {
    request.finish();
  }
}

function boot() {
  let scheduled = false;
  const observer = new MutationObserver(() => {
    applyNativeMessageFixes();
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      void refresh();
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("visibilitychange", refresh);
  const routeChanged = () => void refresh({ restart: true });
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function harnessHistoryUpdate(...args) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event("opencode:harness-route"));
      return result;
    };
  }
  window.addEventListener("opencode:harness-route", routeChanged);
  window.addEventListener("popstate", routeChanged);
  setInterval(refresh, 1_500);
  void refresh();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
}
