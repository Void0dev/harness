const SESSION_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;

const GITHUB_PARENT_TITLE = /^GitHub Issue #\d+(?:\b|:)/i;
const OPEN_CODE_TABS_STORAGE_KEY = "opencode.window.browser.dat:tabs";
const GITHUB_TABS_MEMORY_KEY = "opencode.harness.github-issue-tabs.v1";

export function appendBackgroundSessionTab(raw, sessionId) {
  if (!SESSION_ID.test(sessionId)) return raw;
  let tabs;
  try { tabs = JSON.parse(raw); } catch { return raw; }
  if (!Array.isArray(tabs)) return raw;
  if (tabs.some((tab) => tab?.type === "session" && tab?.sessionId === sessionId)) return raw;
  const server = tabs.find((tab) => tab?.type === "session" && typeof tab?.server === "string")?.server;
  if (!server) return raw;
  return JSON.stringify([...tabs, { type: "session", server, sessionId }]);
}

function canonicalGitHubIssueSessions(sessions) {
  if (!Array.isArray(sessions)) return [];
  const canonical = new Map();
  for (const session of sessions) {
    const match = /^GitHub Issue #(\d+)(?:\b|:)/i.exec(String(session?.title ?? ""));
    const issueNumber = Number(match?.[1]);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0 || !SESSION_ID.test(String(session?.id ?? ""))) continue;
    const createdValue = Number(session?.time?.created);
    const candidate = {
      issueNumber,
      sessionId: String(session.id),
      created: Number.isFinite(createdValue) ? createdValue : Number.MAX_SAFE_INTEGER,
    };
    const current = canonical.get(issueNumber);
    if (!current || candidate.created < current.created
      || (candidate.created === current.created && candidate.sessionId < current.sessionId)) {
      canonical.set(issueNumber, candidate);
    }
  }
  return [...canonical.values()].sort((left, right) => left.created - right.created || left.issueNumber - right.issueNumber);
}

function readGitHubTabMemory(raw) {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !Array.isArray(parsed.repositories)) return undefined;
    return {
      version: 1,
      repositories: parsed.repositories.flatMap((repository) => {
        if (typeof repository?.scope !== "string" || !repository.scope || !Array.isArray(repository.issues)) return [];
        const issues = [...new Set(repository.issues.filter((issue) => Number.isSafeInteger(issue) && issue > 0))].sort((a, b) => a - b);
        return [{ scope: repository.scope, issues }];
      }),
    };
  } catch {
    return undefined;
  }
}

export function synchronizeGitHubIssueTabs(rawTabs, rawMemory, scope, sessions) {
  if (typeof scope !== "string" || !scope) return { tabs: rawTabs, memory: rawMemory };
  if (!Array.isArray(sessions)) return { tabs: rawTabs, memory: rawMemory };
  let tabs;
  try { tabs = JSON.parse(rawTabs); } catch { return { tabs: rawTabs, memory: rawMemory }; }
  if (!Array.isArray(tabs)) return { tabs: rawTabs, memory: rawMemory };
  const canonical = canonicalGitHubIssueSessions(sessions);
  const memory = readGitHubTabMemory(rawMemory);
  if (!memory) {
    return {
      tabs: rawTabs,
      memory: JSON.stringify({
        version: 1,
        repositories: [{ scope, issues: canonical.map(({ issueNumber }) => issueNumber).sort((a, b) => a - b) }],
      }),
    };
  }

  let repository = memory.repositories.find((candidate) => candidate.scope === scope);
  if (!repository) {
    repository = { scope, issues: canonical.map(({ issueNumber }) => issueNumber).sort((a, b) => a - b) };
    memory.repositories.push(repository);
    return { tabs: rawTabs, memory: JSON.stringify(memory) };
  }

  const knownIssues = new Set(repository.issues);
  const server = tabs.find((tab) => tab?.type === "session" && typeof tab?.server === "string")?.server;
  const nextTabs = [...tabs];
  for (const candidate of canonical) {
    if (knownIssues.has(candidate.issueNumber)) continue;
    const alreadyOpen = tabs.some((tab) => tab?.type === "session" && tab?.sessionId === candidate.sessionId);
    if (!alreadyOpen && !server) continue;
    if (!alreadyOpen) nextTabs.push({ type: "session", server, sessionId: candidate.sessionId });
    knownIssues.add(candidate.issueNumber);
  }
  repository.issues = [...knownIssues].sort((a, b) => a - b);
  return { tabs: JSON.stringify(nextTabs), memory: JSON.stringify(memory) };
}

export function createBackgroundTabCoordinator() {
  let previousSignature;
  return {
    shouldSynchronize(sessions) {
      if (!Array.isArray(sessions)) return false;
      const signature = JSON.stringify(sessions.map((session) => ({
        id: session?.id,
        title: session?.title,
        created: session?.time?.created,
      })).sort((left, right) => String(left.id ?? "").localeCompare(String(right.id ?? ""))));
      if (signature === previousSignature) return false;
      previousSignature = signature;
      return true;
    },
  };
}

export function sessionIdFromPath(pathname) {
  const match = /\/session\/(ses_[A-Za-z0-9_-]{8,128})(?:\/)?$/.exec(pathname);
  return match && SESSION_ID.test(match[1]) ? match[1] : undefined;
}

export function visibleCommandText(value) {
  const text = String(value ?? "").replace(/\s*<!--\s*opencode-harness-issue:\s*\d+\s*-->\s*$/i, "").trim();
  const command = /(?:^Issue #\d+:\s*|(?:^|\n\n))(\/(?:issue|retry|merge)(?:\s+[\s\S]*)?)$/i.exec(text)?.[1];
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
const backgroundTabCoordinator = createBackgroundTabCoordinator();

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

async function addNewGitHubParentTab() {
  if (document.visibilityState === "hidden") return;
  try {
    const response = await fetch("/__harness/api/github-parent-sessions", { headers: { Accept: "application/json" } });
    const payload = response.ok ? await response.json() : {};
    const sessions = payload?.sessions;
    const scope = payload?.scope;
    if (!Array.isArray(sessions) || typeof scope !== "string" || !scope) return;
    if (!backgroundTabCoordinator.shouldSynchronize(sessions)) return;
    const current = localStorage.getItem(OPEN_CODE_TABS_STORAGE_KEY);
    if (!current) return;
    const currentMemory = localStorage.getItem(GITHUB_TABS_MEMORY_KEY);
    const synchronized = synchronizeGitHubIssueTabs(current, currentMemory, scope, sessions);
    const next = synchronized.tabs;
    if (next !== current) {
      localStorage.setItem(OPEN_CODE_TABS_STORAGE_KEY, next);
    }
    if (synchronized.memory !== currentMemory) localStorage.setItem(GITHUB_TABS_MEMORY_KEY, synchronized.memory);
    if (next !== current) {
      try {
        window.dispatchEvent(new StorageEvent("storage", {
          key: OPEN_CODE_TABS_STORAGE_KEY,
          oldValue: current,
          newValue: next,
          storageArea: localStorage,
          url: location.href,
        }));
      } catch {
        window.dispatchEvent(new Event("storage"));
      }
    }
  } catch {
    // The standard OpenCode stream remains the fallback if the session list is temporarily unavailable.
  }
}

function boot() {
  void addNewGitHubParentTab();
  setInterval(() => void addNewGitHubParentTab(), 1_000);
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
