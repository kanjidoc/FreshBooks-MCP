import { Client } from "@freshbooks/api";

let fbClient: Client | null = null;

export function getFreshBooksClient(): Client {
  if (!fbClient) {
    const clientId = process.env.FRESHBOOKS_CLIENT_ID;
    if (!clientId) {
      throw new Error("FRESHBOOKS_CLIENT_ID is not set");
    }

    fbClient = new Client(clientId, {
      accessToken: process.env.FRESHBOOKS_ACCESS_TOKEN,
      refreshToken: process.env.FRESHBOOKS_REFRESH_TOKEN,
      clientSecret: process.env.FRESHBOOKS_CLIENT_SECRET,
      redirectUri: process.env.FRESHBOOKS_REDIRECT_URI,
    });
  }
  return fbClient;
}

export function getAccountId(): string {
  const accountId = process.env.FRESHBOOKS_ACCOUNT_ID;
  if (!accountId) {
    throw new Error("FRESHBOOKS_ACCOUNT_ID is not set");
  }
  return accountId;
}

export function getBusinessId(): number {
  const businessId = process.env.FRESHBOOKS_BUSINESS_ID;
  if (!businessId) {
    throw new Error("FRESHBOOKS_BUSINESS_ID is not set");
  }
  return parseInt(businessId, 10);
}
