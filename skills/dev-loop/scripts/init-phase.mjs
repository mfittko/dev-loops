import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ensurePhaseFiles, parseCliArgs as parsePhaseFileArgs } from "./phase-files.mjs";
import { materializeTemplate } from "./render-template.mjs";

export const DEFAULT_PHASE_ARTIFACTS = [
  "manifest.json",
  "variant-a.md",
  "variant-b.md",
  "merged-plan.md",
  "review.md",
];

export function parseCliArgs(argv) {
  return parsePhaseFileArgs(argv);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, "..");
const templateRoot = path.join(skillRoot, "templates");

// ARTIFACT-TRACKER-FIRST-NO-DUP (#1628): an issue-keyed worktree
// (tmp/worktrees/dev-loops/issue-<n>) is by construction a tracker-backed
// session — the tracker issue is the durable spec-of-record and no duplicate
// local phase doc should be minted for it. Detect that layout here so
// initializePhase refuses the durable docs/phases/phase-<n>.md mint while
// still allowing the ephemeral tmp/phases scaffold.
const ISSUE_KEYED_WORKTREE_PATTERN = /[\\/]tmp[\\/]worktrees[\\/]dev-loops[\\/]issue-\d+[\\/]?$/u;

export function isTrackerIssueKeyedWorktree(projectRoot) {
  return ISSUE_KEYED_WORKTREE_PATTERN.test(path.resolve(String(projectRoot)).replace(/[\\/]+$/u, ""));
}

export async function initializePhase(projectRoot, phase, patch = {}) {
  const trackerBacked = isTrackerIssueKeyedWorktree(projectRoot);
  const phasePlanArtifact = path.relative(
    path.join(projectRoot, "tmp", "phases", phase),
    path.join(projectRoot, "docs", "phases", `${phase}.md`),
  );

  const nextPatch = {
    ...patch,
    artifacts: [
      ...(patch.artifacts ?? []),
      ...DEFAULT_PHASE_ARTIFACTS,
      // Tracker-backed sessions refuse the durable phase-doc mint
      // (ARTIFACT-TRACKER-FIRST-NO-DUP); the ephemeral tmp/ artifacts are
      // unaffected and still advertised so manifest.artifacts stays populated.
      ...(trackerBacked ? [] : [phasePlanArtifact]),
    ],
  };

  const result = await ensurePhaseFiles(projectRoot, phase, nextPatch);

  const outputs = [
    // Tracker-backed sessions refuse the durable phase-doc mint
    // (ARTIFACT-TRACKER-FIRST-NO-DUP); the ephemeral tmp/ scaffold below is
    // unaffected and still allowed.
    ...(trackerBacked
      ? []
      : [["phase-doc.md", result.paths.phasePlanPath, { phase }]]),
    ["phase-variant.md", path.join(result.paths.phaseDir, "variant-a.md"), { phase, variant: "a" }],
    ["phase-variant.md", path.join(result.paths.phaseDir, "variant-b.md"), { phase, variant: "b" }],
    ["merged-phase-plan.md", path.join(result.paths.phaseDir, "merged-plan.md"), { phase }],
    ["review.md", path.join(result.paths.phaseDir, "review.md"), { phase }],
  ];

  for (const [templateName, outputPath, variables] of outputs) {
    await materializeTemplate(path.join(templateRoot, templateName), outputPath, variables);
  }

  return {
    ...result,
    generated: outputs.map(([, outputPath]) => path.relative(projectRoot, outputPath)),
    trackerBacked,
    // Each refusal names the rule it upholds (AC6, #1628). The tracker-backed
    // durable phase-doc mint is refused by making the caller aware of the rule
    // it upholds (ARTIFACT-TRACKER-FIRST-NO-DUP) rather than dropping the file
    // silently.
    refusals: trackerBacked
      ? [{ rule: "ARTIFACT-TRACKER-FIRST-NO-DUP", reason: "tracker-backed (issue-keyed) worktree; refusing durable phase-doc mint" }]
      : [],
  };
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  const result = await initializePhase(options.projectRoot, options.phase, options.patch);
  process.stdout.write(
    `${JSON.stringify({ ok: true, phase: result.paths.phase, generated: result.generated })}\n`,
  );
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsScript) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
