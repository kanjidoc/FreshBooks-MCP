/**
 * FreshBooks OAuth utility functions.
 */

export type Props = {
  userId: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  businessId: string;
};

/**
 * Build the FreshBooks authorization URL.
 */
export function getUpstreamAuthorizeUrl(options: {
  client_id: string;
  redirect_uri: string;
  state?: string;
}): string {
  const url = new URL("https://auth.freshbooks.com/oauth/authorize");
  url.searchParams.set("client_id", options.client_id);
  url.searchParams.set("redirect_uri", options.redirect_uri);
  url.searchParams.set("response_type", "code");
  if (options.state) {
    url.searchParams.set("state", options.state);
  }
  return url.href;
}

/**
 * Exchange an authorization code for FreshBooks access + refresh tokens.
 * FreshBooks uses JSON body (not form-encoded like GitHub).
 *
 * Returns [accessToken, refreshToken, null] on success,
 * or [null, null, Response] on failure.
 */
export async function fetchUpstreamAuthToken(options: {
  client_id: string;
  client_secret: string;
  code: string | undefined;
  redirect_uri: string;
}): Promise<
  [string, string, null] | [null, null, Response]
> {
  if (!options.code) {
    return [null, null, new Response("Missing authorization code", { status: 400 })];
  }

  const response = await fetch("https://api.freshbooks.com/auth/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: options.client_id,
      client_secret: options.client_secret,
      code: options.code,
      redirect_uri: options.redirect_uri,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("FreshBooks token exchange failed:", text);
    return [null, null, new Response("Failed to exchange authorization code", { status: 500 })];
  }

  const body = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    created_at: number;
  };

  if (!body.access_token) {
    return [null, null, new Response("Missing access token in response", { status: 500 })];
  }

  return [body.access_token, body.refresh_token, null];
}

/**
 * Fetch user identity from FreshBooks to get accountId and businessId.
 */
export async function fetchFreshBooksIdentity(accessToken: string): Promise<{
  userId: string;
  accountId: string;
  businessId: string;
} | null> {
  const response = await fetch("https://api.freshbooks.com/auth/api/v1/users/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    console.error("Failed to fetch FreshBooks identity:", response.status);
    return null;
  }

  const data = (await response.json()) as {
    response: {
      result: {
        id: number;
        first_name?: string;
        last_name?: string;
        email?: string;
        business_memberships?: Array<{
          business: {
            id: number;
            account_id: string;
          };
        }>;
      };
    };
  };

  const user = data.response?.result;
  if (!user) return null;

  const membership = user.business_memberships?.[0];
  if (!membership) {
    console.error("No business memberships found for user");
    return null;
  }

  return {
    userId: String(user.id),
    accountId: membership.business.account_id,
    businessId: String(membership.business.id),
  };
}
