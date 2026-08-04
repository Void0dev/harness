type ClosableServer = {
  close(callback: (error?: Error) => void): void;
};

export class HarnessRuntime {
  private active: Promise<void> | undefined;
  private readonly abortController = new AbortController();
  private readonly intervals = new Set<NodeJS.Timeout>();
  private readonly servers = new Set<ClosableServer>();
  private stopping = false;
  private stopPromise: Promise<"graceful" | "timed-out"> | undefined;

  get signal() {
    return this.abortController.signal;
  }

  async runExclusive(task: () => Promise<void>): Promise<"completed" | "busy" | "stopping"> {
    if (this.stopping) return "stopping";
    if (this.active) return "busy";
    const active = task();
    this.active = active;
    try {
      await active;
      return "completed";
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  registerInterval(callback: () => void, intervalMs: number) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new Error("Runtime interval must be a positive integer");
    }
    if (this.stopping) throw new Error("Cannot register an interval while stopping");
    const timer = setInterval(callback, intervalMs);
    timer.unref();
    this.intervals.add(timer);
    return timer;
  }

  registerServer(server: ClosableServer) {
    if (this.stopping) throw new Error("Cannot register a server while stopping");
    this.servers.add(server);
    return server;
  }

  stop(release?: () => Promise<void>, graceMs = 10_000) {
    if (this.stopPromise) return this.stopPromise;
    if (!Number.isSafeInteger(graceMs) || graceMs < 1) {
      throw new Error("Shutdown grace period must be a positive integer");
    }
    this.stopping = true;
    this.abortController.abort();
    this.stopPromise = (async () => {
      const deadline = Date.now() + graceMs;
      for (const timer of this.intervals) clearInterval(timer);
      this.intervals.clear();
      const graceful = (async () => {
        await Promise.all([...this.servers].map(closeServer));
        this.servers.clear();
        await this.active;
      })();
      const outcome = await settleWithin(graceful, remainingTime(deadline));
      if (outcome.kind === "timed-out") graceful.catch(() => undefined);
      const releasing = Promise.resolve().then(async () => { await release?.(); });
      const releaseOutcome = await settleWithin(releasing, remainingTime(deadline));
      if (releaseOutcome.kind === "timed-out") releasing.catch(() => undefined);
      if (outcome.kind === "failed") throw outcome.error;
      if (releaseOutcome.kind === "failed") throw releaseOutcome.error;
      return outcome.kind === "timed-out" || releaseOutcome.kind === "timed-out"
        ? "timed-out"
        : "graceful";
    })();
    return this.stopPromise;
  }
}

function remainingTime(deadline: number) {
  return Math.max(0, deadline - Date.now());
}

function settleWithin(operation: Promise<void>, milliseconds: number) {
  return new Promise<
    { kind: "graceful" }
    | { kind: "failed"; error: unknown }
    | { kind: "timed-out" }
  >((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "timed-out" }), milliseconds);
    operation.then(
      () => {
        clearTimeout(timer);
        resolve({ kind: "graceful" });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ kind: "failed", error });
      },
    );
  });
}

function closeServer(server: ClosableServer) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
