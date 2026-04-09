import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
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

export const freshbooksServer = createSdkMcpServer({
  name: "freshbooks",
  version: "1.0.0",
  tools: [
    // Invoices
    listInvoices,
    getInvoice,
    createInvoice,
    updateInvoice,
    deleteInvoice,
    // Clients
    listClients,
    getClient,
    createClient,
    updateClient,
    deleteClient,
    // Expenses
    listExpenses,
    getExpense,
    createExpense,
    updateExpense,
    deleteExpense,
    // Payments
    listPayments,
    getPayment,
    createPayment,
    updatePayment,
    deletePayment,
    // Time entries
    listTimeEntries,
    getTimeEntry,
    createTimeEntry,
    updateTimeEntry,
    deleteTimeEntry,
    // Items
    listItems,
    getItem,
    createItem,
    updateItem,
    // Other incomes
    listOtherIncomes,
    getOtherIncome,
    createOtherIncome,
    updateOtherIncome,
    deleteOtherIncome,
    // Bills
    listBills,
    getBill,
    createBill,
    deleteBill,
    // Bill payments
    listBillPayments,
    getBillPayment,
    createBillPayment,
    updateBillPayment,
    deleteBillPayment,
    // Bill vendors
    listBillVendors,
    getBillVendor,
    createBillVendor,
    updateBillVendor,
    deleteBillVendor,
    // Credit notes
    listCreditNotes,
    getCreditNote,
    createCreditNote,
    updateCreditNote,
    deleteCreditNote,
    // Projects
    listProjects,
    getProject,
    createProject,
    updateProject,
    deleteProject,
    // Services
    listServices,
    getService,
    createService,
    // Reports
    reportPaymentsCollected,
    reportProfitLoss,
    reportTaxSummary,
    // Tasks
    listTasks,
    getTask,
    createTask,
    updateTask,
    deleteTask,
    // Expense categories (read-only)
    listExpenseCategories,
    getExpenseCategory,
    // Journal entries
    createJournalEntry,
    listJournalEntryAccounts,
    listJournalEntryDetails,
  ],
});
