import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  FRESHBOOKS_CLIENT_ID: string;
  FRESHBOOKS_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
}

/**
 * Props passed through the OAuth flow and available as this.props in McpAgent.
 * These are encrypted and stored in the MCP-facing token by workers-oauth-provider.
 */
export interface Props extends Record<string, unknown> {
  userId: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  businessId: string;
}
