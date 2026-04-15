/**
 * FreshBooks OAuth handler for the MCP server.
 * Adapted from the Cloudflare GitHub OAuth MCP example.
 *
 * Handles the OAuth dance between:
 *   MCP Client → this Worker (as OAuth server) → FreshBooks (upstream OAuth provider)
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import {
  fetchUpstreamAuthToken,
  getUpstreamAuthorizeUrl,
  fetchFreshBooksIdentity,
  type Props,
} from "./utils";
import {
  addApprovedClient,
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from "./workers-oauth-utils";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

/**
 * GET /authorize — Start the OAuth flow.
 * If the client is already approved, skip the dialog and redirect to FreshBooks.
 */
app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;
  if (!clientId) {
    return c.text("Invalid request", 400);
  }

  // Check if this MCP client is already approved by this browser
  if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
    const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
    return redirectToFreshBooks(c.req.raw, stateToken, c.env.FRESHBOOKS_CLIENT_ID, {
      "Set-Cookie": sessionBindingCookie,
    });
  }

  // Show approval dialog
  const { token: csrfToken, setCookie } = generateCSRFProtection();
  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
    csrfToken,
    server: {
      name: "FreshBooks MCP Server",
      description:
        "Connect your FreshBooks account to manage invoices, clients, expenses, and more through AI assistants.",
      logo: "https://www.freshbooks.com/wp-content/uploads/2021/01/fb-icon.svg",
    },
    setCookie,
    state: { oauthReqInfo },
  });
});

/**
 * POST /authorize — Handle the approval form submission.
 */
app.post("/authorize", async (c) => {
  try {
    const formData = await c.req.raw.formData();

    validateCSRFToken(formData, c.req.raw);

    const encodedState = formData.get("state");
    if (!encodedState || typeof encodedState !== "string") {
      return c.text("Missing state in form data", 400);
    }

    let state: { oauthReqInfo?: AuthRequest };
    try {
      state = JSON.parse(atob(encodedState));
    } catch {
      return c.text("Invalid state data", 400);
    }

    if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
      return c.text("Invalid request", 400);
    }

    const approvedClientCookie = await addApprovedClient(
      c.req.raw,
      state.oauthReqInfo.clientId,
      c.env.COOKIE_ENCRYPTION_KEY
    );

    const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

    const headers = new Headers();
    headers.append("Set-Cookie", approvedClientCookie);
    headers.append("Set-Cookie", sessionBindingCookie);

    return redirectToFreshBooks(
      c.req.raw,
      stateToken,
      c.env.FRESHBOOKS_CLIENT_ID,
      Object.fromEntries(headers)
    );
  } catch (error: any) {
    console.error("POST /authorize error:", error);
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    return c.text(`Internal server error: ${error.message}`, 500);
  }
});

/**
 * Redirect the user's browser to FreshBooks OAuth authorization.
 */
function redirectToFreshBooks(
  request: Request,
  stateToken: string,
  freshbooksClientId: string,
  headers: Record<string, string> = {}
): Response {
  return new Response(null, {
    status: 302,
    headers: {
      ...headers,
      location: getUpstreamAuthorizeUrl({
        client_id: freshbooksClientId,
        redirect_uri: new URL("/callback", request.url).href,
        state: stateToken,
      }),
    },
  });
}

/**
 * GET /callback — FreshBooks redirects here after user authorization.
 *
 * 1. Validate state (CSRF protection)
 * 2. Exchange auth code for FreshBooks tokens
 * 3. Fetch user identity (accountId, businessId)
 * 4. Store refresh token in KV
 * 5. Complete the MCP OAuth flow
 */
app.get("/callback", async (c) => {
  // Validate OAuth state with session binding
  let oauthReqInfo: AuthRequest;
  let clearSessionCookie: string;

  try {
    const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
    oauthReqInfo = result.oauthReqInfo;
    clearSessionCookie = result.clearCookie;
  } catch (error: any) {
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    return c.text("Internal server error", 500);
  }

  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request data", 400);
  }

  // Exchange the authorization code for FreshBooks tokens
  const [accessToken, refreshToken, errResponse] = await fetchUpstreamAuthToken({
    client_id: c.env.FRESHBOOKS_CLIENT_ID,
    client_secret: c.env.FRESHBOOKS_CLIENT_SECRET,
    code: c.req.query("code"),
    redirect_uri: new URL("/callback", c.req.url).href,
  });
  if (errResponse) return errResponse;

  // Fetch user identity to get accountId and businessId
  const identity = await fetchFreshBooksIdentity(accessToken);
  if (!identity) {
    return c.text("Failed to retrieve FreshBooks account information", 500);
  }

  // Store refresh token in KV for later token refresh
  await c.env.OAUTH_KV.put(
    `fb_tokens:${identity.userId}`,
    JSON.stringify({
      accessToken,
      refreshToken,
      expiresAt: Date.now() + 43200 * 1000, // FreshBooks tokens expire in ~12 hours
    }),
    { expirationTtl: 60 * 60 * 24 * 30 } // 30 day TTL
  );

  // Complete the MCP OAuth flow — this issues the MCP-facing token
  // with our props encrypted inside it
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: identity.userId,
    metadata: {
      label: `FreshBooks (${identity.accountId})`,
    },
    scope: oauthReqInfo.scope,
    props: {
      userId: identity.userId,
      accessToken,
      refreshToken,
      accountId: identity.accountId,
      businessId: identity.businessId,
    } as Props,
  });

  // Clear the session binding cookie
  const headers = new Headers({ Location: redirectTo });
  if (clearSessionCookie) {
    headers.set("Set-Cookie", clearSessionCookie);
  }

  return new Response(null, { status: 302, headers });
});

/**
 * GET / — Landing page
 */
app.get("/", (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html>
    <head><title>FreshBooks MCP Server</title></head>
    <body style="font-family: system-ui; max-width: 600px; margin: 60px auto; padding: 0 20px;">
      <h1>FreshBooks MCP Server</h1>
      <p>This is a <a href="https://modelcontextprotocol.io">Model Context Protocol</a> server
         that connects AI assistants to your <a href="https://www.freshbooks.com">FreshBooks</a> account.</p>
      <p>To use this server, add it as an MCP server in your AI assistant (Claude, Cursor, etc.)
         using the URL: <code>${new URL("/mcp", c.req.url).href}</code></p>
      <p>73 tools covering invoices, clients, expenses, payments, time entries, bills, credit notes,
         items, projects, services, tasks, journal entries, and reports.</p>
      <hr>
      <p><small><a href="https://github.com/kanjidoc/FreshBooks-MCP">GitHub</a></small></p>
    </body>
    </html>
  `);
});

export { app as FreshBooksHandler };
