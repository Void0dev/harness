import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const profile = process.env.OPENCODE_PROFILE ?? "web";
if (!new Set(["web", "worker"]).has(profile)) throw new Error("OPENCODE_PROFILE must be web or worker");
const baseURL = process.env.VOID_AI_BASE_URL ?? "https://ai-gateway.void0.org/v1";
const parsedBaseURL = new URL(baseURL);
if (!new Set(["http:", "https:"]).has(parsedBaseURL.protocol) || parsedBaseURL.username || parsedBaseURL.password) {
  throw new Error("VOID_AI_BASE_URL must be an HTTP(S) URL without embedded credentials");
}
const apiKey = process.env.VOID_AI_API_KEY;
if (!apiKey || /\s/.test(apiKey)) throw new Error("VOID_AI_API_KEY is required and must not contain whitespace");
const modelID = process.env.VOID_AI_MODEL_ID;
if (!modelID || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(modelID)) {
  throw new Error("VOID_AI_MODEL_ID must be a bounded model identifier");
}

const configRoot = process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? "/tmp", ".config");
const configDir = path.join(configRoot, "opencode");
await fs.mkdir(configDir, { recursive: true, mode: 0o700 });

const disabledBuiltins = {
  build: { disable: true },
  plan: { disable: true },
  general: { disable: true },
  explore: { disable: true },
  scout: { disable: true },
};
const agents = profile === "web"
  ? {
      ...disabledBuiltins,
      chat: {
        description: "Read-only assistant for discussing the connected application",
        mode: "primary",
        permission: {
          "*": "allow",
          edit: "deny",
          bash: "deny",
          task: "deny",
          external_directory: "deny",
        },
      },
      "harness-worker": {
        description: "Child-session coding worker for a GitHub Issue",
        mode: "primary",
        permission: {
          "*": "allow",
          external_directory: "deny",
        },
      },
    }
  : {
      ...disabledBuiltins,
      "harness-worker": {
        description: "Internal OpenCode Harness coding worker",
        mode: "primary",
        permission: {
          "*": "allow",
          external_directory: "deny",
        },
      },
    };

const config = {
  $schema: "https://opencode.ai/config.json",
  model: `void/${modelID}`,
  default_agent: profile === "web" ? "chat" : "harness-worker",
  provider: {
    void: {
      npm: "@ai-sdk/openai-compatible",
      name: "Void AI Gateway",
      options: { baseURL, apiKey },
      models: { [modelID]: { name: modelID } },
    },
  },
  agent: agents,
};
await fs.writeFile(path.join(configDir, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

const command = process.argv.slice(2);
if (command.length === 0) process.exit(0);
const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: process.env });
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
