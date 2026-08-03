import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { githubAppInstallationToken } from "../lib/github-app-installation-token.mjs";

function decodeJson(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

async function tokenFromKeyFile(t, { base64 }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "github-app-token-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const keyPath = path.join(root, base64 ? "github-app.pem.b64" : "github-app.pem");
  await fs.writeFile(keyPath, base64 ? Buffer.from(privateKeyPem).toString("base64") : privateKeyPem);
  const requests = [];
  const token = await githubAppInstallationToken({
    env: {
      GITHUB_APP_ID: "12345",
      GITHUB_APP_INSTALLATION_ID: "67890",
      [base64 ? "GITHUB_APP_PRIVATE_KEY_BASE64_PATH" : "GITHUB_APP_PRIVATE_KEY_PATH"]: keyPath,
    },
    now: () => Date.parse("2026-08-03T12:00:00Z"),
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return {
        ok: true,
        status: 201,
        async json() { return { token: "ghs_installation_token", expires_at: "2026-08-03T13:00:00Z" }; },
      };
    },
  });

  assert.equal(token, "ghs_installation_token");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.github.com/app/installations/67890/access_tokens");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.accept, "application/vnd.github+json");
  assert.equal(requests[0].options.headers["x-github-api-version"], "2022-11-28");
  const jwt = requests[0].options.headers.authorization.replace(/^Bearer /, "");
  const [encodedHeader, encodedPayload, signature] = jwt.split(".");
  assert.deepEqual(decodeJson(encodedHeader), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decodeJson(encodedPayload), {
    iat: 1_785_758_340,
    exp: 1_785_758_940,
    iss: "12345",
  });
  assert.equal(verify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    createPublicKey(privateKey),
    Buffer.from(signature, "base64url"),
  ), true);
}

test("creates an installation token from a raw private key file", async (t) => {
  await tokenFromKeyFile(t, { base64: false });
});

test("creates an installation token from a base64 private key file", async (t) => {
  await tokenFromKeyFile(t, { base64: true });
});

test("falls back to the base64 key when the configured raw key file is absent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "github-app-token-fallback-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const base64Path = path.join(root, "github-app.pem.b64");
  await fs.writeFile(base64Path, Buffer.from(privateKeyPem).toString("base64"));

  const token = await githubAppInstallationToken({
    env: {
      GITHUB_APP_ID: "12345",
      GITHUB_APP_INSTALLATION_ID: "67890",
      GITHUB_APP_PRIVATE_KEY_PATH: path.join(root, "missing.pem"),
      GITHUB_APP_PRIVATE_KEY_BASE64_PATH: base64Path,
    },
    fetchImpl: async () => ({
      ok: true,
      status: 201,
      async json() { return { token: "ghs_fallback" }; },
    }),
  });

  assert.equal(token, "ghs_fallback");
});

test("rejects missing GitHub App credentials before making a request", async () => {
  await assert.rejects(githubAppInstallationToken({ env: {}, fetchImpl: async () => {
    throw new Error("must not fetch");
  } }), /GITHUB_APP_ID/);
});

test("rejects zero GitHub App identifiers", async () => {
  await assert.rejects(githubAppInstallationToken({
    env: {
      GITHUB_APP_ID: "0",
      GITHUB_APP_INSTALLATION_ID: "67890",
      GITHUB_APP_PRIVATE_KEY_PATH: "/unused.pem",
    },
    fetchImpl: async () => { throw new Error("must not fetch"); },
  }), /positive decimal integer/);
});
