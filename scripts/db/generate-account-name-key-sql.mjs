#!/usr/bin/env node
// Prints the generated SQL block of migration 20261025000500_account_name_key
// for the running Node (run it on the pinned version in .nvmrc). Migrations
// are never edited once applied: if the output differs from the migration,
// the runtime's Unicode data changed (see ADR 0007, "Changing Node").
import { accountNameKeySql } from "../lib/account-name-key-sql.mjs";

process.stdout.write(`${accountNameKeySql()}\n`);
