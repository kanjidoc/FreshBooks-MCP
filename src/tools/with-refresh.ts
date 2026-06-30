import { z } from "zod";
import { refreshIfNeeded } from "../freshbooks-client";
import {
  resolveProfile,
  runInProfile,
  profileCount,
  profileNames,
  defaultProfileName,
  getRegistry,
  UnknownProfileError,
  type ProfileState,
} from "../profiles";

/** The shape of a registered MCP tool definition (returned by the SDK `tool()` helper). */
export type ToolDefinition = {
  name: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any, extra: unknown) => Promise<any>;
};

const accountField = z
  .string()
  .optional()
  .describe(
    "Which configured FreshBooks login to act on. Run freshbooks_list_accounts to see valid names. Required when more than one account is configured.",
  );

const errorResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

/**
 * Name the profile a quarantined one collides with, for a friendlier refusal
 * message. The colliding file is recorded in the registry's `collisions` list as
 * a `same-account` entry keyed by the quarantined profile's own file. Falls back
 * to a generic phrase if the entry can't be found.
 */
function collidingProfileName(profile: ProfileState): string {
  const hit = getRegistry().collisions.find(
    (c) => c.file === `${profile.name}.env` && c.kind === "same-account",
  );
  return hit ? hit.collidesWith.replace(/\.env$/, "") : "another configured account";
}

/**
 * Wrap an API tool so each call targets a named FreshBooks login ("profile").
 *
 * It injects an optional `account` field into the tool's `inputSchema`, resolves
 * the requested profile (or the lone default), refreshes that profile's token
 * if needed, and runs the original handler inside the AsyncLocalStorage profile
 * context so the zero-arg `getFreshBooksClient()`/`getAccountId()`/`getBusinessId()`
 * helpers resolve to it. The `account` argument is stripped before the handler
 * runs, so the 17 resource tool files never see it.
 *
 * Never throws: the WHOLE resolve+run is guarded, so every failure path returns
 * `{ content, isError: true }`.
 *
 * (R2) A quarantined profile — one sharing an `account_id` with another profile
 * but carrying a different (possibly superseded) token — is REFUSED on explicit
 * use: the handler never runs and the token is never refreshed, so a diverged
 * stale copy can't burn the login's refresh-token family.
 */
export function withAccount<T extends ToolDefinition>(toolDef: T): T {
  const originalHandler = toolDef.handler;
  return {
    ...toolDef,
    inputSchema: { ...toolDef.inputSchema, account: accountField },
    handler: async (args: any, extra: unknown) => {
      let profile: ProfileState;
      try {
        const requested = typeof args?.account === "string" ? args.account.trim() : "";
        let name = requested;
        if (!name) {
          if (profileCount() >= 2) {
            return errorResult(
              `This server has multiple FreshBooks accounts configured (${profileNames().join(
                ", ",
              )}). Pass account=<name> to choose one.`,
            );
          }
          const def = defaultProfileName();
          if (!def) {
            return errorResult(
              "No FreshBooks accounts are configured. Run `npm run setup` to add one.",
            );
          }
          name = def;
        }
        profile = resolveProfile(name);
      } catch (err) {
        if (err instanceof UnknownProfileError) return errorResult(err.message);
        return errorResult(
          `Account resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // (R2) Refuse a quarantined profile BEFORE any refresh or handler call.
      if (profile.quarantined) {
        return errorResult(
          `Account "${profile.name}" is quarantined: it shares an account_id with "${collidingProfileName(
            profile,
          )}" and may be a stale copy of the same login. If it is a genuinely separate login, add a line "# freshbooks-distinct-login" to profiles/${
            profile.name
          }.env and retry; otherwise remove it.`,
        );
      }

      const { account: _drop, ...handlerArgs } = args ?? {};
      return runInProfile(profile, async () => {
        try {
          await refreshIfNeeded(profile);
        } catch (err) {
          console.error(
            `[freshbooks] pre-call refresh failed for "${profile.name}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        return originalHandler(handlerArgs, extra);
      });
    },
  } as T;
}

/**
 * Account-free tools (`freshbooks_help`, `freshbooks_list_accounts`): identity
 * passthrough — no `account` schema field, no profile context.
 */
export function withoutAccount<T extends ToolDefinition>(toolDef: T): T {
  return toolDef;
}
