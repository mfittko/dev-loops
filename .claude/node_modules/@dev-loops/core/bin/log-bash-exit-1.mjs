#!/usr/bin/env node
import { runCli } from "../src/bash-exit-one.mjs";

runCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
