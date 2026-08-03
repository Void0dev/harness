import type { Server } from "node:http";

export type PublicGatewayOptions = {
  port: number;
  upstreamUrl: string;
  username: string;
  password: string;
  sessionSecret: string;
  internalToken: string;
  sessionTtlSeconds?: number;
};

export function startPublicGateway(options: PublicGatewayOptions): Promise<Server>;
