import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { FreshBooksMcpAgent } from "./mcp-agent";
import { FreshBooksHandler } from "./freshbooks-handler";

// Must be exported for Durable Object binding
export { FreshBooksMcpAgent };

export default new OAuthProvider({
  apiHandler: FreshBooksMcpAgent.serve("/mcp"),
  apiRoute: "/mcp",
  defaultHandler: FreshBooksHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
