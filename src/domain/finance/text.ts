import { FinanceError } from "./errors";

export class InvalidFinanceInputError extends FinanceError {}

function bounded(value: unknown, label: string, max: number): string {
  if (typeof value !== "string")
    throw new InvalidFinanceInputError(`${label} is required`);
  const text = value.trim();
  if (text.length === 0)
    throw new InvalidFinanceInputError(`${label} is required`);
  if (text.length > max)
    throw new InvalidFinanceInputError(
      `${label} must be at most ${max} characters`,
    );
  return text;
}

function optionalBounded(
  value: unknown,
  label: string,
  max: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return bounded(value, label, max);
}

export const MAX_NAME_LENGTH = 60;
export const MAX_PAYEE_LENGTH = 100;
export const MAX_NOTE_LENGTH = 500;

export const parseName = (value: unknown, label = "Name") =>
  bounded(value, label, MAX_NAME_LENGTH);
export const parsePayee = (value: unknown) =>
  optionalBounded(value, "Payee", MAX_PAYEE_LENGTH);
export const parseNote = (value: unknown) =>
  optionalBounded(value, "Note", MAX_NOTE_LENGTH);
