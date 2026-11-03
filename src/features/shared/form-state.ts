export type ActionState = {
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly message?: string;
  readonly values?: Readonly<Record<string, string>>;
};

export const INITIAL_STATE: ActionState = {};

export function formEntries(formData: FormData): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [key, value] of formData) {
    if (typeof value === "string") entries[key] = value;
  }
  return entries;
}
