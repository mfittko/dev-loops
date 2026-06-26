import { pathToFileURL } from "node:url";

export {
  DEFAULT_OUTPUT_LIMIT,
  appendBashExitOneRecord,
  formatBashExitOneRecord,
  normalizeBashExitOneRecord,
  parseCliArgs,
  readRecordFromStdin,
  runCli,
  truncateText,
} from "@dev-loops/core/bash-exit-one";

import { runCli } from "@dev-loops/core/bash-exit-one";

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsScript) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
