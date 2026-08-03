import { sign } from "node:crypto";
import fs from "node:fs/promises";

function requiredInteger(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive decimal integer`);
  }
  return value;
}

async function privateKey(env) {
  if (!env.GITHUB_APP_PRIVATE_KEY_PATH) {
    throw new Error("GITHUB_APP_PRIVATE_KEY_PATH is required");
  }
  return fs.readFile(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export async function githubAppInstallationToken({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 10_000,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("GitHub installation token timeout must be between 1 and 60000 milliseconds");
  }
  const appID = requiredInteger(env, "GITHUB_APP_ID");
  const installationID = requiredInteger(env, "GITHUB_APP_INSTALLATION_ID");
  const key = await privateKey(env);
  const nowSeconds = Math.floor(now() / 1000);
  const encodedHeader = encodeJson({ alg: "RS256", typ: "JWT" });
  const encodedPayload = encodeJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 540,
    iss: appID,
  });
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/app/installations/${installationID}/access_tokens`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${unsigned}.${signature}`,
        "user-agent": "opencode-harness",
        "x-github-api-version": "2022-11-28",
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("GitHub installation token request timed out", { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`GitHub installation token request failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (typeof payload?.token !== "string" || !payload.token || /\s/.test(payload.token)) {
    throw new Error("GitHub installation token response is invalid");
  }
  return payload.token;
}
