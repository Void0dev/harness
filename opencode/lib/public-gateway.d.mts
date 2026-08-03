import type { Server } from "node:http";

export type PublicGatewayOptions = {
  port: number;
  upstreamUrl: string;
  username: string;
  password: string;
  sessionSecret: string;
  internalToken: string;
  sessionTtlSeconds?: number;
  submitMerge?: (request: {
    parentSessionId: string;
    argumentsText: string;
    requestedBy: string;
  }) => Promise<Record<string, unknown>>;
};

export function startPublicGateway(options: PublicGatewayOptions): Promise<Server>;
