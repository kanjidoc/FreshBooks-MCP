import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { listInvoices, getInvoice, createInvoice, updateInvoice } from "./tools/invoices";
import { listClients, getClient, createClient, updateClient } from "./tools/clients";
import { listExpenses, getExpense, createExpense } from "./tools/expenses";
import { listPayments, getPayment, createPayment } from "./tools/payments";
import { listTimeEntries, getTimeEntry, createTimeEntry } from "./tools/time-entries";

export const freshbooksServer = createSdkMcpServer({
  name: "freshbooks",
  version: "1.0.0",
  tools: [
    // Invoices
    listInvoices,
    getInvoice,
    createInvoice,
    updateInvoice,
    // Clients
    listClients,
    getClient,
    createClient,
    updateClient,
    // Expenses
    listExpenses,
    getExpense,
    createExpense,
    // Payments
    listPayments,
    getPayment,
    createPayment,
    // Time entries
    listTimeEntries,
    getTimeEntry,
    createTimeEntry,
  ],
});
