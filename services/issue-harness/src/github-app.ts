import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import fs from "node:fs/promises";

type AppAuthenticationOptions = {
  appId: number;
  installationId: number;
  privateKey: string;
};

type InstallationAuth = (options: { type: "installation" }) => Promise<{ token?: string }>;

type GitHubAppDependencies = {
  createAuth: (options: AppAuthenticationOptions) => InstallationAuth;
  createOctokit: (options: AppAuthenticationOptions) => Octokit;
};

const defaultDependencies: GitHubAppDependencies = {
  createAuth: (options) => createAppAuth(options) as InstallationAuth,
  createOctokit: (options) => new Octokit({
    authStrategy: createAppAuth,
    auth: options,
  }),
};

export async function createGitHubAppCredentials(
  options: {
    appId: number;
    installationId: number;
    privateKeyPath: string;
  },
  dependencies: GitHubAppDependencies = defaultDependencies,
) {
  const privateKey = await fs.readFile(options.privateKeyPath, "utf8");
  if (!privateKey.trim()) throw new Error("GitHub App private key file is empty");
  const authOptions = {
    appId: options.appId,
    installationId: options.installationId,
    privateKey,
  };
  const installationAuth = dependencies.createAuth(authOptions);
  const octokit = dependencies.createOctokit(authOptions);

  return {
    octokit,
    async getToken() {
      const authentication = await installationAuth({ type: "installation" });
      if (typeof authentication.token !== "string" || !authentication.token) {
        throw new Error("GitHub App returned an invalid installation token response");
      }
      return authentication.token;
    },
  };
}
