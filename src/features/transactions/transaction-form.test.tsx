// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ActionState, formEntries } from "../shared/form-state";
import { recordTransactionAction } from "./actions";
import { TransactionForm } from "./transaction-form";

// The server action is replaced: these tests cover only what the form shows
// and submits. Validation and authorisation stay on the server.
vi.mock("./actions", () => ({ recordTransactionAction: vi.fn() }));
const action = vi.mocked(recordTransactionAction);

const BANK = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const WALLET = "33333333-3333-4333-8333-333333333333";
const SHOPPING = "44444444-4444-4444-8444-444444444444";
const SALARY = "55555555-5555-4555-8555-555555555555";

const accounts = [
  { id: BANK, label: "Axis Savings (₹50,000.00)", currencyCode: "INR", exponent: 2, card: false },
  { id: CARD, label: "HDFC Card (Owed ₹12,000.00)", currencyCode: "INR", exponent: 2, card: true },
  { id: WALLET, label: "Wallet (₹0.00)", currencyCode: "INR", exponent: 2, card: false },
];

/** Refuses every submission, echoing what was submitted (as the real action does). */
function refuse(field: string, message: string) {
  action.mockImplementation(async (_prev: ActionState, formData: FormData) => ({
    fieldErrors: { [field]: message },
    values: formEntries(formData),
  }));
}

function renderForm(props: { initialKind?: "income" | "expense" | "transfer"; initialSourceAccountId?: string } = {}) {
  return render(
    <TransactionForm
      idempotencyKey="66666666-6666-4666-8666-666666666666"
      today="2026-10-24"
      initialKind={props.initialKind ?? "expense"}
      {...(props.initialSourceAccountId ? { initialSourceAccountId: props.initialSourceAccountId } : {})}
      accounts={accounts}
      incomeCategories={[{ id: SALARY, label: "Salary" }]}
      expenseCategories={[{ id: SHOPPING, label: "Shopping" }]}
    />,
  );
}

const select = (label: string) => screen.getByLabelText(label, { exact: true, selector: "select" }) as HTMLSelectElement;
const radio = (name: RegExp) => screen.getByRole("radio", { name }) as HTMLInputElement;
const optionLabels = (label: string) => Array.from(select(label).options, (o) => o.text);

async function submit(button: RegExp, error: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: button }));
  });
  await screen.findByText(error);
}

/** What the last submission sent to the server. */
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
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1250.005" } });

    await submit(/Record expense/, "Use at most 2 decimal places for INR");
    expect(lastSubmitted()).toMatchObject({ kind: "expense", sourceAccountId: CARD, expenseCategoryId: SHOPPING, amount: "1250.005" });

    // The native reset after the action must not put the fields back to their first values.
    expect(radio(/^Expense/).checked).toBe(true);
    expect(select("Paid from").value).toBe(CARD);
    expect(select("Category").value).toBe(SHOPPING);
    expect(screen.getByText("Paid by credit card: adds to the amount owed on the card.")).toBeInTheDocument();

    // A corrected resubmission sends the retained card and category.
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1250" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Record expense/ }));
    });
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(lastSubmitted()).toMatchObject({ kind: "expense", sourceAccountId: CARD, expenseCategoryId: SHOPPING, amount: "1250" });
  });

  it("keeps a changed choice: what is shown is what was submitted", async () => {
    refuse("amount", "Enter an amount greater than zero, like 1250 or 1250.50");
    renderForm({ initialSourceAccountId: CARD });
    fireEvent.change(select("Paid from"), { target: { value: BANK } });
    await submit(/Record expense/, "Enter an amount greater than zero, like 1250 or 1250.50");
    expect(lastSubmitted()["sourceAccountId"]).toBe(BANK);
    expect(select("Paid from").value).toBe(BANK);
    expect(screen.queryByText(/Paid by credit card/)).not.toBeInTheDocument();

    // Cleared, then refused again: still cleared, not back to the preselected card.
    fireEvent.change(select("Paid from"), { target: { value: "" } });
    await submit(/Record expense/, "Enter an amount greater than zero, like 1250 or 1250.50");
    expect(lastSubmitted()["sourceAccountId"]).toBe("");
    expect(select("Paid from").value).toBe("");
  });

  it("keeps a transfer's type and both accounts", async () => {
    refuse("amount", "Enter an amount greater than zero, like 1250 or 1250.50");
    renderForm({ initialKind: "transfer" });
    fireEvent.change(select("From account"), { target: { value: BANK } });
    fireEvent.change(select("To account"), { target: { value: WALLET } });

    await submit(/Record transfer/, "Enter an amount greater than zero, like 1250 or 1250.50");
    expect(lastSubmitted()).toMatchObject({ kind: "transfer", sourceAccountId: BANK, destinationAccountId: WALLET });
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

    // The source is the same account, so a transfer cannot offer it as the destination.
    fireEvent.click(radio(/^Transfer/));
    expect(select("From account").value).toBe(BANK);
    expect(optionLabels("To account")).not.toContain("Axis Savings (₹50,000.00)");
    expect(select("To account").value).toBe("");

    fireEvent.click(radio(/^Income/));
    expect(select("Received into").value).toBe("");
    expect(screen.getByText("Choose the account first.")).toBeInTheDocument();

    await submit(/Record income/, "Choose the account receiving the money");
    expect(lastSubmitted()).toMatchObject({ kind: "income", destinationAccountId: "" });
    expect(radio(/^Income/).checked).toBe(true);
    expect(select("Received into").value).toBe("");
    expect(screen.getByText("Choose the account first.")).toBeInTheDocument();
  });

  it("keeps an income's type and receiving account", async () => {
    refuse("amount", "Enter an amount greater than zero, like 1250 or 1250.50");
    renderForm({ initialKind: "income" });
    fireEvent.change(select("Received into"), { target: { value: WALLET } });
    fireEvent.change(select("Category"), { target: { value: SALARY } });

    await submit(/Record income/, "Enter an amount greater than zero, like 1250 or 1250.50");
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
    expect(optionLabels("Received into")).not.toContain("HDFC Card (Owed ₹12,000.00)");
    fireEvent.click(radio(/^Transfer/));
    expect(optionLabels("From account")).not.toContain("HDFC Card (Owed ₹12,000.00)");
    expect(optionLabels("To account")).not.toContain("HDFC Card (Owed ₹12,000.00)");
  });

  it("clears a chosen card when the type changes away from expense, and does not bring it back", async () => {
    refuse("destinationAccountId", "Choose the account receiving the money");
    renderForm({ initialSourceAccountId: CARD });
    fireEvent.click(radio(/^Transfer/));
    expect(select("From account").value).toBe("");
    await submit(/Record transfer/, "Choose the account receiving the money");
    expect(lastSubmitted()).toMatchObject({ kind: "transfer", sourceAccountId: "" });
    expect(radio(/^Transfer/).checked).toBe(true);
    expect(select("From account").value).toBe("");

    fireEvent.click(radio(/^Expense/));
    expect(select("Paid from").value).toBe("");
    expect(screen.queryByText(/Paid by credit card/)).not.toBeInTheDocument();
  });
});
