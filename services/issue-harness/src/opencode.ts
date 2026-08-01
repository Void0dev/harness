const SESSION_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const DEFAULT_ISSUE_MODEL_ID = "gpt-5.6-sol";

export function parseParentSessionId(body: string | null | undefined) {
  if (!body) return undefined;
  const match = body.match(/<!--\s*opencode-harness-parent:\s*([^\s]+)\s*-->/i);
  const value = match?.[1];
  return value && SESSION_ID.test(value) ? value : undefined;
}

export function parseIssueModelId(body: string | null | undefined, fallback = DEFAULT_ISSUE_MODEL_ID) {
  if (!parseParentSessionId(body)) return fallback;
  const match = body?.match(/<!--\s*opencode-harness-model:\s*([^\s]+)\s*-->/i);
  const value = match?.[1];
  return value && MODEL_ID.test(value) ? value : fallback;
}

export function parseIssueProviderId(body: string | null | undefined, fallback = "void") {
  if (!parseParentSessionId(body)) return fallback;
  const value = body?.match(/<!--\s*opencode-harness-provider:\s*([^\s]+)\s*-->/i)?.[1];
  return value && /^(void|void-image|void-video)$/.test(value) ? value : fallback;
}
