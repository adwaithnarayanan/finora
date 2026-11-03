#!/usr/bin/env node
import { accountNameKeySql } from "../lib/account-name-key-sql.mjs";

process.stdout.write(`${accountNameKeySql()}\n`);
