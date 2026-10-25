export type CleanupStep = readonly [label: string, step: () => Promise<unknown>];

/**
 * Runs every cleanup step, even after earlier ones fail, then reports all
 * failures together (labelled), so one failed step never hides another or
 * leaves later resources behind.
 */
export async function runCleanup(steps: readonly CleanupStep[]): Promise<void> {
  const failures: Error[] = [];
  for (const [label, step] of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} cleanup step(s) failed: ${failures.map((f) => f.message).join("; ")}`);
  }
}
