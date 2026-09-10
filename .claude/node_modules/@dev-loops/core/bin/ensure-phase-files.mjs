#!/usr/bin/env node
import { runCli } from "../src/loop/phase-files.mjs";

runCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
