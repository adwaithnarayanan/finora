import "server-only";

import { withFinanceStores } from "@/server/db";

import { createFinanceService } from "./service";

export { FinanceConflictError, FinanceNotFoundError } from "./errors";
export type {
  AccountDetail,
  AccountSummary,
  FinanceService,
  PurchaseRefunds,
  RefundablePurchase,
  Replayable,
} from "./service";
export type {
  CategoryRecord,
  FinancialAccountRecord,
  TransactionFilters,
  TransactionRecord,
} from "./store";

export const finance = createFinanceService(withFinanceStores);
