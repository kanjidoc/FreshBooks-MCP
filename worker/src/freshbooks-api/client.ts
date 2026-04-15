import type { Env } from "../types";

export interface FreshBooksClientOptions {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  businessId: string;
  userId: string;
  env: Env;
}

export interface FreshBooksError {
  errno: number;
  field?: string;
  message: string;
  object?: string;
  value?: string;
}

/**
 * fetch()-based FreshBooks API client that replaces @freshbooks/api SDK.
 * Handles authentication, response envelope unwrapping, and token refresh.
 */
export class FreshBooksApiClient {
  private accessToken: string;
  private refreshToken: string;
  readonly accountId: string;
  readonly businessId: string;
  private readonly userId: string;
  private readonly env: Env;

  constructor(options: FreshBooksClientOptions) {
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    this.accountId = options.accountId;
    this.businessId = options.businessId;
    this.userId = options.userId;
    this.env = options.env;
  }

  /** Build URL for accounting endpoints (invoices, clients, expenses, etc.) */
  accountingUrl(path: string): string {
    return `https://api.freshbooks.com/accounting/account/${this.accountId}/${path}`;
  }

  /** Build URL for project endpoints (projects, time_entries) */
  projectUrl(path: string): string {
    return `https://api.freshbooks.com/projects/business/${this.businessId}/${path}`;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
      "Api-Version": "alpha",
    };
  }

  /**
   * Make an authenticated GET request.
   * @param url Full URL (use accountingUrl/projectUrl to build it)
   * @param queryString Optional query string (from buildQueryParams)
   */
  async get(url: string, queryString?: string): Promise<any> {
    const fullUrl = queryString ? `${url}?${queryString}` : url;
    return this.request("GET", fullUrl);
  }

  /** Make an authenticated POST request with a JSON body. */
  async post(url: string, body: Record<string, unknown>): Promise<any> {
    return this.request("POST", url, body);
  }

  /** Make an authenticated PUT request with a JSON body. */
  async put(url: string, body: Record<string, unknown>): Promise<any> {
    return this.request("PUT", url, body);
  }

  /** Make an authenticated DELETE request. */
  async delete(url: string): Promise<any> {
    return this.request("DELETE", url);
  }

  private async request(
    method: string,
    url: string,
    body?: Record<string, unknown>,
    isRetry = false
  ): Promise<any> {
    const options: RequestInit = {
      method,
      headers: this.headers(),
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    // Handle token expiry — refresh and retry once
    if (response.status === 401 && !isRetry) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        return this.request(method, url, body, true);
      }
    }

    if (!response.ok) {
      const errorBody = await response.text();
      let errorMessage: string;
      try {
        const parsed = JSON.parse(errorBody);
        // Accounting error format: { response: { errors: [...] } }
        const errors = parsed?.response?.errors ?? parsed?.errors ?? [];
        if (errors.length > 0) {
          errorMessage = errors.map((e: FreshBooksError) => e.message).join("; ");
        } else {
          errorMessage = parsed?.message ?? parsed?.error_description ?? errorBody;
        }
      } catch {
        errorMessage = errorBody;
      }
      throw new Error(`FreshBooks API error (${response.status}): ${errorMessage}`);
    }

    const json = await response.json() as any;

    // Unwrap the response envelope.
    // Accounting endpoints: { response: { result: { ... } } }
    // Project endpoints: { ... } (no envelope, or different structure)
    if (json.response?.result !== undefined) {
      return json.response.result;
    }
    // Some project endpoints return data directly
    return json;
  }

  /**
   * Refresh the FreshBooks access token using the refresh token.
   * FreshBooks refresh tokens are single-use — the new one must be stored.
   */
  private async refreshAccessToken(): Promise<boolean> {
    try {
      // Read latest refresh token from KV (may have been updated by another request)
      const stored = await this.env.OAUTH_KV.get(`fb_tokens:${this.userId}`, "json") as {
        refreshToken: string;
      } | null;
      const currentRefreshToken = stored?.refreshToken ?? this.refreshToken;

      const response = await fetch("https://api.freshbooks.com/auth/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: this.env.FRESHBOOKS_CLIENT_ID,
          client_secret: this.env.FRESHBOOKS_CLIENT_SECRET,
          refresh_token: currentRefreshToken,
        }),
      });

      if (!response.ok) {
        console.error("Token refresh failed:", response.status, await response.text());
        return false;
      }

      const tokens = (await response.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        token_type: string;
      };

      // Update in-memory tokens
      this.accessToken = tokens.access_token;
      this.refreshToken = tokens.refresh_token;

      // Persist the new refresh token to KV (single-use, must store it)
      await this.env.OAUTH_KV.put(
        `fb_tokens:${this.userId}`,
        JSON.stringify({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + tokens.expires_in * 1000,
        }),
        { expirationTtl: 60 * 60 * 24 * 30 } // 30 days
      );

      return true;
    } catch (err) {
      console.error("Token refresh error:", err);
      return false;
    }
  }
}
