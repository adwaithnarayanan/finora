import "server-only";

import { notFound } from "next/navigation";

import { FinanceNotFoundError } from "@/server/finance";

export async function orNotFound<T>(lookup: Promise<T>): Promise<T> {
  try {
    return await lookup;
  } catch (error) {
    if (error instanceof FinanceNotFoundError) notFound();
    throw error;
  }
}
