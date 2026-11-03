import "server-only";

import { notFound } from "next/navigation";

import { FinanceNotFoundError } from "@/server/finance";

/** Renders the 404 page when the record is missing (or not the owner's; the two look the same). */
export async function orNotFound<T>(lookup: Promise<T>): Promise<T> {
  try {
    return await lookup;
  } catch (error) {
    if (error instanceof FinanceNotFoundError) notFound();
    throw error;
  }
}
