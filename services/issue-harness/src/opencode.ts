const SESSION_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;

export function parseParentSessionId(body: string | null | undefined) {
  if (!body) return undefined;
  const match = body.match(/<!--\s*opencode-harness-parent:\s*([^\s]+)\s*-->/i);
  const value = match?.[1];
  return value && SESSION_ID.test(value) ? value : undefined;
}
