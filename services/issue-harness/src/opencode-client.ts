const SESSION_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;

type Fetch = typeof fetch;
type SessionMessage = {
  info?: {
    id?: unknown;
    role?: unknown;
    parentID?: unknown;
    modelID?: unknown;
    finish?: unknown;
    error?: unknown;
    time?: { created?: unknown; completed?: unknown };
  };
  parts?: unknown;
};

export class OpenCodeSessionError extends Error {
  constructor(readonly code: "model_authentication" | "model_rate_limit" | "model_unavailable" | "model_error") {
    super(code);
    this.name = "OpenCodeSessionError";
  }
}

export class OpenCodeClient {
  private readonly authorization: string;
  private readonly fetchImpl: Fetch;
  private readonly pollIntervalMs: number;
  private readonly maximumResponseBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly sessionTimeoutMs: number;

  constructor(private readonly options: {
    baseUrl: string;
    internalToken: string;
    modelId: string;
    parentDirectory: string;
    fetchImpl?: Fetch;
    pollIntervalMs?: number;
    maximumResponseBytes?: number;
    requestTimeoutMs?: number;
    sessionTimeoutMs?: number;
  }) {
    this.authorization = `Bearer ${options.internalToken}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.maximumResponseBytes = options.maximumResponseBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maximumResponseBytes) || this.maximumResponseBytes < 1) {
      throw new Error("OpenCode maximum response size must be a positive integer");
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? 30 * 60_000;
  }

  async createParent(options: { title: string }) {
    return this.createSession(this.options.parentDirectory, { title: options.title });
  }

  async createChild(options: { parentSessionId?: string; directory: string; title: string }) {
    if (options.parentSessionId) this.assertSessionId(options.parentSessionId);
    return this.createSession(options.directory, {
      ...(options.parentSessionId ? { parentID: options.parentSessionId } : {}),
      title: options.title,
    });
  }

  async runChild(options: {
    parentSessionId?: string;
    directory: string;
    title: string;
    prompt: string;
    onProgress?: (parts: unknown[]) => void | Promise<void>;
  }) {
    const sessionId = await this.createChild(options);
    const result = await this.continueSession({
      sessionId,
      directory: options.directory,
      prompt: options.prompt,
      onProgress: options.onProgress,
    });
    return { sessionId, ...result };
  }

  async continueSession(options: {
    sessionId: string;
    directory: string;
    prompt: string;
    onProgress?: (parts: unknown[]) => void | Promise<void>;
    signal?: AbortSignal;
  }) {
    assertNotAborted(options.signal);
    this.assertSessionId(options.sessionId);
    const before = await this.listMessages(options.sessionId, options.directory, options.signal);
    const previousAssistantIds = new Set(before.flatMap((message) =>
      message.info?.role === "assistant" && typeof message.info.id === "string"
        ? [message.info.id]
        : []));
    const previousUserIds = new Set(before.flatMap((message) =>
      message.info?.role === "user" && typeof message.info.id === "string"
        ? [message.info.id]
        : []));

    await this.request(
      "POST",
      `/session/${options.sessionId}/prompt_async`,
      options.directory,
      {
        agent: "build",
        model: { providerID: "void", modelID: this.options.modelId },
        parts: [{ type: "text", text: options.prompt }],
      },
      true,
      options.signal,
    );
    const response = await this.waitForAssistantResponse(
      options.sessionId,
      options.directory,
      previousAssistantIds,
      previousUserIds,
      options.prompt,
      options.onProgress,
      options.signal,
    );
    return { text: this.messageText(response.message), ...response.generation };
  }

  childSessionPath(directory: string, sessionId: string) {
    this.assertSessionId(sessionId);
    return `/${Buffer.from(directory, "utf8").toString("base64url")}/session/${sessionId}`;
  }

  async sessionGenerationMetadata(sessionId: string, directory = this.options.parentDirectory) {
    this.assertSessionId(sessionId);
    const messages = await this.listMessages(sessionId, directory);
    const latestUserId = [...messages].reverse().find((message) =>
      message.info?.role === "user" && typeof message.info.id === "string")?.info?.id;
    if (typeof latestUserId !== "string") return {};
    return this.generationMetadata(messages.filter((message) =>
      message.info?.role === "assistant" && message.info.parentID === latestUserId));
  }

  async sessionFailure(sessionId: string, directory = this.options.parentDirectory) {
    this.assertSessionId(sessionId);
    const messages = await this.listMessages(sessionId, directory);
    const failed = [...messages].reverse().find((message) => message.info?.role === "assistant" && message.info.error);
    return failed ? sessionError(failed.info?.error) : undefined;
  }

  private async createSession(directory: string, body: object) {
    const session = await this.request("POST", "/session", directory, body) as Record<string, unknown>;
    if (typeof session.id !== "string" || !SESSION_ID.test(session.id)) {
      throw new Error("OpenCode returned an invalid session");
    }
    return session.id;
  }

  private async waitForAssistantResponse(
    sessionId: string,
    directory: string,
    previousAssistantIds: Set<string>,
    previousUserIds: Set<string>,
    submittedPrompt: string,
    onProgress?: (parts: unknown[]) => void | Promise<void>,
    signal?: AbortSignal,
  ) {
    const deadline = Date.now() + this.sessionTimeoutMs;
    const reportedProgress = new Map<string, string>();
    let lastTransientError: unknown;
    while (Date.now() <= deadline) {
      assertNotAborted(signal);
      try {
        const statuses = await this.request("GET", "/session/status", directory, undefined, false, signal) as Record<string, unknown>;
        const status = statuses[sessionId] as { type?: unknown } | undefined;
        if (status && status.type !== "idle" && status.type !== "busy" && status.type !== "retry") {
          throw new Error("OpenCode returned an invalid session status");
        }
        const messages = await this.listMessages(sessionId, directory, signal);
        const submittedUsers = messages.filter((message) =>
          message.info?.role === "user"
          && typeof message.info.id === "string"
          && !previousUserIds.has(message.info.id)
          && this.messageText(message) === submittedPrompt);
        if (submittedUsers.length === 0) {
          lastTransientError = undefined;
          await abortableDelay(this.pollIntervalMs, signal);
          continue;
        }
        if (submittedUsers.length !== 1) throw new Error("OpenCode returned an ambiguous submitted user turn");
        const submittedUserId = submittedUsers[0]?.info?.id;
        if (typeof submittedUserId !== "string") throw new Error("OpenCode returned an invalid submitted user turn");
        const freshAssistants = messages.filter((message) =>
          message.info?.role === "assistant"
          && typeof message.info.id === "string"
          && !previousAssistantIds.has(message.info.id)
          && message.info.parentID === submittedUserId);
        if (onProgress) {
          for (const message of freshAssistants) {
            const parts = Array.isArray(message.parts) ? message.parts : [];
            const fingerprint = JSON.stringify(parts);
            if (reportedProgress.get(message.info!.id as string) !== fingerprint) {
              reportedProgress.set(message.info!.id as string, fingerprint);
              await onProgress(parts);
            }
          }
        }
        const sessionSettled = status === undefined || status.type === "idle";
        const failed = [...freshAssistants].reverse().find((message) => message.info?.error);
        if (failed && sessionSettled) throw sessionError(failed.info?.error);
        const response = [...freshAssistants].reverse().find((message) =>
          !message.info?.error && this.messageText(message).trim()
          && Number.isSafeInteger(message.info?.time?.completed));
        if (response && sessionSettled) {
          return { message: response, generation: this.generationMetadata(freshAssistants) };
        }
        lastTransientError = undefined;
      } catch (error) {
        assertNotAborted(signal);
        if (error instanceof OpenCodeSessionError || !transientOpenCodeError(error)) throw error;
        lastTransientError = error;
      }
      await abortableDelay(this.pollIntervalMs, signal);
    }
    throw new Error("OpenCode session did not finish before the execution timeout", { cause: lastTransientError });
  }

  private generationMetadata(messages: SessionMessage[]) {
    const created = messages.flatMap((message) => Number.isSafeInteger(message.info?.time?.created)
      ? [Number(message.info?.time?.created)] : []);
    const completed = messages.flatMap((message) => Number.isSafeInteger(message.info?.time?.completed)
      ? [Number(message.info?.time?.completed)] : []);
    const modelId = [...messages].reverse().find((message) => typeof message.info?.modelID === "string")?.info?.modelID;
    if (typeof modelId !== "string" || !created.length || !completed.length) return {};
    return {
      modelId,
      generationStartedAt: new Date(Math.min(...created)).toISOString(),
      generationCompletedAt: new Date(Math.max(...completed)).toISOString(),
    };
  }

  private async listMessages(sessionId: string, directory: string, signal?: AbortSignal) {
    const value = await this.request("GET", `/session/${sessionId}/message`, directory, undefined, false, signal);
    if (!Array.isArray(value)) throw new Error("OpenCode returned an invalid message list");
    return value as SessionMessage[];
  }

  private messageText(message: SessionMessage) {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    return parts.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    }).join("\n");
  }

  private async request(
    method: "GET" | "POST",
    pathname: string,
    directory: string,
    body?: object,
    allowEmpty = false,
    externalSignal?: AbortSignal,
  ) {
    const url = new URL(pathname, this.options.baseUrl);
    url.searchParams.set("directory", directory);
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await this.fetchImpl(url, {
            method,
            signal: externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal,
            headers: {
              Accept: "application/json",
              Authorization: this.authorization,
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          if (!response.ok) throw new Error(`OpenCode API request failed with HTTP ${response.status}`);
          if (allowEmpty && response.status === 204) return undefined;
          const chunks: Buffer[] = [];
          let size = 0;
          if (response.body) {
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > this.maximumResponseBytes) {
                controller.abort();
                throw new Error("OpenCode API response body is too large");
              }
              chunks.push(Buffer.from(value));
            }
          }
          return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("OpenCode API request timed out"));
          }, this.requestTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private assertSessionId(value: string) {
    if (!SESSION_ID.test(value)) throw new Error("Invalid OpenCode session ID");
  }
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new Error("OpenCode session polling was interrupted");
}

function abortableDelay(milliseconds: number, signal: AbortSignal | undefined) {
  assertNotAborted(signal);
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("OpenCode session polling was interrupted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function transientOpenCodeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof TypeError
    || /fetch failed|timed out|HTTP (?:408|425|429|5\d\d)\b/i.test(message);
}

function sessionError(value: unknown) {
  const data = value && typeof value === "object" ? (value as { data?: unknown }).data : undefined;
  const details = data && typeof data === "object" ? data as { statusCode?: unknown; message?: unknown } : {};
  const status = Number(details.statusCode);
  const message = String(details.message ?? "");
  if (status === 401 || status === 403 || /authentication token|auth_unavailable|invalidated/i.test(message)) {
    return new OpenCodeSessionError("model_authentication");
  }
  if (status === 429) return new OpenCodeSessionError("model_rate_limit");
  if (status >= 500) return new OpenCodeSessionError("model_unavailable");
  return new OpenCodeSessionError("model_error");
}
