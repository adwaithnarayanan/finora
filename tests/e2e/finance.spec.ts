import {
  type Locator,
  type Page,
  test as base,
  expect,
} from "@playwright/test";

import pg from "pg";

import { readLocalSupabase } from "../../scripts/lib/local-supabase.mjs";

import { type ProvisionedOwner, e2eUsers } from "./support/fixtures";
import { signIn } from "./support/login";
import { provisionTestOwner, removeTestUsers } from "./support/owners";

const users = e2eUsers();

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

async function choose(select: Locator, text: string) {
  const value = await select
    .locator("option", { hasText: text })
    .first()
    .getAttribute("value");
  await select.selectOption(value!);
}

async function categoryCount(ownerId: string): Promise<number> {
  const db = new pg.Client({
    connectionString: readLocalSupabase().migrationDatabaseUrl.replace(
      /\?.*$/,
      "",
    ),
  });
  await db.connect();
  try {
    return (
      await db.query(
        "SELECT count(*)::int AS n FROM finora.categories WHERE owner_id = $1",
        [ownerId],
      )
    ).rows[0].n;
  } finally {
    await db.end();
  }
}

async function addDefaultCategories(page: Page) {
  await page.goto("/categories");
  await page.getByRole("button", { name: "Add default categories" }).click();
  await expect(
    page.getByRole("region", { name: "Income categories" }),
  ).toContainText("Salary");
  await expect(
    page.getByRole("region", { name: "Expense categories" }),
  ).toContainText("Groceries");
}

const balanceOn = (page: Page) =>
  page.getByText("Posted balance").locator("xpath=following-sibling::p[1]");

const transactionForm = (page: Page) =>
  page
    .locator("form")
    .filter({ visible: true })
    .filter({ has: page.getByRole("group", { name: "Type" }) });

async function openAccount(page: Page, name: string) {
  await page.goto("/accounts?archived=1");
  await page.getByRole("link", { name: new RegExp(`^${name}`) }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: new RegExp(name) }),
  ).toBeVisible();
}

async function record(page: Page, fill: (page: Page) => Promise<void>) {
  await page.goto("/transactions/new");
  await fill(page);
  await page.getByRole("button", { name: /^Record / }).click();
  await expect(page).toHaveURL(/\/transactions\?recorded=/);
  await expect(
    page.getByRole("status").filter({ hasText: "Transaction recorded." }),
  ).toBeVisible();
}

async function createAccount(
  page: Page,
  name: string,
  opts: { type?: string; opening?: string; asOf?: string } = {},
) {
  await page.goto("/accounts/new");
  await page.getByLabel("Account name").fill(name);
  if (opts.type) await page.getByLabel("Type").selectOption(opts.type);
  if (opts.opening)
    await page.getByLabel("Amount", { exact: true }).fill(opts.opening);
  if (opts.asOf) await page.getByLabel("As of").fill(opts.asOf);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: new RegExp(name) }),
  ).toBeVisible();
}

async function createCreditCard(
  page: Page,
  name: string,
  opts: { owed: string; asOf: string },
) {
  await page.goto("/accounts/new");
  await page.getByLabel("Account name").fill(name);
  await page.getByLabel("Type").selectOption("credit_card");
  await page.getByLabel("Amount owed today").fill(opts.owed);
  await page.getByLabel("As of").fill(opts.asOf);
  await page.getByRole("button", { name: "Create account" }).click();
}

async function createSampleAccounts(page: Page) {
  await createAccount(page, "HDFC Savings", {
    opening: "50000",
    asOf: "2026-10-01",
  });
  await createAccount(page, "Wallet", { type: "cash" });
}

const sampleIncome = async (p: Page) => {
  await p.getByLabel(/^Income/).check();
  await choose(p.getByLabel("Received into", { exact: true }), "HDFC Savings");
  await p
    .getByLabel("Category", { exact: true })
    .selectOption({ label: "Salary" });
  await p.getByLabel("Amount", { exact: true }).fill("25000.50");
  await p.getByLabel("Date", { exact: true }).fill("2026-10-20");
  await p.getByLabel("Received from (optional)").fill("Acme Ltd");
};

const sampleExpense = async (p: Page) => {
  await expect(p.getByLabel(/^Expense/)).toBeChecked();
  await choose(p.getByLabel("Paid from", { exact: true }), "HDFC Savings");
  await p
    .getByLabel("Category", { exact: true })
    .selectOption({ label: "Groceries" });
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

async function createSampleHistory(page: Page) {
  await createSampleAccounts(page);
  await addDefaultCategories(page);
  for (const fill of [sampleIncome, sampleExpense, sampleTransfer])
    await record(page, fill);
}

test.describe("unauthorised access", () => {
  test("signed-out visitors are sent to sign-in from every finance page", async ({
    page,
  }) => {
    for (const path of [
      "/accounts",
      "/accounts/new",
      "/transactions",
      "/transactions/new",
      "/categories",
    ]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/login/);
    }
  });

  test("a signed-in non-owner is refused and sees no finance pages", async ({
    page,
  }) => {
    await signIn(
      page,
      users.stranger.email,
      users.stranger.password,
      "/login?next=%2Faccounts",
    );
    await expect(page).toHaveURL(/\/unauthorized$/);
    await page.goto("/accounts");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Accounts" })).toHaveCount(
      0,
    );
  });
});

test.describe("accounts and transactions (owner)", () => {
  test.beforeEach(async ({ page, owner }) => {
    await signIn(page, owner.email, owner.password);
    await expect(page).toHaveURL(/\/$/);
  });

  test("create a bank account with an opening balance, and a cash account", async ({
    page,
  }) => {
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

    await expect(
      page.getByRole("heading", { level: 1, name: /HDFC Savings/ }),
    ).toBeVisible();
    await expect(balanceOn(page)).toHaveText("₹50,000.00");
    await expect(page.getByText("₹50,000.00 as of 1 Oct 2026")).toBeVisible();

    await page.goto("/accounts/new");
    await page.getByLabel("Account name").fill("Wallet");
    await page.getByLabel("Type").selectOption("cash");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(balanceOn(page)).toHaveText("₹0.00");
  });

  test("validation errors keep the input and save nothing", async ({
    page,
  }) => {
    await createAccount(page, "HDFC Savings");
    await page.goto("/accounts/new");
    await page.getByLabel("Account name").fill("hdfc savings");
    await page.getByLabel("Amount", { exact: true }).fill("12.345");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByText("Use at most 2 decimal places for INR"),
    ).toBeVisible();
    await expect(page.getByLabel("Account name")).toHaveValue("hdfc savings");
    await page.getByLabel("Amount", { exact: true }).fill("10");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText(
      "You already have an account with that name",
    );
  });

  test("record income, an expense and a transfer", async ({ page }) => {
    await createSampleAccounts(page);
    await addDefaultCategories(page);
    await record(page, sampleIncome);
    await record(page, sampleExpense);
    await record(page, sampleTransfer);
  });

  test("a transfer needs two different accounts and a valid amount", async ({
    page,
  }) => {
    await createSampleAccounts(page);
    await page.goto("/transactions/new?type=transfer");
    const from = page.getByLabel("From account", { exact: true });
    await choose(from, "HDFC Savings");
    await expect(
      page
        .getByLabel("To account", { exact: true })
        .locator("option", { hasText: "HDFC Savings" }),
    ).toHaveCount(0);
    await choose(page.getByLabel("To account", { exact: true }), "Wallet");
    await page.getByLabel("Amount", { exact: true }).fill("1,000");
    await page.getByRole("button", { name: "Record transfer" }).click();
    await expect(
      page.getByText(/Enter an amount greater than zero/),
    ).toBeVisible();
    await expect(page.getByLabel("Amount", { exact: true })).toHaveValue(
      "1,000",
    );
  });

  test("balances and history reflect every transaction", async ({ page }) => {
    await createSampleHistory(page);
    await openAccount(page, "HDFC Savings");
    await expect(balanceOn(page)).toHaveText("₹71,800.50");
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

  test("void an expense through a reversal; it stays in history", async ({
    page,
  }) => {
    await createSampleHistory(page);
    await page.goto("/transactions?type=expense");
    await page.getByRole("link", { name: /Groceries/ }).click();
    await page.getByRole("button", { name: "Void transaction" }).click();
    await expect(
      page.getByText(/Balances return to what they were/),
    ).toBeFocused();
    await page.getByRole("button", { name: "Yes, void it" }).click();
    await expect(page.getByText("Void", { exact: true })).toBeVisible();
    await openAccount(page, "HDFC Savings");
    await expect(balanceOn(page)).toHaveText("₹73,000.50");
    await page.goto("/transactions");
    await expect(
      page.getByRole("list", { name: "Transactions" }).getByRole("listitem"),
    ).toHaveCount(4);
  });

  test("archive an account: no new transactions, history kept; then restore it", async ({
    page,
  }) => {
    await createSampleHistory(page);
    await openAccount(page, "Wallet");
    await expect(
      page.getByRole("button", { name: "Delete account" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Archive account" }).click();
    await page.getByRole("button", { name: "Yes, archive" }).click();
    await expect(page.getByText(/This account is archived/)).toBeVisible();
    await expect(balanceOn(page)).toHaveText("₹2,000.00");

    await page.goto("/transactions/new?type=transfer");
    await expect(
      page
        .getByLabel("From account", { exact: true })
        .locator("option", { hasText: "Wallet" }),
    ).toHaveCount(0);

    await openAccount(page, "Wallet");
    await page.getByRole("button", { name: "Restore account" }).click();
    await page.getByRole("button", { name: "Yes, restore" }).click();
    await expect(page.getByText(/This account is archived/)).toHaveCount(0);
  });

  test("an unused account can be deleted after confirmation", async ({
    page,
  }) => {
    await page.goto("/accounts/new");
    await page.getByLabel("Account name").fill("Typo account");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByRole("button", { name: "Delete account" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Delete account" }).click();
    await page.getByRole("button", { name: "Yes, delete permanently" }).click();
    await expect(page).toHaveURL(/\/accounts$/);
    await expect(page.getByRole("link", { name: /Typo account/ })).toHaveCount(
      0,
    );
  });

  test("create a credit card with the amount owed; its type is fixed", async ({
    page,
  }) => {
    await page.goto("/accounts/new");
    await page.getByLabel("Account name").fill("HDFC Card");
    await page.getByLabel("Type").selectOption("credit_card");
    await expect(
      page.getByText(
        /An opening credit balance in your favour is not supported yet/,
      ),
    ).toBeVisible();
    await expect(page.getByLabel("Amount", { exact: true })).toHaveCount(0);
    await page.getByLabel("Amount owed today").fill("12000");
    await page.getByLabel("As of").fill("2026-10-01");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(
      page.getByRole("heading", { level: 1, name: /HDFC Card/ }),
    ).toBeVisible();
    await expect(page.getByText("Credit card · INR")).toBeVisible();
    await expect(balanceOn(page)).toHaveText("Owed ₹12,000.00");
    await expect(
      page.getByText("Owed ₹12,000.00 as of 1 Oct 2026"),
    ).toBeVisible();
    await expect(
      page.getByText(/A repayment from a bank or cash account reduces it/),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Record card expense" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Record repayment" }),
    ).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Transactions" }),
    ).toContainText("−₹12,000.00");

    await expect(page.getByRole("combobox", { name: "Type" })).toHaveCount(0);
    await expect(page.locator('select[name="type"]:visible')).toHaveCount(0);
    await expect(
      page.getByText("A credit card's type cannot be changed."),
    ).toBeVisible();
    await page.getByLabel("Account name").fill("HDFC Regalia");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    await page.getByText("Correct the opening balance").click();
    await page.getByLabel(/^Amount owed/).fill("11500");
    await page.getByRole("button", { name: "Correct opening balance" }).click();
    await expect(
      page.getByText("Owed ₹11,500.00 as of 1 Oct 2026"),
    ).toBeVisible();
    await expect(balanceOn(page)).toHaveText("Owed ₹11,500.00");

    await page.goto("/accounts");
    const listed = page.getByRole("link", { name: /^HDFC Regalia/ });
    await expect(listed).toContainText("Credit card · INR");
    await expect(listed).toContainText("Owed ₹11,500.00");

    await page.goto("/transactions/new?type=income");
    await expect(
      page
        .getByLabel("Received into", { exact: true })
        .locator("option", { hasText: "HDFC Regalia" }),
    ).toHaveCount(0);
    await page.getByLabel(/^Expense/).check();
    await expect(
      page
        .getByLabel("Paid from", { exact: true })
        .locator("option", { hasText: "HDFC Regalia (Owed ₹11,500.00)" }),
    ).toHaveCount(1);
    await page.getByLabel(/^Card payment/).check();
    await expect(
      page
        .getByLabel("Card to pay", { exact: true })
        .locator("option", { hasText: "HDFC Regalia (Owed ₹11,500.00)" }),
    ).toHaveCount(1);
    await expect(
      page
        .getByLabel("Paid from", { exact: true })
        .locator("option", { hasText: "HDFC Regalia" }),
    ).toHaveCount(0);
  });

  test("a card with nothing owed, a refused negative amount, and bank accounts kept out of the card type", async ({
    page,
  }) => {
    await page.goto("/accounts/new");
    await page.getByLabel("Account name").fill("Amex");
    await page.getByLabel("Type").selectOption("credit_card");
    await page.getByLabel("Currency").selectOption("USD");
    await page.getByLabel("Amount owed today").fill("-500");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByText("Enter an amount greater than zero"),
    ).toBeVisible();
    await expect(page.getByLabel("Type")).toHaveValue("credit_card");
    await expect(page.getByLabel("Currency")).toHaveValue("USD");
    await expect(page.getByLabel("Amount owed today")).toHaveValue("-500");
    await page.goto("/accounts");
    await expect(page.getByText("No accounts yet")).toBeVisible();

    await createAccount(page, "Amex", { type: "credit_card" });
    await expect(balanceOn(page)).toHaveText("Nothing owed (₹0.00)");
    await expect(page.getByLabel("Amount owed (INR)")).toBeVisible();

    await createAccount(page, "Axis Savings", {
      opening: "50000",
      asOf: "2026-10-01",
    });
    await expect(page.getByLabel("Type").locator("option")).toHaveText([
      "Bank account",
      "Cash",
    ]);
    await page.getByLabel("Type").selectOption("cash");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(balanceOn(page)).toHaveText("₹50,000.00");

    await page.goto("/transactions/new?type=transfer");
    await expect(
      page
        .getByLabel("From account", { exact: true })
        .locator("option", { hasText: "Amex" }),
    ).toHaveCount(0);
    await expect(
      page
        .getByLabel("To account", { exact: true })
        .locator("option", { hasText: "Amex" }),
    ).toHaveCount(0);

    await page.goto("/transactions/new?type=card_payment");
    await expect(
      page
        .getByLabel("Paid from", { exact: true })
        .locator("option", { hasText: "Amex" }),
    ).toHaveCount(0);
    await expect(
      page
        .getByLabel("Paid from", { exact: true })
        .locator("option", { hasText: "Axis Savings" }),
    ).toHaveCount(1);
    await expect(
      page
        .getByLabel("Card to pay", { exact: true })
        .locator("option", { hasText: "Amex" }),
    ).toHaveCount(1);
    await expect(
      page
        .getByLabel("Card to pay", { exact: true })
        .locator("option", { hasText: "Axis Savings" }),
    ).toHaveCount(0);
  });

  test("record an expense paid by card: the amount owed grows and the card's history shows it", async ({
    page,
  }) => {
    await addDefaultCategories(page);
    await createAccount(page, "Axis Savings", {
      opening: "50000",
      asOf: "2026-10-01",
    });
    await createCreditCard(page, "HDFC Card", {
      owed: "12000",
      asOf: "2026-10-01",
    });
    await expect(balanceOn(page)).toHaveText("Owed ₹12,000.00");

    await page.getByRole("link", { name: "Record card expense" }).click();
    await expect(page).toHaveURL(/\/transactions\/new\?type=expense&account=/);
    const paidFrom = page.getByLabel("Paid from", { exact: true });
    await expect(paidFrom.locator("option:checked")).toHaveText(
      "HDFC Card (Owed ₹12,000.00)",
    );
    await expect(
      page.getByText(
        "Paid by credit card: adds to the amount owed on the card.",
      ),
    ).toBeVisible();
    const form = transactionForm(page);
    const amount = form.getByLabel("Amount", { exact: true });
    await expect(amount).toHaveCount(1);
    await page
      .getByLabel("Category", { exact: true })
      .selectOption({ label: "Shopping" });
    await amount.fill("1250.005");
    await page.getByLabel("Date", { exact: true }).fill("2026-10-24");
    await page.getByLabel("Paid to (optional)").fill("Bata");

    await page.getByRole("button", { name: "Record expense" }).click();
    await expect(
      page.getByText("Use at most 2 decimal places for INR"),
    ).toBeVisible();
    await expect(amount).toHaveValue("1250.005");
    await expect(page.getByLabel(/^Expense/)).toBeChecked();
    await expect(paidFrom.locator("option:checked")).toHaveText(
      "HDFC Card (Owed ₹12,000.00)",
    );
    await expect(
      page.getByLabel("Category", { exact: true }).locator("option:checked"),
    ).toHaveText("Shopping");
    await expect(page.getByLabel("Paid to (optional)")).toHaveValue("Bata");

    await amount.fill("1250");
    await page.getByRole("button", { name: "Record expense" }).click();
    await expect(page).toHaveURL(/\/transactions\?recorded=/);

    await openAccount(page, "HDFC Card");
    await expect(balanceOn(page)).toHaveText("Owed ₹13,250.00");
    const history = page.getByRole("list", { name: "Transactions" });
    await expect(history.getByRole("listitem")).toHaveCount(2);
    const purchase = history
      .getByRole("listitem")
      .filter({ hasText: "Shopping" });
    await expect(purchase).toContainText("24 Oct 2026");
    await expect(purchase).toContainText("HDFC Card");
    await expect(purchase).toContainText("Bata");
    await expect(purchase).toContainText("−₹1,250.00");

    await openAccount(page, "Axis Savings");
    await expect(balanceOn(page)).toHaveText("₹50,000.00");
    await page.goto("/transactions");
    await expect(
      page
        .getByRole("list", { name: "Transactions" })
        .getByRole("listitem")
        .filter({ hasText: "Bata" }),
    ).toContainText("HDFC Card");
  });

  test("record a repayment from a bank account to a credit card: the amount owed and the balance both fall", async ({
    page,
  }) => {
    await addDefaultCategories(page);
    await createAccount(page, "Axis Savings", {
      opening: "50000",
      asOf: "2026-10-01",
    });
    await createCreditCard(page, "HDFC Card", {
      owed: "12000",
      asOf: "2026-10-01",
    });
    await expect(balanceOn(page)).toHaveText("Owed ₹12,000.00");

    await page.getByRole("link", { name: "Record card expense" }).click();
    const expenseForm = transactionForm(page);
    await page
      .getByLabel("Category", { exact: true })
      .selectOption({ label: "Shopping" });
    await expenseForm.getByLabel("Amount", { exact: true }).fill("1250");
    await page.getByLabel("Date", { exact: true }).fill("2026-10-24");
    await page.getByLabel("Paid to (optional)").fill("Bata");
    await page.getByRole("button", { name: "Record expense" }).click();
    await expect(page).toHaveURL(/\/transactions\?recorded=/);

    await openAccount(page, "HDFC Card");
    await expect(balanceOn(page)).toHaveText("Owed ₹13,250.00");

    await page.getByRole("link", { name: "Record repayment" }).click();
    await expect(page).toHaveURL(
      /\/transactions\/new\?type=card_payment&account=/,
    );
    await expect(page.getByLabel(/^Card payment/)).toBeChecked();
    const cardToPay = page.getByLabel("Card to pay", { exact: true });
    await expect(cardToPay.locator("option:checked")).toHaveText(
      "HDFC Card (Owed ₹13,250.00)",
    );
    await expect(
      page.getByText(
        "The payment reduces the amount owed on this card. It is not an expense.",
      ),
    ).toBeVisible();
    await expect(page.getByLabel("Category", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel(/^Paid to/)).toHaveCount(0);

    const form = transactionForm(page);
    const amount = form.getByLabel("Amount", { exact: true });
    await expect(amount).toHaveCount(1);
    const paidFrom = page.getByLabel("Paid from", { exact: true });
    await expect(
      paidFrom.locator("option", { hasText: "HDFC Card" }),
    ).toHaveCount(0);
    await choose(paidFrom, "Axis Savings");
    await amount.fill("5000.005");
    await page.getByLabel("Date", { exact: true }).fill("2026-10-26");
    await page.getByLabel("Note (optional)").fill("Oct statement");

    await page.getByRole("button", { name: "Record card payment" }).click();
    await expect(
      page.getByText("Use at most 2 decimal places for INR"),
    ).toBeVisible();
    await expect(amount).toHaveValue("5000.005");
    await expect(page.getByLabel(/^Card payment/)).toBeChecked();
    await expect(cardToPay.locator("option:checked")).toHaveText(
      "HDFC Card (Owed ₹13,250.00)",
    );
    await expect(paidFrom.locator("option:checked")).toHaveText(
      /^Axis Savings/,
    );
    await expect(page.getByLabel("Note (optional)")).toHaveValue(
      "Oct statement",
    );
    await page.goto("/transactions");
    await expect(
      page.getByRole("list", { name: "Transactions" }).getByRole("listitem"),
    ).toHaveCount(3);

    await openAccount(page, "HDFC Card");
    await page.getByRole("link", { name: "Record repayment" }).click();
    await choose(page.getByLabel("Paid from", { exact: true }), "Axis Savings");
    await transactionForm(page)
      .getByLabel("Amount", { exact: true })
      .fill("5000");
    await page.getByLabel("Date", { exact: true }).fill("2026-10-26");
    await page.getByLabel("Note (optional)").fill("Oct statement");
    await page.getByRole("button", { name: "Record card payment" }).click();
    await expect(page).toHaveURL(/\/transactions\?recorded=/);

    await openAccount(page, "HDFC Card");
    await expect(balanceOn(page)).toHaveText("Owed ₹8,250.00");
    const cardHistory = page.getByRole("list", { name: "Transactions" });
    const repayment = cardHistory
      .getByRole("listitem")
      .filter({ hasText: "Card payment" });
    await expect(repayment).toContainText("26 Oct 2026");
    await expect(repayment).toContainText("Axis Savings → HDFC Card");
    await expect(repayment).toContainText("Oct statement");
    await expect(repayment).toContainText("+₹5,000.00");
    await expect(repayment.getByText("Expense", { exact: true })).toHaveCount(
      0,
    );

    await openAccount(page, "Axis Savings");
    await expect(balanceOn(page)).toHaveText("₹45,000.00");
    await expect(
      page
        .getByRole("list", { name: "Transactions" })
        .getByRole("listitem")
        .filter({ hasText: "Card payment" }),
    ).toContainText("−₹5,000.00");

    await page.goto("/transactions?type=expense");
    const expenses = page
      .getByRole("list", { name: "Transactions" })
      .getByRole("listitem");
    await expect(expenses).toHaveCount(1);
    await expect(expenses.first()).toContainText("Bata");
    await expect(expenses.first()).toContainText("−₹1,250.00");

    await page.goto("/transactions?type=card_payment");
    const payments = page
      .getByRole("list", { name: "Transactions" })
      .getByRole("listitem");
    await expect(payments).toHaveCount(1);
    await expect(payments.first()).toContainText("Axis Savings → HDFC Card");
    await expect(payments.first()).not.toContainText("+₹5,000.00");
    await expect(payments.first()).not.toContainText("−₹5,000.00");

    await payments.first().getByRole("link").click();
    await expect(page).toHaveURL(/\/transactions\/[0-9a-f-]+$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Axis Savings → HDFC Card" }),
    ).toBeVisible();
    await expect(page.getByText("Transactions / Card payment")).toBeVisible();
    await expect(page.getByText("Paid from", { exact: true })).toBeVisible();
    await expect(page.getByText("Card paid", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Payee", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Note", { exact: true })).toBeVisible();
  });

  test("pay a card more than is owed: it becomes a credit balance, and ordinary flows still work", async ({
    page,
  }) => {
    await createSampleHistory(page);
    await createAccount(page, "Amex", { type: "credit_card" });
    await expect(balanceOn(page)).toHaveText("Nothing owed (₹0.00)");

    await page.getByRole("link", { name: "Record repayment" }).click();
    await choose(page.getByLabel("Paid from", { exact: true }), "HDFC Savings");
    await transactionForm(page)
      .getByLabel("Amount", { exact: true })
      .fill("800.50");
    await page.getByLabel("Date", { exact: true }).fill("2026-10-26");
    await page.getByRole("button", { name: "Record card payment" }).click();
    await expect(page).toHaveURL(/\/transactions\?recorded=/);

    await openAccount(page, "Amex");
    await expect(balanceOn(page)).toHaveText("Credit balance ₹800.50");
    await openAccount(page, "HDFC Savings");
    await expect(balanceOn(page)).toHaveText("₹71,000.00");

    await record(page, async (p) => {
      await p.getByLabel(/^Transfer/).check();
      await choose(
        p.getByLabel("From account", { exact: true }),
        "HDFC Savings",
      );
      await choose(p.getByLabel("To account", { exact: true }), "Wallet");
      await p.getByLabel("Amount", { exact: true }).fill("1000");
      await p.getByLabel("Date", { exact: true }).fill("2026-10-27");
    });
    await record(page, async (p) => {
      await expect(p.getByLabel(/^Expense/)).toBeChecked();
      await choose(p.getByLabel("Paid from", { exact: true }), "Amex");
      await p
        .getByLabel("Category", { exact: true })
        .selectOption({ label: "Groceries" });
      await p.getByLabel("Amount", { exact: true }).fill("500");
      await p.getByLabel("Date", { exact: true }).fill("2026-10-27");
    });
    await openAccount(page, "HDFC Savings");
    await expect(balanceOn(page)).toHaveText("₹70,000.00");
    await openAccount(page, "Wallet");
    await expect(balanceOn(page)).toHaveText("₹3,000.00");
    await openAccount(page, "Amex");
    await expect(balanceOn(page)).toHaveText("Credit balance ₹300.50");
  });

  async function cardWithPurchase(page: Page) {
    await addDefaultCategories(page);
    await createAccount(page, "Axis Savings", {
      opening: "50000",
      asOf: "2026-10-01",
    });
    await createCreditCard(page, "HDFC Card", {
      owed: "12000",
      asOf: "2026-10-01",
    });
    await expect(balanceOn(page)).toHaveText("Owed ₹12,000.00");

    await page.getByRole("link", { name: "Record card expense" }).click();
    await page
      .getByLabel("Category", { exact: true })
      .selectOption({ label: "Shopping" });
    await transactionForm(page)
      .getByLabel("Amount", { exact: true })
      .fill("1250");
    await page.getByLabel("Date", { exact: true }).fill("2026-10-24");
    await page.getByLabel("Paid to (optional)").fill("Bata");
    await page.getByRole("button", { name: "Record expense" }).click();
    await expect(page).toHaveURL(/\/transactions\?recorded=/);
    await openAccount(page, "HDFC Card");
    await expect(balanceOn(page)).toHaveText("Owed ₹13,250.00");
  }

  async function openPurchase(page: Page) {
    await page.goto("/transactions?type=expense");
    await page
      .getByRole("list", { name: "Transactions" })
      .getByRole("listitem")
      .filter({ hasText: "Bata" })
      .getByRole("link")
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Shopping" }),
    ).toBeVisible();
  }

  test("record a partial refund linked to a card purchase: owed falls, expenses fall, income does not rise", async ({
    page,
  }) => {
    await cardWithPurchase(page);
    await openPurchase(page);
    await expect(
      page.getByText(
        "₹0.00 refunded of ₹1,250.00, leaving ₹1,250.00 refundable.",
      ),
    ).toBeVisible();

    await page.getByRole("link", { name: "Record a refund" }).click();
    await expect(page).toHaveURL(
      /\/transactions\/new\?type=card_refund&purchase=/,
    );
    await expect(page.getByLabel(/^Card refund/)).toBeChecked();
    await expect(
      page.getByLabel(/^A purchase recorded in Finora/),
    ).toBeChecked();
    const refundedTo = page.getByLabel("Refunded to", { exact: true });
    await expect(refundedTo.locator("option:checked")).toHaveText(
      "HDFC Card (Owed ₹13,250.00)",
    );
    const purchaseSelect = page.getByLabel("Purchase being refunded", {
      exact: true,
    });
    await expect(purchaseSelect.locator("option:checked")).toHaveText(
      /24 Oct 2026 · Shopping · Bata · ₹1,250.00 \(₹1,250.00 left\)/,
    );
    await expect(
      page.getByText(
        "The refund credits Shopping, the category this purchase was charged to.",
      ),
    ).toBeVisible();
    await expect(
      page.getByLabel("Category being refunded", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Paid from", { exact: true })).toHaveCount(0);

    const form = transactionForm(page);
    const amount = form.getByLabel("Amount", { exact: true });
    await amount.fill("1500");
    await page.getByLabel("Date", { exact: true }).fill("2026-10-27");
    await page.getByLabel("Refunded by (optional)").fill("Bata");
    await page.getByLabel("Note (optional)").fill("Returned one pair");

    await page.getByRole("button", { name: "Record refund" }).click();
    await expect(
      page.getByText(
        "Refund at most 1250.00 INR, which is what is left of this purchase",
      ),
    ).toBeVisible();
    await expect(amount).toHaveValue("1500");
    await expect(page.getByLabel(/^Card refund/)).toBeChecked();
    await expect(
      page.getByLabel(/^A purchase recorded in Finora/),
    ).toBeChecked();
    await expect(refundedTo.locator("option:checked")).toHaveText(
      "HDFC Card (Owed ₹13,250.00)",
    );
    await expect(purchaseSelect.locator("option:checked")).toHaveText(/Bata/);
    await expect(page.getByLabel("Refunded by (optional)")).toHaveValue("Bata");
    await expect(page.getByLabel("Note (optional)")).toHaveValue(
      "Returned one pair",
    );

    await amount.fill("500");
    await page.getByRole("button", { name: "Record refund" }).click();
    await expect(page).toHaveURL(/\/transactions\?recorded=/);

    await openAccount(page, "HDFC Card");
    await expect(balanceOn(page)).toHaveText("Owed ₹12,750.00");
    await openAccount(page, "Axis Savings");
    await expect(balanceOn(page)).toHaveText("₹50,000.00");

    await openAccount(page, "HDFC Card");
    const refundRow = page
      .getByRole("list", { name: "Transactions" })
      .getByRole("listitem")
      .filter({ hasText: "Refund: Shopping" });
    await expect(refundRow).toContainText("27 Oct 2026");
    await expect(refundRow).toContainText("+₹500.00");
    await expect(refundRow).toContainText("Card refund");

    await page.goto("/transactions?type=expense");
    const expenses = page
      .getByRole("list", { name: "Transactions" })
      .getByRole("listitem");
    await expect(expenses).toHaveCount(1);
    await expect(expenses.first()).toContainText("−₹1,250.00");
    await page.goto("/transactions?type=income");
    await expect(
      page.getByText("No transactions match these filters."),
    ).toBeVisible();
    await page.goto("/transactions?type=card_refund");
    await expect(
      page.getByRole("list", { name: "Transactions" }).getByRole("listitem"),
    ).toHaveCount(1);

    await openPurchase(page);
    await expect(
      page.getByText(
        "₹500.00 refunded of ₹1,250.00, leaving ₹750.00 refundable.",
      ),
    ).toBeVisible();
    await expect(
      page
        .getByRole("list", { name: "Transactions" })
        .getByRole("listitem")
        .filter({ hasText: "Refund: Shopping" }),
    ).toBeVisible();
  });

  test("a linked refund names its purchase, and the purchase cannot be voided until the refund is", async ({
    page,
  }) => {
    await cardWithPurchase(page);
    await openPurchase(page);
    await page.getByRole("link", { name: "Record a refund" }).click();
    await transactionForm(page)
      .getByLabel("Amount", { exact: true })
      .fill("500");
    await page.getByRole("button", { name: "Record refund" }).click();
    await expect(page).toHaveURL(/\/transactions\?recorded=/);

    await page.goto("/transactions?type=card_refund");
    await page
      .getByRole("list", { name: "Transactions" })
      .getByRole("listitem")
      .first()
      .getByRole("link")
      .click();
    await expect(page.getByText("Transactions / Card refund")).toBeVisible();
    await expect(page.getByText("Refunded to", { exact: true })).toBeVisible();
    await expect(page.getByText("Refund of", { exact: true })).toBeVisible();
    const refundUrl = page.url();
    await page
      .getByRole("link", { name: /Shopping of ₹1,250.00 on 24 Oct 2026/ })
      .click();
    await expect(
      page.getByText(
        "₹500.00 refunded of ₹1,250.00, leaving ₹750.00 refundable.",
      ),
    ).toBeVisible();

    await expect(
      page.getByText(
        "This purchase has refunds recorded against it. Void those first,",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Void transaction" }),
    ).toHaveCount(0);

    await page.goto(refundUrl);
    await page.getByRole("button", { name: "Void transaction" }).click();
    await page.getByRole("button", { name: "Yes, void it" }).click();
    await expect(page.getByText("Voided on", { exact: false })).toBeVisible();
    await openAccount(page, "HDFC Card");
    await expect(balanceOn(page)).toHaveText("Owed ₹13,250.00");
    const voidedRow = page
      .getByRole("list", { name: "Transactions" })
      .getByRole("listitem")
      .filter({ hasText: "Refund: Shopping" });
    await expect(voidedRow).toContainText("Void");

    await openPurchase(page);
    await expect(
      page.getByText(
        "₹0.00 refunded of ₹1,250.00, leaving ₹1,250.00 refundable.",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Void transaction" }).click();
    await page.getByRole("button", { name: "Yes, void it" }).click();
    await expect(page.getByText("Voided on", { exact: false })).toBeVisible();
    await openAccount(page, "HDFC Card");
    await expect(balanceOn(page)).toHaveText("Owed ₹12,000.00");
  });

  test("record an unlinked refund from the card's page: a merchant credit, not income", async ({
    page,
  }) => {
    await cardWithPurchase(page);
    await openAccount(page, "HDFC Card");
    await expect(
      page.getByText(/A refund from a merchant reduces it too/),
    ).toBeVisible();

    await page.getByRole("link", { name: "Record refund" }).click();
    await expect(page).toHaveURL(
      /\/transactions\/new\?type=card_refund&account=/,
    );
    await expect(
      page.getByLabel("Refunded to", { exact: true }).locator("option:checked"),
    ).toHaveText("HDFC Card (Owed ₹13,250.00)");

    await page.getByLabel(/^A purchase not in Finora/).check();
    await expect(
      page.getByLabel("Purchase being refunded", { exact: true }),
    ).toHaveCount(0);
    const category = page.getByLabel("Category being refunded", {
      exact: true,
    });
    await expect(category.locator("option", { hasText: "Salary" })).toHaveCount(
      0,
    );
    await expect(category.locator("option", { hasText: "Health" })).toHaveCount(
      1,
    );
    await category.selectOption({ label: "Health" });
    await transactionForm(page)
      .getByLabel("Amount", { exact: true })
      .fill("400");
    await page.getByLabel("Date", { exact: true }).fill("2026-10-28");
    await page.getByLabel("Refunded by (optional)").fill("Chemist");
    await page.getByRole("button", { name: "Record refund" }).click();
    await expect(page).toHaveURL(/\/transactions\?recorded=/);

    await openAccount(page, "HDFC Card");
    await expect(balanceOn(page)).toHaveText("Owed ₹12,850.00");
    await openPurchase(page);
    await expect(
      page.getByText(
        "₹0.00 refunded of ₹1,250.00, leaving ₹1,250.00 refundable.",
      ),
    ).toBeVisible();

    await page.goto("/transactions?type=card_refund");
    const row = page
      .getByRole("list", { name: "Transactions" })
      .getByRole("listitem")
      .filter({ hasText: "Refund: Health" });
    await expect(row).toContainText("+₹400.00");
    await row.getByRole("link").click();
    await expect(
      page.getByText(
        "A purchase that is not recorded in Finora (a merchant credit)",
      ),
    ).toBeVisible();
    await page.goto("/transactions?type=income");
    await expect(
      page.getByText("No transactions match these filters."),
    ).toBeVisible();
  });

  test("a fully refunded purchase is no longer offered, and existing card flows still work", async ({
    page,
  }) => {
    await cardWithPurchase(page);
    await openPurchase(page);
    await page.getByRole("link", { name: "Record a refund" }).click();
    await transactionForm(page)
      .getByLabel("Amount", { exact: true })
      .fill("1250");
    await page.getByRole("button", { name: "Record refund" }).click();
    await expect(page).toHaveURL(/\/transactions\?recorded=/);

    await openPurchase(page);
    await expect(
      page.getByText(
        "₹1,250.00 refunded of ₹1,250.00, leaving ₹0.00 refundable.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Record a refund" }),
    ).toHaveCount(0);
    await page.goto("/transactions/new?type=card_refund");
    await choose(page.getByLabel("Refunded to", { exact: true }), "HDFC Card");
    await expect(
      page
        .getByLabel("Purchase being refunded", { exact: true })
        .locator("option", { hasText: "Bata" }),
    ).toHaveCount(0);
    await expect(
      page.getByText(
        "This card has no purchases left to refund. Record it as a purchase not in Finora instead.",
      ),
    ).toBeVisible();

    await openAccount(page, "HDFC Card");
    await expect(balanceOn(page)).toHaveText("Owed ₹12,000.00");

    await page.getByRole("link", { name: "Record card expense" }).click();
    await page
      .getByLabel("Category", { exact: true })
      .selectOption({ label: "Groceries" });
    await transactionForm(page)
      .getByLabel("Amount", { exact: true })
      .fill("300");
    await page.getByLabel("Date", { exact: true }).fill("2026-10-29");
    await page.getByRole("button", { name: "Record expense" }).click();
    await expect(page).toHaveURL(/\/transactions\?recorded=/);
    await openAccount(page, "HDFC Card");
    await expect(balanceOn(page)).toHaveText("Owed ₹12,300.00");

    await page.getByRole("link", { name: "Record repayment" }).click();
    await choose(page.getByLabel("Paid from", { exact: true }), "Axis Savings");
    await transactionForm(page)
      .getByLabel("Amount", { exact: true })
      .fill("2000");
    await page.getByLabel("Date", { exact: true }).fill("2026-10-29");
    await page.getByRole("button", { name: "Record card payment" }).click();
    await expect(page).toHaveURL(/\/transactions\?recorded=/);
    await openAccount(page, "HDFC Card");
    await expect(balanceOn(page)).toHaveText("Owed ₹10,300.00");
    await openAccount(page, "Axis Savings");
    await expect(balanceOn(page)).toHaveText("₹48,000.00");
  });

  test("correct the opening balance: original reversed, replacement recorded", async ({
    page,
  }) => {
    await createSampleHistory(page);
    await openAccount(page, "HDFC Savings");
    await expect(balanceOn(page)).toHaveText("₹71,800.50");
    await page.getByText("Correct the opening balance").click();
    await page.getByLabel(/^Opening balance/).fill("55000");
    await page.getByRole("button", { name: "Correct opening balance" }).click();
    await expect(page.getByText("₹55,000.00 as of 1 Oct 2026")).toBeVisible();
    await expect(balanceOn(page)).toHaveText("₹76,800.50");
  });
});

test.describe("default categories (a brand-new owner)", () => {
  test.beforeEach(async ({ page, owner }) => {
    await signIn(page, owner.email, owner.password);
    await expect(page).toHaveURL(/\/$/);
  });

  test("viewing pages creates no categories; defaults are added only on request", async ({
    page,
    owner,
  }) => {
    expect(await categoryCount(owner.ownerId)).toBe(0);
    await page.goto("/accounts/new");
    await page.getByLabel("Account name").fill("Categories probe");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: /Categories probe/ }),
    ).toBeVisible();

    for (const path of ["/", "/accounts", "/transactions"])
      await page.goto(path);
    await page.goto("/transactions/new");
    const notice = page.getByRole("region", { name: "No categories yet" });
    await expect(notice).toContainText(/Add the default set/);
    await expect(
      notice.getByRole("link", { name: "Categories" }),
    ).toHaveAttribute("href", "/categories");
    await expect(page.getByLabel(/^Transfer/)).toBeChecked();
    await page.goto("/categories");
    await expect(page.getByText("No categories yet")).toBeVisible();
    await page.reload();
    expect(await categoryCount(owner.ownerId)).toBe(0);

    await page.goto("/transactions/new");
    await notice
      .getByRole("button", { name: "Add default categories" })
      .click();
    await expect(page).toHaveURL(/\/transactions\/new$/);
    await expect(notice).toHaveCount(0);
    await expect(page.getByLabel(/^Expense/)).toBeChecked();
    await expect(
      page
        .getByLabel("Category", { exact: true })
        .locator("option", { hasText: "Groceries" }),
    ).toHaveCount(1);
    const created = await categoryCount(owner.ownerId);
    expect(created).toBeGreaterThan(0);

    await page.goto("/categories");
    await expect(
      page.getByRole("region", { name: "Income categories" }),
    ).toContainText("Salary");
    await expect(
      page.getByRole("button", { name: "Add default categories" }),
    ).toHaveCount(0);
    await page.goto("/transactions/new");
    expect(await categoryCount(owner.ownerId)).toBe(created);
  });
});
