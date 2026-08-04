const SESSION_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const RESERVED_METADATA_MARKER = /<!--\s*opencode-harness-(?:parent|model)\s*:/i;
const METADATA_TRAILER = /(?:^|\r?\n\r?\n)<!--\s*opencode-harness-parent:\s*(ses_[A-Za-z0-9_-]{8,128})\s*-->(?:\r?\n<!--\s*opencode-harness-model:\s*([A-Za-z0-9][A-Za-z0-9_.:/-]{0,127})\s*-->)?\s*$/i;
const DEFAULT_ISSUE_MODEL_ID = "gpt-5.6-sol";

export function parseParentSessionId(body: string | null | undefined) {
  return parseMetadataTrailer(body)?.parentSessionId;
}

export function parseIssueModelId(body: string | null | undefined, fallback = DEFAULT_ISSUE_MODEL_ID) {
  return parseMetadataTrailer(body)?.modelId ?? fallback;
}

export function containsHarnessMetadataMarker(text: string) {
  return RESERVED_METADATA_MARKER.test(text);
}

export function isValidIssueModelId(value: string) {
  return MODEL_ID.test(value);
}

function parseMetadataTrailer(body: string | null | undefined) {
  if (!body) return undefined;
  const match = METADATA_TRAILER.exec(body);
  if (!match) return undefined;
  const prefix = body.slice(0, match.index);
  if (RESERVED_METADATA_MARKER.test(prefix)) return undefined;
  const parentSessionId = match[1];
  const modelId = match[2];
  if (!parentSessionId || !SESSION_ID.test(parentSessionId)) return undefined;
  return {
    parentSessionId,
    ...(modelId && MODEL_ID.test(modelId) ? { modelId } : {}),
  };
}
