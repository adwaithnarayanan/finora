// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ActionState, formEntries } from "../shared/form-state";
import { recordTransactionAction } from "./actions";
import { TransactionForm } from "./transaction-form";

vi.mock("./actions", () => ({ recordTransactionAction: vi.fn() }));
const action = vi.mocked(recordTransactionAction);

const BANK = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const WALLET = "33333333-3333-4333-8333-333333333333";
const SHOPPING = "44444444-4444-4444-8444-444444444444";
const SALARY = "55555555-5555-4555-8555-555555555555";
const AMEX = "77777777-7777-4777-8777-777777777777";
const BATA = "88888888-8888-4888-8888-888888888888";
const CHEMIST = "99999999-9999-4999-8999-999999999999";

const accounts = [
  {
    id: BANK,
    label: "Axis Savings (₹50,000.00)",
    currencyCode: "INR",
    exponent: 2,
    card: false,
  },
  {
    id: CARD,
    label: "HDFC Card (Owed ₹12,000.00)",
    currencyCode: "INR",
    exponent: 2,
    card: true,
  },
  {
    id: WALLET,
    label: "Wallet (₹0.00)",
    currencyCode: "INR",
    exponent: 2,
    card: false,
  },
  {
    id: AMEX,
    label: "Amex (Nothing owed (₹0.00))",
    currencyCode: "INR",
    exponent: 2,
    card: true,
  },
];

const purchases = [
  {
    id: BATA,
    cardAccountId: CARD,
    categoryLabel: "Shopping",
    label: "24 Oct 2026 · Shopping · Bata · ₹1,250.00 (₹1,250.00 left)",
  },
  {
    id: CHEMIST,
    cardAccountId: AMEX,
    categoryLabel: "Health",
    label: "20 Oct 2026 · Health · Chemist · ₹400.00 (₹150.00 left)",
  },
];

function refuse(field: string, message: string) {
  action.mockImplementation(async (_prev: ActionState, formData: FormData) => ({
    fieldErrors: { [field]: message },
    values: formEntries(formData),
  }));
}

function renderForm(
  props: {
    initialKind?:
      "income" | "expense" | "transfer" | "card_payment" | "card_refund";
    initialSourceAccountId?: string;
    initialDestinationAccountId?: string;
    initialPurchaseId?: string;
    purchases?: readonly {
      id: string;
      cardAccountId: string;
      categoryLabel: string;
      label: string;
    }[];
  } = {},
) {
  return render(
    <TransactionForm
      idempotencyKey="66666666-6666-4666-8666-666666666666"
      today="2026-10-24"
      initialKind={props.initialKind ?? "expense"}
      {...(props.initialSourceAccountId
        ? { initialSourceAccountId: props.initialSourceAccountId }
        : {})}
      {...(props.initialDestinationAccountId
        ? { initialDestinationAccountId: props.initialDestinationAccountId }
        : {})}
      {...(props.initialPurchaseId
        ? { initialPurchaseId: props.initialPurchaseId }
        : {})}
      accounts={accounts}
      incomeCategories={[{ id: SALARY, label: "Salary" }]}
      expenseCategories={[{ id: SHOPPING, label: "Shopping" }]}
      purchases={props.purchases ?? purchases}
    />,
  );
}

const select = (label: string) =>
  screen.getByLabelText(label, {
    exact: true,
    selector: "select",
  }) as HTMLSelectElement;
const radio = (name: RegExp) =>
  screen.getByRole("radio", { name }) as HTMLInputElement;
const optionLabels = (label: string) =>
  Array.from(select(label).options, (o) => o.text);

async function submit(button: RegExp, error: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: button }));
  });
  await screen.findByText(error);
}

const lastSubmitted = () => formEntries(action.mock.calls.at(-1)![1]);

beforeEach(() => {
  action.mockReset();
});
afterEach(cleanup);

describe("TransactionForm after a refused submission", () => {
  it("keeps the type, the card and the category on screen, and submits them again", async () => {
    refuse("amount", "Use at most 2 decimal places for INR");
    renderForm({ initialSourceAccountId: CARD });
    expect(select("Paid from").value).toBe(CARD);
    fireEvent.change(select("Category"), { target: { value: SHOPPING } });
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "1250.005" },
    });

    await submit(/Record expense/, "Use at most 2 decimal places for INR");
    expect(lastSubmitted()).toMatchObject({
      kind: "expense",
      sourceAccountId: CARD,
      expenseCategoryId: SHOPPING,
      amount: "1250.005",
    });

    expect(radio(/^Expense/).checked).toBe(true);
    expect(select("Paid from").value).toBe(CARD);
    expect(select("Category").value).toBe(SHOPPING);
    expect(
      screen.getByText(
        "Paid by credit card: adds to the amount owed on the card.",
      ),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "1250" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Record expense/ }));
    });
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(lastSubmitted()).toMatchObject({
      kind: "expense",
      sourceAccountId: CARD,
      expenseCategoryId: SHOPPING,
      amount: "1250",
    });
  });

  it("keeps a changed choice: what is shown is what was submitted", async () => {
    refuse("amount", "Enter an amount greater than zero, like 1250 or 1250.50");
    renderForm({ initialSourceAccountId: CARD });
    fireEvent.change(select("Paid from"), { target: { value: BANK } });
    await submit(
      /Record expense/,
      "Enter an amount greater than zero, like 1250 or 1250.50",
    );
    expect(lastSubmitted()["sourceAccountId"]).toBe(BANK);
    expect(select("Paid from").value).toBe(BANK);
    expect(screen.queryByText(/Paid by credit card/)).not.toBeInTheDocument();

    fireEvent.change(select("Paid from"), { target: { value: "" } });
    await submit(
      /Record expense/,
      "Enter an amount greater than zero, like 1250 or 1250.50",
    );
    expect(lastSubmitted()["sourceAccountId"]).toBe("");
    expect(select("Paid from").value).toBe("");
  });

  it("keeps a transfer's type and both accounts", async () => {
    refuse("amount", "Enter an amount greater than zero, like 1250 or 1250.50");
    renderForm({ initialKind: "transfer" });
    fireEvent.change(select("From account"), { target: { value: BANK } });
    fireEvent.change(select("To account"), { target: { value: WALLET } });

    await submit(
      /Record transfer/,
      "Enter an amount greater than zero, like 1250 or 1250.50",
    );
    expect(lastSubmitted()).toMatchObject({
      kind: "transfer",
      sourceAccountId: BANK,
      destinationAccountId: WALLET,
    });
    expect(radio(/^Transfer/).checked).toBe(true);
    expect(radio(/^Expense/).checked).toBe(false);
    expect(select("From account").value).toBe(BANK);
    expect(select("To account").value).toBe(WALLET);
  });

  it("does not bring back a receiving account dropped by a switch to transfer", async () => {
    refuse("destinationAccountId", "Choose the account receiving the money");
    renderForm();
    fireEvent.change(select("Paid from"), { target: { value: BANK } });
    fireEvent.click(radio(/^Income/));
    fireEvent.change(select("Received into"), { target: { value: BANK } });

    fireEvent.click(radio(/^Transfer/));
    expect(select("From account").value).toBe(BANK);
    expect(optionLabels("To account")).not.toContain(
      "Axis Savings (₹50,000.00)",
    );
    expect(select("To account").value).toBe("");

    fireEvent.click(radio(/^Income/));
    expect(select("Received into").value).toBe("");
    expect(screen.getByText("Choose the account first.")).toBeInTheDocument();

    await submit(/Record income/, "Choose the account receiving the money");
    expect(lastSubmitted()).toMatchObject({
      kind: "income",
      destinationAccountId: "",
    });
    expect(radio(/^Income/).checked).toBe(true);
    expect(select("Received into").value).toBe("");
    expect(screen.getByText("Choose the account first.")).toBeInTheDocument();
  });

  it("keeps an income's type and receiving account", async () => {
    refuse("amount", "Enter an amount greater than zero, like 1250 or 1250.50");
    renderForm({ initialKind: "income" });
    fireEvent.change(select("Received into"), { target: { value: WALLET } });
    fireEvent.change(select("Category"), { target: { value: SALARY } });

    await submit(
      /Record income/,
      "Enter an amount greater than zero, like 1250 or 1250.50",
    );
    expect(radio(/^Income/).checked).toBe(true);
    expect(select("Received into").value).toBe(WALLET);
    expect(select("Category").value).toBe(SALARY);
  });
});

describe("TransactionForm card choices", () => {
  it("offers a card only as the paying account of an expense", () => {
    renderForm();
    expect(optionLabels("Paid from")).toContain("HDFC Card (Owed ₹12,000.00)");
    fireEvent.click(radio(/^Income/));
    expect(optionLabels("Received into")).not.toContain(
      "HDFC Card (Owed ₹12,000.00)",
    );
    fireEvent.click(radio(/^Transfer/));
    expect(optionLabels("From account")).not.toContain(
      "HDFC Card (Owed ₹12,000.00)",
    );
    expect(optionLabels("To account")).not.toContain(
      "HDFC Card (Owed ₹12,000.00)",
    );
  });

  it("clears a chosen card when the type changes away from expense, and does not bring it back", async () => {
    refuse("destinationAccountId", "Choose the account receiving the money");
    renderForm({ initialSourceAccountId: CARD });
    fireEvent.click(radio(/^Transfer/));
    expect(select("From account").value).toBe("");
    await submit(/Record transfer/, "Choose the account receiving the money");
    expect(lastSubmitted()).toMatchObject({
      kind: "transfer",
      sourceAccountId: "",
    });
    expect(radio(/^Transfer/).checked).toBe(true);
    expect(select("From account").value).toBe("");

    fireEvent.click(radio(/^Expense/));
    expect(select("Paid from").value).toBe("");
    expect(screen.queryByText(/Paid by credit card/)).not.toBeInTheDocument();
  });
});

describe("TransactionForm card payments", () => {
  it("offers only bank and cash accounts to pay from, and only cards to be paid", () => {
    renderForm({ initialKind: "card_payment" });
    expect(optionLabels("Paid from")).toEqual([
      "Choose an account",
      "Axis Savings (₹50,000.00)",
      "Wallet (₹0.00)",
    ]);
    expect(optionLabels("Card to pay")).toEqual([
      "Choose an account",
      "HDFC Card (Owed ₹12,000.00)",
      "Amex (Nothing owed (₹0.00))",
    ]);
    expect(screen.queryByLabelText("Category")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Paid to/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "The payment reduces the amount owed on this card. It is not an expense.",
      ),
    ).toBeInTheDocument();
  });

  it("preselects the card it was opened from and submits both sides", async () => {
    refuse("amount", "Enter an amount greater than zero, like 1250 or 1250.50");
    renderForm({
      initialKind: "card_payment",
      initialDestinationAccountId: CARD,
    });
    expect(select("Card to pay").value).toBe(CARD);
    fireEvent.change(select("Paid from"), { target: { value: BANK } });
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByLabelText(/^Note/), {
      target: { value: "Oct statement" },
    });

    await submit(
      /Record card payment/,
      "Enter an amount greater than zero, like 1250 or 1250.50",
    );
    expect(lastSubmitted()).toMatchObject({
      kind: "card_payment",
      sourceAccountId: BANK,
      destinationAccountId: CARD,
      amount: "0",
      note: "Oct statement",
    });
    expect(radio(/^Card payment/).checked).toBe(true);
    expect(select("Paid from").value).toBe(BANK);
    expect(select("Card to pay").value).toBe(CARD);
    expect(screen.getByLabelText("Amount")).toHaveValue("0");
    expect(screen.getByLabelText(/^Note/)).toHaveValue("Oct statement");
  });

  it("drops a destination the new kind cannot offer, so no stale account is submitted", async () => {
    refuse("sourceAccountId", "Choose the account paying the card");
    renderForm({ initialKind: "transfer" });
    fireEvent.change(select("From account"), { target: { value: BANK } });
    fireEvent.change(select("To account"), { target: { value: WALLET } });

    fireEvent.click(radio(/^Card payment/));
    expect(select("Card to pay").value).toBe("");
    expect(optionLabels("Card to pay")).not.toContain("Wallet (₹0.00)");

    fireEvent.change(select("Card to pay"), { target: { value: CARD } });
    fireEvent.click(radio(/^Transfer/));
    expect(select("To account").value).toBe("");
    fireEvent.click(radio(/^Income/));
    expect(select("Received into").value).toBe("");

    fireEvent.click(radio(/^Card payment/));
    await submit(/Record card payment/, "Choose the account paying the card");
    expect(lastSubmitted()).toMatchObject({
      kind: "card_payment",
      destinationAccountId: "",
    });
  });

  it("clears a card chosen as the paying account of an expense when switching to a card payment", () => {
    renderForm({ initialSourceAccountId: CARD });
    expect(select("Paid from").value).toBe(CARD);
    fireEvent.click(radio(/^Card payment/));
    expect(select("Paid from").value).toBe("");
    expect(optionLabels("Paid from")).not.toContain(
      "HDFC Card (Owed ₹12,000.00)",
    );
    expect(
      screen.getByText("The bank or cash account the money comes from."),
    ).toBeInTheDocument();
  });
});

describe("TransactionForm: card refunds", () => {
  it("offers only credit cards, and only that card's refundable purchases", () => {
    renderForm({ initialKind: "card_refund" });
    expect(optionLabels("Refunded to")).toEqual([
      "Choose an account",
      "HDFC Card (Owed ₹12,000.00)",
      "Amex (Nothing owed (₹0.00))",
    ]);
    expect(optionLabels("Purchase being refunded")).toEqual([
      "Choose a purchase",
    ]);
    expect(screen.getByText("Choose the card first.")).toBeInTheDocument();

    fireEvent.change(select("Refunded to"), { target: { value: CARD } });
    expect(optionLabels("Purchase being refunded")).toEqual([
      "Choose a purchase",
      "24 Oct 2026 · Shopping · Bata · ₹1,250.00 (₹1,250.00 left)",
    ]);
    expect(optionLabels("Purchase being refunded")).not.toContain(
      "20 Oct 2026 · Health · Chemist · ₹400.00 (₹150.00 left)",
    );
  });

  it("names the category a linked refund will credit, and shows no category picker", () => {
    renderForm({
      initialKind: "card_refund",
      initialDestinationAccountId: CARD,
      initialPurchaseId: BATA,
    });
    expect(select("Purchase being refunded").value).toBe(BATA);
    expect(
      screen.getByText(
        "The refund credits Shopping, the category this purchase was charged to.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Category being refunded"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "The refund reduces the amount owed on this card and reduces your expenses. It is not income.",
      ),
    ).toBeInTheDocument();
  });

  it("submits the purchase in linked mode and no category", async () => {
    refuse("amount", "Use at most 2 decimal places for INR");
    renderForm({
      initialKind: "card_refund",
      initialDestinationAccountId: CARD,
      initialPurchaseId: BATA,
    });
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "250.005" },
    });
    fireEvent.change(screen.getByLabelText("Refunded by (optional)"), {
      target: { value: "Bata" },
    });

    await submit(/Record refund/, "Use at most 2 decimal places for INR");
    const sent = lastSubmitted();
    expect(sent).toMatchObject({
      kind: "card_refund",
      destinationAccountId: CARD,
      refundMode: "linked",
      refundsTransactionId: BATA,
      payee: "Bata",
    });
    expect(sent["refundCategoryId"]).toBeUndefined();
    expect(radio(/^Card refund/).checked).toBe(true);
    expect(radio(/^A purchase recorded in Finora/).checked).toBe(true);
    expect(select("Refunded to").value).toBe(CARD);
    expect(select("Purchase being refunded").value).toBe(BATA);
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe(
      "250.005",
    );
    expect(
      (screen.getByLabelText("Refunded by (optional)") as HTMLInputElement)
        .value,
    ).toBe("Bata");
  });

  it("submits a category in unlinked mode and no purchase", async () => {
    refuse("amount", "Use at most 2 decimal places for INR");
    renderForm({
      initialKind: "card_refund",
      initialDestinationAccountId: CARD,
      initialPurchaseId: BATA,
    });
    fireEvent.click(radio(/^A purchase not in Finora/));
    expect(
      screen.queryByLabelText("Purchase being refunded"),
    ).not.toBeInTheDocument();
    fireEvent.change(select("Category being refunded"), {
      target: { value: SHOPPING },
    });
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "99.999" },
    });

    await submit(/Record refund/, "Use at most 2 decimal places for INR");
    const sent = lastSubmitted();
    expect(sent).toMatchObject({
      kind: "card_refund",
      refundMode: "unlinked",
      refundCategoryId: SHOPPING,
    });
    expect(sent["refundsTransactionId"]).toBeUndefined();
    expect(radio(/^A purchase not in Finora/).checked).toBe(true);
    expect(select("Category being refunded").value).toBe(SHOPPING);
  });

  it("drops a purchase that the newly chosen card cannot offer", () => {
    renderForm({
      initialKind: "card_refund",
      initialDestinationAccountId: CARD,
      initialPurchaseId: BATA,
    });
    expect(select("Purchase being refunded").value).toBe(BATA);
    fireEvent.change(select("Refunded to"), { target: { value: AMEX } });
    expect(select("Purchase being refunded").value).toBe("");
    expect(optionLabels("Purchase being refunded")).toEqual([
      "Choose a purchase",
      "20 Oct 2026 · Health · Chemist · ₹400.00 (₹150.00 left)",
    ]);
  });

  it("says so when the chosen card has no purchase left to refund", () => {
    renderForm({ initialKind: "card_refund", purchases: [] });
    fireEvent.change(select("Refunded to"), { target: { value: CARD } });
    expect(optionLabels("Purchase being refunded")).toEqual([
      "Choose a purchase",
    ]);
    expect(
      screen.getByText(
        "This card has no purchases left to refund. Record it as a purchase not in Finora instead.",
      ),
    ).toBeInTheDocument();
  });

  it("starts in linked mode, the preferred record when the purchase is in Finora", () => {
    renderForm({ initialKind: "card_refund" });
    expect(radio(/^A purchase recorded in Finora/).checked).toBe(true);
    expect(
      screen.getByLabelText("Purchase being refunded"),
    ).toBeInTheDocument();
  });

  it("drops the card and the purchase when switching to a kind that cannot use them", () => {
    renderForm({
      initialKind: "card_refund",
      initialDestinationAccountId: CARD,
      initialPurchaseId: BATA,
    });
    fireEvent.click(radio(/^Income/));
    expect(select("Received into").value).toBe("");
    expect(
      screen.queryByLabelText("Purchase being refunded"),
    ).not.toBeInTheDocument();

    fireEvent.click(radio(/^Card refund/));
    expect(select("Refunded to").value).toBe("");
    expect(select("Purchase being refunded").value).toBe("");
  });

  it("keeps a card payment's card when switching to a refund, since both use cards", () => {
    renderForm({
      initialKind: "card_payment",
      initialDestinationAccountId: CARD,
    });
    expect(select("Card to pay").value).toBe(CARD);
    fireEvent.click(radio(/^Card refund/));
    expect(select("Refunded to").value).toBe(CARD);
    expect(screen.queryByLabelText("Paid from")).not.toBeInTheDocument();
  });
});
