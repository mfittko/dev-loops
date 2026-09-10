#!/usr/bin/env node
import { formatCliError, runCli } from "../src/github/review-threads.mjs";

runCli().catch((error) => {
  process.stderr.write(`${formatCliError(error)}\n`);
  process.exitCode = 1;
});
