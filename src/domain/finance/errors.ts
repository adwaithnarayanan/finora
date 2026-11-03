export class FinanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface FieldIssue {
  readonly field: string;
  readonly message: string;
}

export class FinanceValidationError extends FinanceError {
  readonly issues: readonly FieldIssue[];

  constructor(issues: readonly FieldIssue[]) {
    super(
      `Invalid input: ${issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`,
    );
    this.issues = Object.freeze([...issues]);
  }
}

export class IssueCollector {
  private readonly issues: FieldIssue[] = [];

  add(field: string, message: string): void {
    this.issues.push({ field, message });
  }

  capture<T>(field: string, parse: () => T): T | undefined {
    try {
      return parse();
    } catch (error) {
      this.add(field, error instanceof Error ? error.message : "Invalid value");
      return undefined;
    }
  }

  throwIfAny(): void {
    if (this.issues.length > 0) throw new FinanceValidationError(this.issues);
  }
}
