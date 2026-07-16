import fs from "node:fs/promises";
import path from "node:path";

export type IssueRunState = {
  issueNumber: number;
  branch: string;
  status: "running" | "awaiting_human" | "publish_pending" | "finished" | "failed";
  lastSessionId?: string;
  lastLogPath?: string;
  prUrl?: string;
  updatedAt: string;
};

export function nextRunAction(state?: IssueRunState) {
  if (state?.status === "finished" && state.prUrl) return "finalize" as const;
  if (state?.status === "publish_pending" || state?.status === "finished") return "publish" as const;
  return "run" as const;
}

export class StateStore {
  private readonly filePath: string;
  private states = new Map<number, IssueRunState>();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "state", "runs.json");
  }

  async load() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as IssueRunState[];
      this.states = new Map(parsed.map((item) => [item.issueNumber, item]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(issueNumber: number) {
    return this.states.get(issueNumber);
  }

  async set(state: Omit<IssueRunState, "updatedAt">) {
    this.states.set(state.issueNumber, {
      ...state,
      updatedAt: new Date().toISOString(),
    });
    await this.flush();
  }

  private async flush() {
    const payload = JSON.stringify([...this.states.values()], null, 2);
    const temporary = `${this.filePath}.tmp`;
    await fs.writeFile(temporary, `${payload}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }
}
