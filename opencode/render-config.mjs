import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

process.umask(0o007);

const baseURL = process.env.VOID_AI_BASE_URL ?? "https://ai-gateway.void0.org/v1";
const parsedBaseURL = new URL(baseURL);
if (!new Set(["http:", "https:"]).has(parsedBaseURL.protocol) || parsedBaseURL.username || parsedBaseURL.password) {
  throw new Error("VOID_AI_BASE_URL must be an HTTP(S) URL without embedded credentials");
}
const apiKeyFile = process.env.VOID_AI_API_KEY_FILE;
if (!apiKeyFile || !path.isAbsolute(apiKeyFile)) {
  throw new Error("VOID_AI_API_KEY_FILE must be an absolute path to the model gateway key");
}
const apiKey = (await fs.readFile(apiKeyFile, "utf8")).trim();
if (!apiKey || /\s/.test(apiKey)) {
  throw new Error("VOID_AI_API_KEY_FILE must contain a model gateway key without whitespace");
}
const modelEndpoint = new URL("models", `${parsedBaseURL.toString().replace(/\/$/, "")}/`);
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10_000);
let response;
try {
  response = await fetch(modelEndpoint, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    signal: controller.signal,
  });
} finally {
  clearTimeout(timeout);
}
if (!response.ok) throw new Error(`Void AI Gateway model catalog failed with HTTP ${response.status}`);
const catalog = await response.json();
if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.data)) {
  throw new Error("Void AI Gateway model catalog must contain a data array");
}
const modelIDs = [...new Set(catalog.data.flatMap((entry) =>
  entry && typeof entry === "object" && typeof entry.id === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(entry.id)
    ? [entry.id]
    : []))].slice(0, 256);
if (modelIDs.length === 0) throw new Error("Void AI Gateway model catalog contains no usable models");
const category = (id) => id.toLowerCase().includes("image") ? "void-image"
  : id.toLowerCase().includes("video") ? "void-video" : "void";
const categoryNames = {
  void: "Void AI — Текст и код",
  "void-image": "Void AI — Изображения",
  "void-video": "Void AI — Видео",
};
const groupedModels = Object.fromEntries(Object.keys(categoryNames).map((id) => [id, {}]));
for (const id of modelIDs) groupedModels[category(id)][id] = { name: id };
const providers = Object.fromEntries(Object.entries(groupedModels)
  .filter(([, models]) => Object.keys(models).length > 0)
  .map(([id, models]) => [id, {
    npm: "@ai-sdk/openai-compatible",
    name: categoryNames[id],
    options: { baseURL, apiKey },
    models,
  }]));
const defaultProviderID = providers.void ? "void" : Object.keys(providers)[0];
const defaultModelID = Object.keys(providers[defaultProviderID].models)[0];

const configRoot = process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? "/tmp", ".config");
const configDir = path.join(configRoot, "opencode");
await fs.mkdir(configDir, { recursive: true, mode: 0o700 });

const agents = {
  build: {
    description: "Standard OpenCode agent for chat, coding, GitHub operations, and explicit releases",
    mode: "primary",
    permission: {
      "*": "allow",
      external_directory: "deny",
    },
  },
};

const config = {
  $schema: "https://opencode.ai/config.json",
  enabled_providers: Object.keys(providers),
  model: `${defaultProviderID}/${defaultModelID}`,
  default_agent: "build",
  provider: providers,
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
