#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { githubAppInstallationToken } from "./github-app-installation-token.mjs";

function childEnvironment(env) {
  const child = { ...env };
  delete child.GH_TOKEN;
  delete child.GITHUB_TOKEN;
  delete child.GITHUB_APP_ID;
  delete child.GITHUB_APP_INSTALLATION_ID;
  delete child.GITHUB_APP_PRIVATE_KEY_PATH;
  delete child.GITHUB_APP_PRIVATE_KEY_BASE64_PATH;
  return child;
}

export function harnessGithubCommand({ argv, env = process.env, token }) {
  const [command, ...args] = argv;
  if (!new Set(["gh", "git"]).has(command)) {
    throw new Error("harness-github requires gh or git as its first argument");
  }
  const childEnv = childEnvironment(env);
  if (command === "gh") {
    childEnv.GH_TOKEN = token;
  } else {
    const count = Number.parseInt(childEnv.GIT_CONFIG_COUNT ?? "0", 10);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("GIT_CONFIG_COUNT must be a non-negative integer");
    childEnv.GIT_CONFIG_COUNT = String(count + 1);
    childEnv[`GIT_CONFIG_KEY_${count}`] = "http.https://github.com/.extraHeader";
    const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
    childEnv[`GIT_CONFIG_VALUE_${count}`] = `Authorization: Basic ${basic}`;
  }
  return { command, args, env: childEnv };
}

export async function runHarnessGithub({
  argv = process.argv.slice(2),
  env = process.env,
  tokenProvider = githubAppInstallationToken,
  spawnImpl = spawn,
} = {}) {
  const token = await tokenProvider({ env });
  const child = harnessGithubCommand({ argv, env, token });
  return new Promise((resolve, reject) => {
    const process = spawnImpl(child.command, child.args, { env: child.env, stdio: "inherit" });
    process.once("error", reject);
    process.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const result = await runHarnessGithub();
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exit(result.code ?? 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
