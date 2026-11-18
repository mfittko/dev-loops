#!/usr/bin/env node
// ADR 0290: this runs with the built-in trust defaults only; it does not load the `.devloops` trust config.
import { formatCliError, runCli } from "../src/github/review-threads.mjs";

runCli().catch((error) => {
  process.stderr.write(`${formatCliError(error)}\n`);
  process.exitCode = 1;
});
