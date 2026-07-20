import { execFile, spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  createBindMountSandboxProvider,
  type BindMountSandboxHandle,
  type BindMountSandboxProvider,
} from "@ai-hero/sandcastle";

const execFileAsync = promisify(execFile);

type SandboxMount = {
  hostPath: string;
  sandboxPath: string;
  readonly?: boolean;
};

export type HardenedDockerOptions = {
  imageName: string;
  network: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  tmpfsMb: number;
  maxOutputBytes: number;
  containerUid?: number;
  containerGid?: number;
  environment?: Record<string, string>;
  mounts?: readonly SandboxMount[];
  requireRootlessDaemon: boolean;
  expectedDaemonId?: string;
};

export type DockerRunOptions = {
  containerName: string;
  imageName: string;
  user: string;
  network: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  tmpfsMb: number;
  environment: Record<string, string>;
  mounts: readonly SandboxMount[];
  workdir?: string;
};

export function hardenedDockerRunArguments(options: DockerRunOptions): string[] {
  assertRuntimeLimits(options);
  const args = [
    "run",
    "-d",
    "--name",
    options.containerName,
    "--user",
    options.user,
    "--memory",
    `${options.memoryMb}m`,
    "--cpus",
    String(options.cpus),
    "--pids-limit",
    String(options.pidsLimit),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${options.tmpfsMb}m,mode=1777`,
    "--tmpfs",
    "/run:rw,noexec,nosuid,nodev,size=16m,mode=0755",
    "--pull",
    "never",
    "--network",
    options.network,
  ];
  if (options.workdir) args.push("--workdir", options.workdir);
  for (const [key, value] of Object.entries(options.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid sandbox environment name: ${key}`);
    }
    args.push("--env", `${key}=${value}`);
  }
  for (const mount of options.mounts) {
    assertMountPath(mount.hostPath);
    assertMountPath(mount.sandboxPath);
    args.push(
      "--mount",
      `type=bind,src=${mount.hostPath},dst=${mount.sandboxPath}${mount.readonly ? ",readonly" : ""}`,
    );
  }
  args.push(options.imageName);
  return args;
}

export function hardenedDocker(options: HardenedDockerOptions): BindMountSandboxProvider {
  return createBindMountSandboxProvider({
    name: "hardened-docker",
    env: options.environment,
    sandboxHomedir: "/home/agent",
    create: async (createOptions) => {
      await assertDockerDaemon(options.requireRootlessDaemon, options.expectedDaemonId);
      await assertInternalNetwork(options.network);
      await assertImageUser(options.imageName);
      const containerName = `sandcastle-${randomUUID()}`;
      const containerUid = options.containerUid ?? 10001;
      const containerGid = options.containerGid ?? 10001;
      const worktreePath = createOptions.mounts.find(
        (mount) => mount.hostPath === createOptions.worktreePath,
      )?.sandboxPath ?? "/home/agent/workspace";
      const mounts = [...createOptions.mounts, ...(options.mounts ?? [])];
      await docker(hardenedDockerRunArguments({
        containerName,
        imageName: options.imageName,
        user: `${containerUid}:${containerGid}`,
        network: options.network,
        memoryMb: options.memoryMb,
        cpus: options.cpus,
        pidsLimit: options.pidsLimit,
        tmpfsMb: options.tmpfsMb,
        environment: {
          ...createOptions.env,
          ...options.environment,
          HOME: "/home/agent",
        },
        mounts,
        workdir: worktreePath,
      }));
      return dockerHandle(containerName, worktreePath, options.maxOutputBytes);
    },
  });
}

export function mintBrokerToken(options: {
  signingSecret: string;
  audience: string;
  repository: string;
  issueNumber: number;
  ttlSeconds: number;
  nowSeconds?: number;
  tokenId?: string;
}) {
  if (options.signingSecret.length < 32) throw new Error("Broker signing secret is too short");
  if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 60 || options.ttlSeconds > 3600) {
    throw new Error("Broker token lifetime must be between 60 and 3600 seconds");
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "HS256", typ: "JWT" });
  const payload = base64url({
    iss: "issue-harness",
    aud: options.audience,
    sub: options.repository,
    issue: options.issueNumber,
    jti: options.tokenId ?? randomUUID(),
    iat: now,
    exp: now + options.ttlSeconds,
  });
  const signature = createHmac("sha256", options.signingSecret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function assertInternalNetwork(network: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(network)) {
    throw new Error("SANDBOX_NETWORK is invalid");
  }
  const output = await docker(["network", "inspect", "--format", "{{.Internal}}", network]);
  if (output.trim() !== "true") {
    throw new Error(`Sandbox network ${network} must be an internal Docker network`);
  }
}

async function assertDockerDaemon(requireRootless: boolean, expectedDaemonId: string | undefined) {
  if (!requireRootless) return;
  if (!expectedDaemonId) throw new Error("Local Docker daemon identity is required");
  const actualDaemonIdOutput = await docker(["info", "--format", "{{.ID}}"]);
  const actualDaemonId = actualDaemonIdOutput.trim();
  const securityOptions = await docker(["info", "--format", "{{json .SecurityOptions}}"]);
  assertDockerDaemonAttestation(actualDaemonId, securityOptions, expectedDaemonId);
}

export function assertDockerDaemonAttestation(
  actualDaemonId: string,
  securityOptions: string,
  expectedDaemonId: string,
) {
  if (!actualDaemonId || actualDaemonId !== expectedDaemonId) {
    throw new Error("Connected Docker daemon identity does not match the configured identity");
  }
  if (!securityOptions.includes("name=rootless")) {
    throw new Error("Connected Docker daemon does not attest rootless SecurityOptions");
  }
}

async function assertImageUser(imageName: string) {
  const output = await docker(["image", "inspect", "--format", "{{.Config.User}}", imageName]);
  if (!output.trim()) throw new Error(`Sandbox image ${imageName} must declare a non-root USER`);
  if (/^(?:0|root)(?::|$)/.test(output.trim())) {
    throw new Error(`Sandbox image ${imageName} declares a root USER`);
  }
}

function dockerHandle(
  containerName: string,
  worktreePath: string,
  maxOutputBytes: number,
): BindMountSandboxHandle {
  return {
    worktreePath,
    exec: (command, options) => boundedDockerExec(
      [
        "exec",
        ...(options?.stdin === undefined ? [] : ["-i"]),
        ...(options?.cwd ? ["--workdir", options.cwd] : []),
        containerName,
        "sh",
        "-c",
        options?.sudo ? `sudo ${command}` : command,
      ],
      maxOutputBytes,
      options?.stdin,
      options?.onLine,
    ),
    copyFileIn: async (hostPath, sandboxPath) => {
      await docker(["cp", hostPath, `${containerName}:${sandboxPath}`]);
    },
    copyFileOut: async (sandboxPath, hostPath) => {
      await docker(["cp", `${containerName}:${sandboxPath}`, hostPath]);
    },
    close: async () => {
      await docker(["rm", "--force", containerName]);
    },
  };
}

async function boundedDockerExec(
  args: string[],
  maxOutputBytes: number,
  stdin: string | undefined,
  onLine: ((line: string) => void) | undefined,
) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn("docker", args, { stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (!childStdout || !childStderr) {
      child.kill("SIGKILL");
      reject(new Error("Docker exec did not create bounded output pipes"));
      return;
    }
    const stdout: string[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let exceeded = false;
    const account = (bytes: number) => {
      outputBytes += bytes;
      if (outputBytes > maxOutputBytes && !exceeded) {
        exceeded = true;
        child.kill("SIGKILL");
      }
    };
    let pendingLine = "";
    childStdout.on("data", (chunk: Buffer) => {
      account(chunk.length);
      if (exceeded) return;
      if (!onLine) {
        stdout.push(chunk.toString("utf8"));
        return;
      }
      pendingLine += chunk.toString("utf8");
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() ?? "";
      for (const line of lines) {
        const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
        stdout.push(normalized);
        onLine(normalized);
      }
    });
    childStderr.on("data", (chunk: Buffer) => {
      account(chunk.length);
      if (!exceeded) stderr.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (exceeded) {
        reject(new Error(`Sandbox output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      if (onLine && pendingLine) {
        stdout.push(pendingLine);
        onLine(pendingLine);
      }
      resolve({
        stdout: stdout.join(onLine ? "\n" : ""),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

async function docker(args: string[]) {
  const result = await execFileAsync("docker", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}

function assertMountPath(value: string) {
  if (!value.startsWith("/") || value.includes(",") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Unsafe sandbox mount path: ${JSON.stringify(value)}`);
  }
}

function assertRuntimeLimits(options: DockerRunOptions) {
  if (!Number.isSafeInteger(options.memoryMb) || options.memoryMb < 256 || options.memoryMb > 65_536) {
    throw new Error("Sandbox memory limit is outside the safe range");
  }
  if (!Number.isFinite(options.cpus) || options.cpus < 0.25 || options.cpus > 64) {
    throw new Error("Sandbox CPU limit is outside the safe range");
  }
  if (!Number.isSafeInteger(options.pidsLimit) || options.pidsLimit < 32 || options.pidsLimit > 4096) {
    throw new Error("Sandbox PID limit is outside the safe range");
  }
  if (!Number.isSafeInteger(options.tmpfsMb) || options.tmpfsMb < 32 || options.tmpfsMb > 4096) {
    throw new Error("Sandbox tmpfs limit is outside the safe range");
  }
}

function base64url(value: object) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
