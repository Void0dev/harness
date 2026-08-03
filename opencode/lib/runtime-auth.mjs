import { cookieValue, credentialsMatch, parseSessionCookie } from "../auth.mjs";

export function runtimeRequestAuthorized({
  runtimeMode,
  authorization,
  cookieHeader,
  internalToken,
  expectedUsername,
  sessionSecret,
  now,
}) {
  if (
    authorization?.startsWith("Bearer ")
    && credentialsMatch("internal", authorization.slice(7), "internal", internalToken)
  ) return true;
  if (runtimeMode || !expectedUsername || !sessionSecret) return false;
  const session = parseSessionCookie(cookieValue(cookieHeader), { secret: sessionSecret, now });
  return session?.username === expectedUsername;
}
