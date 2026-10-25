import { InvalidFinanceInputError } from "./text";

export const CATEGORY_KINDS = ["income", "expense"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export function parseCategoryKind(value: unknown): CategoryKind {
  if (!(CATEGORY_KINDS as readonly unknown[]).includes(value)) {
    throw new InvalidFinanceInputError("Choose income or expense");
  }
  return value as CategoryKind;
}

export interface CategoryRef {
  readonly id: string;
  readonly name: string;
  readonly kind: CategoryKind;
  readonly archived: boolean;
}

/** Created for an owner the first time they record a transaction. Editable afterwards. */
export const DEFAULT_CATEGORIES: readonly { readonly name: string; readonly kind: CategoryKind }[] = [
  { name: "Salary", kind: "income" },
  { name: "Interest", kind: "income" },
  { name: "Other income", kind: "income" },
  { name: "Groceries", kind: "expense" },
  { name: "Rent", kind: "expense" },
  { name: "Utilities", kind: "expense" },
  { name: "Transport", kind: "expense" },
  { name: "Dining out", kind: "expense" },
  { name: "Health", kind: "expense" },
  { name: "Shopping", kind: "expense" },
  { name: "Other expense", kind: "expense" },
];
