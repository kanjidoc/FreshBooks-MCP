import { withAccount, withoutAccount } from "./tools/with-refresh";
import { listAccounts } from "./tools/accounts";
import { listInvoices, getInvoice, createInvoice, updateInvoice, deleteInvoice } from "./tools/invoices";
import { listClients, getClient, createClient, updateClient, deleteClient } from "./tools/clients";
import { listExpenses, getExpense, createExpense, updateExpense, deleteExpense } from "./tools/expenses";
import { listPayments, getPayment, createPayment, updatePayment, deletePayment } from "./tools/payments";
import { listTimeEntries, getTimeEntry, createTimeEntry, updateTimeEntry, deleteTimeEntry } from "./tools/time-entries";
import { listItems, getItem, createItem, updateItem } from "./tools/items";
import { listOtherIncomes, getOtherIncome, createOtherIncome, updateOtherIncome, deleteOtherIncome } from "./tools/other-incomes";
import { listBills, getBill, createBill, deleteBill } from "./tools/bills";
import { listBillPayments, getBillPayment, createBillPayment, updateBillPayment, deleteBillPayment } from "./tools/bill-payments";
import { listBillVendors, getBillVendor, createBillVendor, updateBillVendor, deleteBillVendor } from "./tools/bill-vendors";
import { listCreditNotes, getCreditNote, createCreditNote, updateCreditNote, deleteCreditNote } from "./tools/credit-notes";
import { listProjects, getProject, createProject, updateProject, deleteProject } from "./tools/projects";
import { listServices, getService, createService } from "./tools/services";
import { reportPaymentsCollected, reportProfitLoss, reportTaxSummary } from "./tools/reports";
import { listTasks, getTask, createTask, updateTask, deleteTask } from "./tools/tasks";
import { listExpenseCategories, getExpenseCategory } from "./tools/expense-categories";
import { createJournalEntry, listJournalEntryAccounts, listJournalEntryDetails } from "./tools/journal-entries";
import {
  reportBalanceSheet,
  reportGeneralLedger,
  reportCashFlow,
  reportAccountsAging,
  reportExpenseDetails,
  reportTrialBalance,
} from "./tools/raw/reports";
import { listEstimates, getEstimate } from "./tools/raw/estimates";
import { listStaff, getStaffMember } from "./tools/raw/staff";
import { listTaxes, getTax } from "./tools/raw/taxes";
import { listInvoiceProfiles, getInvoiceProfile } from "./tools/raw/invoice-profiles";
import { freshbooksHelp } from "./tools/help";

/**
 * Every FreshBooks MCP tool, in display order.
 *
 * The 74 API tools are wrapped with `withAccount`: each gains an injected
 * `account` field, resolves the named FreshBooks login ("profile"), refreshes
 * that profile's OAuth token if needed, and runs inside the profile's
 * AsyncLocalStorage context. The two account-free tools (`freshbooks_help` and
 * `freshbooks_list_accounts`) are wrapped with `withoutAccount` (identity — no
 * `account` field, no profile context). server.ts serves this list, and the
 * `freshbooks_help` tool introspects it to keep its tool inventory in sync.
 */
const accountScoped = [
  // Invoices
  listInvoices, getInvoice, createInvoice, updateInvoice, deleteInvoice,
  // Clients
  listClients, getClient, createClient, updateClient, deleteClient,
  // Expenses
  listExpenses, getExpense, createExpense, updateExpense, deleteExpense,
  // Payments
  listPayments, getPayment, createPayment, updatePayment, deletePayment,
  // Time entries
  listTimeEntries, getTimeEntry, createTimeEntry, updateTimeEntry, deleteTimeEntry,
  // Items
  listItems, getItem, createItem, updateItem,
  // Other incomes
  listOtherIncomes, getOtherIncome, createOtherIncome, updateOtherIncome, deleteOtherIncome,
  // Bills
  listBills, getBill, createBill, deleteBill,
  // Bill payments
  listBillPayments, getBillPayment, createBillPayment, updateBillPayment, deleteBillPayment,
  // Bill vendors
  listBillVendors, getBillVendor, createBillVendor, updateBillVendor, deleteBillVendor,
  // Credit notes
  listCreditNotes, getCreditNote, createCreditNote, updateCreditNote, deleteCreditNote,
  // Projects
  listProjects, getProject, createProject, updateProject, deleteProject,
  // Services
  listServices, getService, createService,
  // Reports (SDK-backed)
  reportPaymentsCollected, reportProfitLoss, reportTaxSummary,
  // Reports (raw-backed — src/tools/raw/, direct API access via src/raw-call.ts)
  reportBalanceSheet, reportGeneralLedger, reportCashFlow,
  reportAccountsAging, reportExpenseDetails, reportTrialBalance,
  // Estimates (raw-backed)
  listEstimates, getEstimate,
  // Staff (raw-backed, read-only by decision — create_staff emails a real human)
  listStaff, getStaffMember,
  // Taxes (raw-backed)
  listTaxes, getTax,
  // Invoice profiles (raw-backed; writes gated — can auto-generate real invoices)
  listInvoiceProfiles, getInvoiceProfile,
  // Tasks
  listTasks, getTask, createTask, updateTask, deleteTask,
  // Expense categories (read-only)
  listExpenseCategories, getExpenseCategory,
  // Journal entries
  createJournalEntry, listJournalEntryAccounts, listJournalEntryDetails,
].map(withAccount);

// Account-free tools: no injected `account` field, no profile context.
const accountFree = [freshbooksHelp, listAccounts].map(withoutAccount);

export const allTools = [...accountScoped, ...accountFree];
