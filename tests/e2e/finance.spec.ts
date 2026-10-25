import { type Locator, type Page, test as base, expect } from "@playwright/test";

import pg from "pg";

import { readLocalSupabase } from "../../scripts/lib/local-supabase.mjs";

import { type ProvisionedOwner, e2eUsers } from "./support/fixtures";
import { signIn } from "./support/login";
import { provisionTestOwner, removeTestUsers } from "./support/owners";

const users = e2eUsers();

/**
 * `owner` is a brand-new owner for one test attempt (a retry gets another),
 * provisioned through the real workflow and removed again when the test ends,
 * so no test depends on what another test, attempt or spec left behind.
 */
const test = base.extend<{ owner: ProvisionedOwner }>({
  owner: async ({}, provide) => {
    const owner = await provisionTestOwner("finance");
    try {
      await provide(owner);
    } finally {
      await removeTestUsers([owner]);
    }
  },
});

/** Selects the option whose visible text contains `text` (labels include balances). */
async function choose(select: Locator, text: string) {
  const value = await select.locator("option", { hasText: text }).first().getAttribute("value");
  await select.selectOption(value!);
}

/** Counts the owner's categories directly in the LOCAL database. */
async function categoryCount(ownerId: string): Promise<number> {
  const db = new pg.Client({ connectionString: readLocalSupabase().migrationDatabaseUrl.replace(/\?.*$/, "") });
  await db.connect();
  try {
    return (await db.query("SELECT count(*)::int AS n FROM finora.categories WHERE owner_id = $1", [ownerId])).rows[0].n;
  } finally {
    await db.end();
  }
}

/**
 * Adds the default categories through the owner-facing button (the supported,
 * explicit setup). The caller's owner is new, so it has none yet.
 */
async function addDefaultCategories(page: Page) {
  await page.goto("/categories");
  await page.getByRole("button", { name: "Add default categories" }).click();
  await expect(page.getByRole("region", { name: "Income categories" })).toContainText("Salary");
  await expect(page.getByRole("region", { name: "Expense categories" })).toContainText("Groceries");
}

const balanceOn = (page: Page) => page.getByText("Posted balance").locator("xpath=following-sibling::p[1]");

async function openAccount(page: Page, name: string) {
  await page.goto("/accounts?archived=1"); // include archived accounts
  await page.getByRole("link", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(name) })).toBeVisible();
}

async function record(page: Page, fill: (page: Page) => Promise<void>) {
  await page.goto("/transactions/new");
  await fill(page);
  await page.getByRole("button", { name: /^Record / }).click();
  await expect(page).toHaveURL(/\/transactions\?recorded=/);
  await expect(page.getByRole("status").filter({ hasText: "Transaction recorded." })).toBeVisible();
}

/** Creates an account through the form; lands on its page. */
async function createAccount(page: Page, name: string, opts: { type?: string; opening?: string; asOf?: string } = {}) {
  await page.goto("/accounts/new");
  await page.getByLabel("Account name").fill(name);
  if (opts.type) await page.getByLabel("Type").selectOption(opts.type);
  if (opts.opening) await page.getByLabel("Amount", { exact: true }).fill(opts.opening);
  if (opts.asOf) await page.getByLabel("As of").fill(opts.asOf);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(name) })).toBeVisible();
}

/** HDFC Savings (₹50,000 opening balance on 1 Oct 2026) and an empty cash Wallet. */
async function createSampleAccounts(page: Page) {
  await createAccount(page, "HDFC Savings", { opening: "50000", asOf: "2026-10-01" });
  await createAccount(page, "Wallet", { type: "cash" });
}

const sampleIncome = async (p: Page) => {
  await p.getByLabel(/^Income/).check();
  await choose(p.getByLabel("Received into", { exact: true }), "HDFC Savings");
  await p.getByLabel("Category", { exact: true }).selectOption({ label: "Salary" });
  await p.getByLabel("Amount", { exact: true }).fill("25000.50");
  await p.getByLabel("Date", { exact: true }).fill("2026-10-20");
  await p.getByLabel("Received from (optional)").fill("Acme Ltd");
};

const sampleExpense = async (p: Page) => {
  await expect(p.getByLabel(/^Expense/)).toBeChecked();
  await choose(p.getByLabel("Paid from", { exact: true }), "HDFC Savings");
  await p.getByLabel("Category", { exact: true }).selectOption({ label: "Groceries" });
  await p.getByLabel("Amount", { exact: true }).fill("1200");
  await p.getByLabel("Date", { exact: true }).fill("2026-10-21");
  await p.getByLabel("Paid to (optional)").fill("BigBasket");
  await p.getByLabel("Note (optional)").fill("Weekly shop");
};

const sampleTransfer = async (p: Page) => {
  await p.getByLabel(/^Transfer/).check();
  await choose(p.getByLabel("From account", { exact: true }), "HDFC Savings");
  await choose(p.getByLabel("To account", { exact: true }), "Wallet");
  await p.getByLabel("Amount", { exact: true }).fill("2000");
  await p.getByLabel("Date", { exact: true }).fill("2026-10-22");
};

/**
 * The history "record income, an expense and a transfer" builds, for tests
 * that start from it: HDFC Savings ₹71,800.50, Wallet ₹2,000.00.
 */
async function createSampleHistory(page: Page) {
  await createSampleAccounts(page);
  await addDefaultCategories(page);
  for (const fill of [sampleIncome, sampleExpense, sampleTransfer]) await record(page, fill);
}

test.describe("unauthorised access", () => {
  test("signed-out visitors are sent to sign-in from every finance page", async ({ page }) => {
    for (const path of ["/accounts", "/accounts/new", "/transactions", "/transactions/new", "/categories"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/login/);
    }
  });

  test("a signed-in non-owner is refused and sees no finance pages", async ({ page }) => {
    await signIn(page, users.stranger.email, users.stranger.password, "/login?next=%2Faccounts");
    await expect(page).toHaveURL(/\/unauthorized$/);
    await page.goto("/accounts");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Accounts" })).toHaveCount(0);
  });
});

test.describe("accounts and transactions (owner)", () => {
  // Each test sets up what it needs for its own new owner; none relies on another.
  test.beforeEach(async ({ page, owner }) => {
    await signIn(page, owner.email, owner.password);
    await expect(page).toHaveURL(/\/$/);
  });

  test("create a bank account with an opening balance, and a cash account", async ({ page }) => {
    await page.goto("/accounts");
    await expect(page.getByText("No accounts yet")).toBeVisible();
    await page.getByRole("link", { name: "Create your first account" }).click();

    await page.getByLabel("Account name").fill("HDFC Savings");
    await expect(page.getByLabel("Type")).toHaveValue("bank");
    await expect(page.getByLabel("Currency")).toHaveValue("INR");
    await expect(page.getByText(/not as income/)).toBeVisible();
    await page.getByLabel("Amount", { exact: true }).fill("50000");
    await page.getByLabel("As of").fill("2026-10-01");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByRole("heading", { level: 1, name: /HDFC Savings/ })).toBeVisible();
    await expect(balanceOn(page)).toHaveText("₹50,000.00");
    await expect(page.getByText("₹50,000.00 as of 1 Oct 2026")).toBeVisible();

    await page.goto("/accounts/new");
    await page.getByLabel("Account name").fill("Wallet");
    await page.getByLabel("Type").selectOption("cash");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(balanceOn(page)).toHaveText("₹0.00");
  });

  test("validation errors keep the input and save nothing", async ({ page }) => {
    await createAccount(page, "HDFC Savings");
    await page.goto("/accounts/new");
    await page.getByLabel("Account name").fill("hdfc savings");
    await page.getByLabel("Amount", { exact: true }).fill("12.345");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Use at most 2 decimal places for INR")).toBeVisible();
    await expect(page.getByLabel("Account name")).toHaveValue("hdfc savings");
    await page.getByLabel("Amount", { exact: true }).fill("10");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText("You already have an account with that name");
  });

  test("record income, an expense and a transfer", async ({ page }) => {
    await createSampleAccounts(page);
    await addDefaultCategories(page);
    await record(page, sampleIncome);
    await record(page, sampleExpense);
    await record(page, sampleTransfer);
  });

  test("a transfer needs two different accounts and a valid amount", async ({ page }) => {
    await createSampleAccounts(page);
    await page.goto("/transactions/new?type=transfer");
    const from = page.getByLabel("From account", { exact: true });
    await choose(from, "HDFC Savings");
    // The destination list excludes the source account.
    await expect(page.getByLabel("To account", { exact: true }).locator("option", { hasText: "HDFC Savings" })).toHaveCount(0);
    await choose(page.getByLabel("To account", { exact: true }), "Wallet");
    await page.getByLabel("Amount", { exact: true }).fill("1,000");
    await page.getByRole("button", { name: "Record transfer" }).click();
    await expect(page.getByText(/Enter an amount greater than zero/)).toBeVisible();
    await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("1,000");
  });

  test("balances and history reflect every transaction", async ({ page }) => {
    await createSampleHistory(page);
    await openAccount(page, "HDFC Savings");
    await expect(balanceOn(page)).toHaveText("₹71,800.50"); // 50,000 + 25,000.50 − 1,200 − 2,000
    await openAccount(page, "Wallet");
    await expect(balanceOn(page)).toHaveText("₹2,000.00");

    await page.goto("/transactions");
    const list = page.getByRole("list", { name: "Transactions" });
    await expect(list.getByRole("listitem")).toHaveCount(4);
    await expect(list).toContainText("Salary");
    await expect(list).toContainText("+₹25,000.50");
    await expect(list).toContainText("−₹1,200.00");
    await expect(list).toContainText("HDFC Savings → Wallet");
    await expect(list).toContainText("Opening balance");

    await page.getByLabel("Type").selectOption("expense");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list).toContainText("BigBasket");

    await page.goto("/transactions?q=bigbasket");
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await page.goto("/transactions?from=2026-10-21&to=2026-10-22");
    await expect(list.getByRole("listitem")).toHaveCount(2);
  });

  test("void an expense through a reversal; it stays in history", async ({ page }) => {
    await createSampleHistory(page);
    await page.goto("/transactions?type=expense");
    await page.getByRole("link", { name: /Groceries/ }).click();
    await page.getByRole("button", { name: "Void transaction" }).click();
    await expect(page.getByText(/Balances return to what they were/)).toBeFocused();
    await page.getByRole("button", { name: "Yes, void it" }).click();
    await expect(page.getByText("Void", { exact: true })).toBeVisible();
    await openAccount(page, "HDFC Savings");
    await expect(balanceOn(page)).toHaveText("₹73,000.50");
    await page.goto("/transactions");
    await expect(page.getByRole("list", { name: "Transactions" }).getByRole("listitem")).toHaveCount(4);
  });

  test("archive an account: no new transactions, history kept; then restore it", async ({ page }) => {
    await createSampleHistory(page);
    await openAccount(page, "Wallet");
    await expect(page.getByRole("button", { name: "Delete account" })).toHaveCount(0); // it has history
    await page.getByRole("button", { name: "Archive account" }).click();
    await page.getByRole("button", { name: "Yes, archive" }).click();
    await expect(page.getByText(/This account is archived/)).toBeVisible();
    await expect(balanceOn(page)).toHaveText("₹2,000.00");

    await page.goto("/transactions/new?type=transfer");
    await expect(page.getByLabel("From account", { exact: true }).locator("option", { hasText: "Wallet" })).toHaveCount(0);

    await openAccount(page, "Wallet");
    await page.getByRole("button", { name: "Restore account" }).click();
    await page.getByRole("button", { name: "Yes, restore" }).click();
    await expect(page.getByText(/This account is archived/)).toHaveCount(0);
  });

  test("an unused account can be deleted after confirmation", async ({ page }) => {
    await page.goto("/accounts/new");
    await page.getByLabel("Account name").fill("Typo account");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByRole("button", { name: "Delete account" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Delete account" }).click();
    await page.getByRole("button", { name: "Yes, delete permanently" }).click();
    await expect(page).toHaveURL(/\/accounts$/);
    await expect(page.getByRole("link", { name: /Typo account/ })).toHaveCount(0);
  });

  test("create a credit card with the amount owed; its type is fixed and it takes no transactions yet", async ({ page }) => {
    await page.goto("/accounts/new");
    await page.getByLabel("Account name").fill("HDFC Card");
    await page.getByLabel("Type").selectOption("credit_card");
    await expect(page.getByText(/An opening credit balance in your favour is not supported yet/)).toBeVisible();
    await expect(page.getByLabel("Amount", { exact: true })).toHaveCount(0);
    await page.getByLabel("Amount owed today").fill("12000");
    await page.getByLabel("As of").fill("2026-10-01");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByRole("heading", { level: 1, name: /HDFC Card/ })).toBeVisible();
    await expect(page.getByText("Credit card · INR")).toBeVisible();
    await expect(balanceOn(page)).toHaveText("Owed ₹12,000.00");
    await expect(page.getByText("Owed ₹12,000.00 as of 1 Oct 2026")).toBeVisible();
    await expect(page.getByText(/Card purchases and payments cannot be recorded yet/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Record transaction" })).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Transactions" })).toContainText("−₹12,000.00"); // owed: money out

    // The type cannot be changed; the name can.
    await expect(page.getByRole("combobox", { name: "Type" })).toHaveCount(0);
    await expect(page.locator('select[name="type"]:visible')).toHaveCount(0);
    await expect(page.getByText("A credit card's type cannot be changed.")).toBeVisible();
    await page.getByLabel("Account name").fill("HDFC Regalia");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    await page.getByText("Correct the opening balance").click();
    await page.getByLabel(/^Amount owed/).fill("11500");
    await page.getByRole("button", { name: "Correct opening balance" }).click();
    await expect(page.getByText("Owed ₹11,500.00 as of 1 Oct 2026")).toBeVisible();
    await expect(balanceOn(page)).toHaveText("Owed ₹11,500.00");

    await page.goto("/accounts");
    const listed = page.getByRole("link", { name: /^HDFC Regalia/ });
    await expect(listed).toContainText("Credit card · INR");
    await expect(listed).toContainText("Owed ₹11,500.00");

    // A card alone cannot take a transaction.
    await page.goto("/transactions/new");
    await expect(page.getByText("You need a bank or cash account first")).toBeVisible();
  });

  test("a card with nothing owed, a refused negative amount, and bank accounts kept out of the card type", async ({ page }) => {
    await page.goto("/accounts/new");
    await page.getByLabel("Account name").fill("Amex");
    await page.getByLabel("Type").selectOption("credit_card");
    await page.getByLabel("Currency").selectOption("USD");
    await page.getByLabel("Amount owed today").fill("-500");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Enter an amount greater than zero")).toBeVisible();
    // The refused input is kept, selects included.
    await expect(page.getByLabel("Type")).toHaveValue("credit_card");
    await expect(page.getByLabel("Currency")).toHaveValue("USD");
    await expect(page.getByLabel("Amount owed today")).toHaveValue("-500");
    await page.goto("/accounts");
    await expect(page.getByText("No accounts yet")).toBeVisible(); // nothing was saved

    await createAccount(page, "Amex", { type: "credit_card" });
    await expect(balanceOn(page)).toHaveText("Nothing owed (₹0.00)");
    await expect(page.getByLabel("Amount owed (INR)")).toBeVisible(); // the opening form, for a card

    // A bank account can switch to cash, but is never offered the card type.
    await createAccount(page, "Axis Savings", { opening: "50000", asOf: "2026-10-01" });
    await expect(page.getByLabel("Type").locator("option")).toHaveText(["Bank account", "Cash"]);
    await page.getByLabel("Type").selectOption("cash");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(balanceOn(page)).toHaveText("₹50,000.00");

    // Transaction pickers list bank and cash accounts only.
    await page.goto("/transactions/new?type=transfer");
    await expect(page.getByLabel("From account", { exact: true }).locator("option", { hasText: "Amex" })).toHaveCount(0);
  });

  test("correct the opening balance: original reversed, replacement recorded", async ({ page }) => {
    await createSampleHistory(page);
    await openAccount(page, "HDFC Savings");
    await expect(balanceOn(page)).toHaveText("₹71,800.50");
    await page.getByText("Correct the opening balance").click();
    await page.getByLabel(/^Opening balance/).fill("55000");
    await page.getByRole("button", { name: "Correct opening balance" }).click();
    await expect(page.getByText("₹55,000.00 as of 1 Oct 2026")).toBeVisible();
    await expect(balanceOn(page)).toHaveText("₹76,800.50"); // 71,800.50 + (55,000 − 50,000)
  });
});

test.describe("default categories (a brand-new owner)", () => {
  test.beforeEach(async ({ page, owner }) => {
    await signIn(page, owner.email, owner.password);
    await expect(page).toHaveURL(/\/$/);
  });

  test("viewing pages creates no categories; defaults are added only on request", async ({ page, owner }) => {
    expect(await categoryCount(owner.ownerId)).toBe(0);
    // An account, so /transactions/new shows the form (and the category notice).
    await page.goto("/accounts/new");
    await page.getByLabel("Account name").fill("Categories probe");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { level: 1, name: /Categories probe/ })).toBeVisible();

    for (const path of ["/", "/accounts", "/transactions"]) await page.goto(path);
    await page.goto("/transactions/new");
    const notice = page.getByRole("region", { name: "No categories yet" });
    await expect(notice).toContainText(/Add the default set/);
    await expect(notice.getByRole("link", { name: "Categories" })).toHaveAttribute("href", "/categories");
    await expect(page.getByLabel(/^Transfer/)).toBeChecked(); // the only kind that can be recorded yet
    await page.goto("/categories");
    await expect(page.getByText("No categories yet")).toBeVisible();
    await page.reload();
    expect(await categoryCount(owner.ownerId)).toBe(0);

    // The explicit action, from the transaction page: back to the form, now usable.
    await page.goto("/transactions/new");
    await notice.getByRole("button", { name: "Add default categories" }).click();
    await expect(page).toHaveURL(/\/transactions\/new$/);
    await expect(notice).toHaveCount(0);
    await expect(page.getByLabel(/^Expense/)).toBeChecked();
    await expect(page.getByLabel("Category", { exact: true }).locator("option", { hasText: "Groceries" })).toHaveCount(1);
    const created = await categoryCount(owner.ownerId);
    expect(created).toBeGreaterThan(0);

    await page.goto("/categories");
    await expect(page.getByRole("region", { name: "Income categories" })).toContainText("Salary");
    await expect(page.getByRole("button", { name: "Add default categories" })).toHaveCount(0);
    await page.goto("/transactions/new");
    expect(await categoryCount(owner.ownerId)).toBe(created);
  });
});
