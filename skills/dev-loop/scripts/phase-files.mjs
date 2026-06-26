import { pathToFileURL } from "node:url";

export {
  applyManifestPatch,
  buildPhasePaths,
  createDefaultPhaseIndex,
  createDefaultPhaseManifest,
  ensurePhaseFiles,
  normalizePhaseName,
  parseCliArgs,
  readJsonIfExists,
  runCli,
  uniqueSortedStrings,
  upsertPhaseIndex,
  writeJson,
} from "@dev-loops/core/loop/phase-files";

import { runCli } from "@dev-loops/core/loop/phase-files";

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsScript) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
