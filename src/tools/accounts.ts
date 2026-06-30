import { tool } from "@anthropic-ai/claude-agent-sdk";
import { getRegistry } from "../profiles";
import { getOrCreateClient, refreshIfNeeded, inspectTokenHealth } from "../freshbooks-client";

/**
 * `freshbooks_list_accounts` — the account-free directory tool. It enumerates the
 * registry's loaded profiles (one per configured FreshBooks login) and reports,
 * for each, its name, account/business id, best-effort company name, and token
 * health. It builds each profile's `Client` via `getOrCreateClient(profile)`
 * DIRECTLY — never the ALS-backed `getFreshBooksClient()` — because it runs
 * outside any `withAccount` profile context.
 *
 * (R2) The output also surfaces the registry's `collisions`, `broken`, and
 * `duplicates` so the user can see which files were excluded or quarantined and
 * why. A quarantined profile (shares an `account_id` with another profile but
 * carries a different, possibly superseded token) is marked `quarantined: true`
 * and is NEVER refreshed here — rotating its token could lock out the login's
 * refresh-token family — so its company name stays null.
 *
 * Read-only and must never throw: the whole body is guarded (catch -> isError),
 * and the per-profile company lookup is independently guarded so one bad login
 * never blanks the others.
 */
export const listAccounts = tool(
  "freshbooks_list_accounts",
  "List the FreshBooks logins this server is configured with. Returns each profile's name, account_id, business_id, company name, and token health, plus any ignored/colliding files. Use a returned name as the `account` argument to other tools.",
  {},
  async () => {
    try {
      const reg = getRegistry();
      const accounts: unknown[] = [];
      for (const profile of reg.profiles.values()) {
        const health = inspectTokenHealth(profile);
        const quarantined = profile.quarantined === true;
        let company: string | null = null;
        // (R2) Never refresh or call the API for a quarantined profile.
        if (!quarantined) {
          try {
            await refreshIfNeeded(profile);
            const me = await getOrCreateClient(profile).users.me();
            const memberships = (me as any)?.data?.businessMemberships ?? [];
            const match = memberships.find(
              (m: any) =>
                String(m?.business?.accountId ?? m?.accountId) === profile.config.accountId,
            );
            company = match?.business?.name ?? memberships[0]?.business?.name ?? null;
          } catch {
            // Health is still reported; company stays null on auth/network failure.
          }
        }
        accounts.push({
          account: profile.name,
          account_id: profile.config.accountId,
          business_id: profile.config.businessId,
          company,
          quarantined,
          token: {
            expiry_seconds: health.expirySeconds,
            expired: health.expired,
            needs_refresh: health.needsRefresh,
          },
        });
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                accounts,
                ignored_files: [...reg.broken, ...reg.duplicates],
                broken: reg.broken,
                duplicates: reg.duplicates,
                collisions: reg.collisions,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to list accounts: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } },
);
