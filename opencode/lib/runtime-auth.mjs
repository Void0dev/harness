import { timingSafeEqual } from "node:crypto";

export function runtimeRequestAuthorized({
  authorization,
  internalToken,
}) {
  const actual = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (typeof internalToken !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(internalToken);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
