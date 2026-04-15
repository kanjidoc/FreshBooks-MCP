import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { FreshBooksApiClient } from "./freshbooks-api/client";
import type { Env, Props } from "./types";
import { registerInvoiceTools } from "./tools/invoices";
import { registerClientTools } from "./tools/clients";
import { registerExpenseTools } from "./tools/expenses";
import { registerPaymentTools } from "./tools/payments";
import { registerItemTools } from "./tools/items";
import { registerTimeEntryTools } from "./tools/time-entries";
import { registerProjectTools } from "./tools/projects";
import { registerReportTools } from "./tools/reports";
import { registerBillTools } from "./tools/bills";
import { registerBillPaymentTools } from "./tools/bill-payments";
import { registerBillVendorTools } from "./tools/bill-vendors";
import { registerCreditNoteTools } from "./tools/credit-notes";
import { registerOtherIncomeTools } from "./tools/other-incomes";
import { registerServiceTools } from "./tools/services";
import { registerTaskTools } from "./tools/tasks";
import { registerExpenseCategoryTools } from "./tools/expense-categories";
import { registerJournalEntryTools } from "./tools/journal-entries";

export class FreshBooksMcpAgent extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "FreshBooks",
    version: "2.0.0",
  });

  async init() {
    if (!this.props) {
      // User hasn't completed OAuth yet
      this.server.tool(
        "freshbooks_status",
        "Check FreshBooks connection status",
        {},
        async () => ({
          content: [
            {
              type: "text",
              text: "Not connected to FreshBooks. Please complete the OAuth authorization flow first.",
            },
          ],
          isError: true,
        })
      );
      return;
    }

    const api = new FreshBooksApiClient({
      accessToken: this.props.accessToken,
      refreshToken: this.props.refreshToken,
      accountId: this.props.accountId,
      businessId: this.props.businessId,
      userId: this.props.userId,
      env: this.env,
    });

    // Register all 74 tools across 17 resource domains
    registerInvoiceTools(this.server, api);
    registerClientTools(this.server, api);
    registerExpenseTools(this.server, api);
    registerPaymentTools(this.server, api);
    registerItemTools(this.server, api);
    registerTimeEntryTools(this.server, api);
    registerProjectTools(this.server, api);
    registerReportTools(this.server, api);
    registerBillTools(this.server, api);
    registerBillPaymentTools(this.server, api);
    registerBillVendorTools(this.server, api);
    registerCreditNoteTools(this.server, api);
    registerOtherIncomeTools(this.server, api);
    registerServiceTools(this.server, api);
    registerTaskTools(this.server, api);
    registerExpenseCategoryTools(this.server, api);
    registerJournalEntryTools(this.server, api);
  }
}
