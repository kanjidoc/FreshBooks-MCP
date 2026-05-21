import { refreshIfNeeded } from "../freshbooks-client";

/** The shape of a registered MCP tool definition (returned by the SDK `tool()` helper). */
type ToolDefinition = { handler: (...args: any[]) => Promise<unknown> };

/**
 * Wrap a tool definition so the FreshBooks access token is refreshed-if-needed
 * BEFORE the handler runs — i.e. "refresh at the beginning of everything".
 *
 * Applied centrally in `tool-registry.ts`, so individual tool files stay
 * untouched. `refreshIfNeeded()` is a cheap no-op (just a JWT-expiry decode)
 * unless the token is actually near expiry; concurrent tool calls share a single
 * refresh via the single-flight guard in `freshbooks-client.ts`.
 *
 * A refresh failure never blocks the call — the handler still runs and surfaces
 * the real API error (which will be a clear 401 if the token is genuinely dead).
 */
export function withTokenRefresh<T extends ToolDefinition>(toolDef: T): T {
  const originalHandler = toolDef.handler;
  return {
    ...toolDef,
    handler: async (...args: any[]) => {
      try {
        await refreshIfNeeded();
      } catch (err) {
        console.error(
          `[freshbooks] pre-call token refresh failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return originalHandler(...args);
    },
  } as T;
}
