#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync, readFileSync, constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeReadiness,
  executeDevLoopsCommand,
  renderCheckLines,
  summarizeChecks,
  DEV_LOOP_CHECK_IDS,
  SETUP_GUIDANCE,
} from "../lib/dev-loops-core.mjs";

// Zero-dep preflight: a Claude Code plugin marketplace checkout ships
// `.claude/` (and this `cli/`) with no `node_modules` — no install hook runs.
// `@dev-loops/core` must therefore NEVER be a static top-level import here: that
// crashes module load with a raw ERR_MODULE_NOT_FOUND before a single line of
// output. `isCoreResolvable()` is a resolve-only probe (no module execution);
// every call site that actually needs core dynamically imports it AFTER
// confirming resolvability, so the only failure mode left is this one
// friendly line + non-zero exit.
function isCoreResolvable() {
  try {
    import.meta.resolve("@dev-loops/core/harness");
    return true;
  } catch {
    return false;
  }
}

const CORE_UNRESOLVABLE_DETAIL =
  "`@dev-loops/core` is not installed in this checkout (a deps-less plugin/marketplace checkout) — " +
  "run via `npx dev-loops@<version>` (or `npm i -g dev-loops`) instead of local scripts.";

function writeCoreUnresolvableError(stderr) {
  writeLines(stderr, [`[dev-loops] ${CORE_UNRESOLVABLE_DETAIL}`]);
  return 1;
}

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── Stale-install self-diagnosis (`doctor`) ────────────────────────
// A dangling scripts/ reference or an unexplained tooling failure is often
// actually a stale global/local `dev-loops` install shadowing a newer
// checkout. `doctor` names its own running version + resolved install path
// and — best-effort — whether it is behind the latest published release, so
// that class of report self-diagnoses instead of masquerading as a bug.

function readOwnVersion(pkgPath = path.join(REPO_ROOT, "package.json")) {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

// Split off build metadata (ignored for precedence per SemVer) and the
// prerelease suffix, e.g. "1.0.0-rc.3+abc" -> { core: "1.0.0", prerelease: "rc.3" }.
function splitVersion(version) {
  const withoutBuild = String(version).split("+")[0];
  const dashIndex = withoutBuild.indexOf("-");
  return dashIndex === -1
    ? { core: withoutBuild, prerelease: null }
    : { core: withoutBuild.slice(0, dashIndex), prerelease: withoutBuild.slice(dashIndex + 1) };
}

function compareCoreVersions(a, b) {
  const numsA = a.split(".").map(Number);
  const numsB = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (numsA[i] || 0) - (numsB[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// SemVer prerelease precedence: compare dot-separated identifiers left to
// right; numeric identifiers compare numerically, a shorter identifier list
// is lower, numeric identifiers are always lower than alphanumeric ones.
function comparePrereleaseIdentifiers(a, b) {
  const idsA = a.split(".");
  const idsB = b.split(".");
  const len = Math.max(idsA.length, idsB.length);
  for (let i = 0; i < len; i++) {
    const idA = idsA[i];
    const idB = idsB[i];
    if (idA === undefined) return -1;
    if (idB === undefined) return 1;
    const numA = /^\d+$/.test(idA) ? Number(idA) : null;
    const numB = /^\d+$/.test(idB) ? Number(idB) : null;
    if (numA !== null && numB !== null) {
      if (numA !== numB) return numA < numB ? -1 : 1;
      continue;
    }
    if (numA !== null) return -1;
    if (numB !== null) return 1;
    if (idA !== idB) return idA < idB ? -1 : 1;
  }
  return 0;
}

// -1/0/1 per SemVer 2.0.0 precedence rules (build metadata ignored).
// Exported for direct unit testing (prerelease ordering, malformed input).
export function compareSemver(a, b) {
  const va = splitVersion(a);
  const vb = splitVersion(b);
  const coreDiff = compareCoreVersions(va.core, vb.core);
  if (coreDiff !== 0) return coreDiff;
  if (va.prerelease === vb.prerelease) return 0;
  if (va.prerelease === null) return 1; // a stable release outranks any prerelease
  if (vb.prerelease === null) return -1;
  return comparePrereleaseIdentifiers(va.prerelease, vb.prerelease);
}

// Shape/length gate a registry-controlled dist-tag value must pass before it
// can reach compareSemver's max-reduction or doctor's stdout: a plain
// `x.y.z` numeric core (splitVersion already strips any prerelease/build
// suffix off the core check) AND, since that core check alone leaves the
// prerelease/build suffix unvalidated, the WHOLE string must also match
// SemVer's own identifier charset. Rejects control/escape bytes, empty/
// absurdly long strings, and non-numeric cores — the class of value that
// otherwise coerces to 0.0.0 in compareCoreVersions (`Number("x") || 0`) or
// gets echoed verbatim into doctor's output.
export function isPlausibleDistTagVersion(v) {
  if (typeof v !== "string" || v.length === 0 || v.length > 64) return false;
  if (!/^\d+\.\d+\.\d+$/.test(splitVersion(v).core)) return false;
  return /^[0-9A-Za-z.+-]+$/.test(v);
}

const REGISTRY_TIMEOUT_MS = 2000;
const REGISTRY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// ponytail: bare `https.get` (no `fetch`/dependency) keeps `doctor` zero-dep;
// resolves null (never rejects) on any failure so a flaky/offline registry
// degrades the freshness check instead of ever crashing `doctor`.
// `getImpl` is an injectable https.get seam so tests can drive the
// status/size-cap/deadline/dist-tag paths without network.
export function fetchLatestPublishedVersion(packageName, { timeoutMs = REGISTRY_TIMEOUT_MS, getImpl = https.get } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let deadline;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };
    // The abbreviated packument's dist-tags, not /latest: a prerelease line
    // (dist-tag `rc`) can be ahead of `latest`, and an rc install behind the
    // rc tag must still warn. The freshest published version is the MAX
    // across all dist-tags.
    const req = getImpl(`https://registry.npmjs.org/${packageName}`, {
      timeout: timeoutMs,
      headers: { accept: "application/vnd.npm.install-v1+json" },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); settle(null); return; }
      let body = "";
      let bodyBytes = 0;
      res.on("data", (chunk) => {
        bodyBytes += chunk.length;
        // Response-size cap: `timeout` above is a socket INACTIVITY timeout, so
        // an endpoint that keeps trickling bytes would otherwise let `body`
        // grow unbounded. Abort and degrade rather than accumulate forever.
        if (bodyBytes > REGISTRY_MAX_RESPONSE_BYTES) {
          req.destroy();
          settle(null);
          return;
        }
        body += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          const tagVersions = Object.values(parsed?.["dist-tags"] ?? {}).filter(isPlausibleDistTagVersion);
          if (tagVersions.length === 0) { settle(null); return; }
          settle(tagVersions.reduce((max, v) => (compareSemver(v, max) > 0 ? v : max)));
        } catch {
          settle(null);
        }
      });
    });
    req.on("timeout", () => { req.destroy(); settle(null); });
    req.on("error", () => settle(null));
    // Wall-clock deadline: `timeout` above only fires on socket INACTIVITY, so
    // a slow-drip response that keeps resetting it would otherwise hang this
    // promise (and `doctor`) indefinitely. This is a hard ceiling regardless
    // of activity.
    deadline = setTimeout(() => { req.destroy(); settle(null); }, timeoutMs);
  });
}

async function buildStaleInstallChecks({
  currentVersion = readOwnVersion(),
  installPath = REPO_ROOT,
  packageName = "dev-loops",
  fetchLatestVersion = fetchLatestPublishedVersion,
} = {}) {
  const infoCheck = {
    id: "install-info",
    label: "Running package version & install layout",
    ok: true,
    detail: currentVersion
      ? `Running dev-loops@${currentVersion} from ${installPath}.`
      : `Could not read this install's package.json at ${installPath}; running version unknown.`,
  };

  const skip = (detail) => [infoCheck, { id: "install-freshness", label: "Install freshness", ok: true, detail }];

  // ponytail: hermeticity escape hatch for tests — skip the real registry
  // probe entirely rather than relying on every caller to inject a stub
  // fetcher. Set by test/cli-deps-less-checkout-preflight.test.mjs so the
  // verify suite never makes a live network call.
  if (process.env.DEVLOOPS_SKIP_REGISTRY_CHECK) {
    return skip("latest-version check skipped (DEVLOOPS_SKIP_REGISTRY_CHECK set).");
  }

  if (!currentVersion) return skip("latest-version check skipped (running version unknown).");

  let latestVersion = null;
  try {
    latestVersion = await fetchLatestVersion(packageName);
  } catch {
    latestVersion = null;
  }
  if (!latestVersion) return skip("latest-version check skipped (registry unreachable).");

  const isStale = compareSemver(currentVersion, latestVersion) < 0;
  return [infoCheck, {
    id: "install-freshness",
    label: "Install freshness",
    ok: !isStale,
    detail: isStale
      ? `Running dev-loops@${currentVersion}; latest published is ${latestVersion} — a stale install can masquerade as a tooling bug. Update via \`npx dev-loops@latest\` or \`npm i -g dev-loops@latest\`.`
      : `Running the latest published version (${currentVersion}).`,
  }];
}

// `project` is an alias for `queue` minus the run driver — derived, not duplicated.
const QUEUE_ROUTES = {
  run:            "scripts/loop/run-queue.mjs",
  list:    "scripts/projects/list-queue-items.mjs",
  add:     "scripts/projects/add-queue-item.mjs",
  move:    "scripts/projects/move-queue-item.mjs",
  reorder: "scripts/projects/reorder-queue-item.mjs",
  "archive-done": "scripts/projects/archive-done-items.mjs",
  "sync-status": "scripts/projects/sync-item-status.mjs",
  ensure:  "scripts/projects/ensure-queue-board.mjs",
  "resolve-active": "scripts/projects/resolve-active-board-item.mjs",
  "parked-unrefined": "scripts/projects/list-parked-unrefined-items.mjs",
  reconcile: "scripts/projects/reconcile-queue.mjs",
};
const { run: _queueRunRoute, ...PROJECT_ROUTES } = QUEUE_ROUTES;

const QUEUE_DESCRIPTIONS = {
  run: "Run queue driver",
  list: "List queue board items",
  add: "Add issue/PR to queue board",
  move: "Move queue item between Status columns",
  reorder: "Reorder items (move-to-top/move-after/order, --dry-run)",
  "archive-done": "Archive closed Done items older than a duration",
  "sync-status": "Sync a queued issue/PR's board Status column (best-effort)",
  ensure: "Create/repair queue board bootstrap surface",
  "parked-unrefined": "List parked issues awaiting auto-refine (un-refined, in the park column)",
  reconcile: "Reconcile board Status columns from live GitHub state (idempotent)",
};
const { run: _queueRunDescription, ...PROJECT_DESCRIPTIONS } = QUEUE_DESCRIPTIONS;

const SUBCOMMAND_ROUTES = {
  gate: {
    "upsert-verdict":     "scripts/github/upsert-checkpoint-verdict.mjs",
    "detect-evidence":    "scripts/github/detect-checkpoint-evidence.mjs",
    "consolidate-fanin":  "scripts/loop/consolidate-fanin.mjs",
    "write-findings-log": "scripts/github/write-gate-findings-log.mjs",
    "judge-pass":         "scripts/loop/judge-pass.mjs",
    "post-findings":      "scripts/github/post-gate-findings.mjs",
    "request-copilot":    "scripts/github/request-copilot-review.mjs",
    "probe-copilot":      "scripts/github/probe-copilot-review.mjs",
    "capture-threads":    "scripts/github/capture-review-threads.mjs",
    "reply-resolve":      "scripts/github/reply-resolve-review-threads.mjs",
    "offer-human-handoff": "scripts/github/offer-human-handoff.mjs",
  },
  loop: {
    startup:        "scripts/loop/resolve-dev-loop-startup.mjs",
    "build-envelope": "scripts/loop/build-handoff-envelope.mjs",
    outer:          "scripts/loop/outer-loop.mjs",
    "watch-cycle":  "scripts/loop/run-watch-cycle.mjs",
    "watch-ci":     "scripts/github/probe-ci-status.mjs",
    handoff:        "scripts/loop/copilot-pr-handoff.mjs",
    "watch-initial": "scripts/loop/watch-initial-copilot-pr.mjs",
    "loop-state":           "scripts/loop/detect-copilot-loop-state.mjs",
    "reviewer-state":       "scripts/loop/detect-reviewer-loop-state.mjs",
    "gate-coordination":    "scripts/loop/detect-pr-gate-coordination-state.mjs",
    "linked-issue-pr":      "scripts/github/detect-linked-issue-pr.mjs",
    "info":                  "scripts/loop/info.mjs",
    "issue-refinement":     "scripts/loop/detect-issue-refinement-artifact.mjs",
    "debt-remediate":       "scripts/loop/debt-remediate.mjs",
    "pre-flight-gate":      "scripts/loop/pre-flight-gate.mjs",
    "ensure-worktree":      "scripts/loop/ensure-worktree.mjs",
    "ui-review-provision":  "scripts/loop/ui-review-provision.mjs",
    "ui-review-drive":      "scripts/loop/ui-review-drive.mjs",
    "ui-review-diagnose":   "scripts/loop/ui-review-diagnose.mjs",
    "ui-review-report":     "scripts/loop/ui-review-report.mjs",
    "ui-review-teardown":   "scripts/loop/ui-review-teardown.mjs",
    "visual-grill-capture": "scripts/loop/visual-grill-capture.mjs",
  },
  pr: {
    create:             "scripts/github/create-pr.mjs",
    "ready-for-review": "scripts/github/ready-for-review.mjs",
    "reconcile-draft":  "scripts/github/reconcile-draft-gate.mjs",
  },
  issue: {
    edit:   "scripts/github/edit-issue.mjs",
    create: "scripts/github/create-issue.mjs",
  },
  queue: QUEUE_ROUTES,
  project: PROJECT_ROUTES,
  inspect: {
    run:    "scripts/loop/inspect-run.mjs",
    viewer: "scripts/loop/inspect-run-viewer.mjs",
  },
  refine: {
    verify: "scripts/refine/verify.mjs",
  },
};

// Back-compat subcommand aliases: { category: { oldName: { canonical, notice } } }.
// Aliases keep existing callers working while emitting a one-line deprecation
// notice to stderr so they migrate to the canonical subcommand.
const SUBCOMMAND_ALIASES = {
  pr: {
    "create-draft": {
      canonical: "create",
      notice: "[dev-loops] `pr create-draft` is deprecated; use `pr create` (always draft, self-assigned by default).",
    },
  },
};

function resolveSubcommandAlias(category, subcommand) {
  return SUBCOMMAND_ALIASES[category]?.[subcommand] ?? null;
}

const TOP_LEVEL_COMMANDS = new Set(["help", "status", "doctor", "gates", "hide"]);

const HELP_CATEGORY_LABELS = {
  gate: "Gate verdicts, evidence, and review operations",
  loop: "Loop lifecycle",
  pr: "PR helpers",
  issue: "Issue helpers",
  queue: "Queue board: run + management (add/list/reorder/move/sync-status/archive)",
  project: "Alias for queue (GitHub Projects queue helpers)",
  inspect: "Inspection (Pi extension only)",
  refine: "Epic tree refinement verification",
};

const TOP_LEVEL_HELP_CATEGORY_ORDER = ["gate", "loop", "pr", "issue", "queue", "project", "inspect", "refine"];

const SUBCOMMAND_DESCRIPTIONS = {
  gate: {
    "upsert-verdict": "Post/update gate review comment",
    "detect-evidence": "Check merge preconditions",
    "consolidate-fanin": "Consolidate per-angle findings artifacts",
    "write-findings-log": "Write disposition ledger",
    "judge-pass": "Derive the fixer act list from the judge verdict (fan-in → judge → fixer)",
    "post-findings": "Post gate fan-out findings comment",
    "request-copilot": "Request Copilot review",
    "probe-copilot": "Poll for Copilot review activity",
    "capture-threads": "Capture review threads",
    "reply-resolve": "Reply and resolve review threads",
    "offer-human-handoff": "Offer to assign PR to a human reviewer/assignee",
  },
  loop: {
    startup: "Resolve dev-loop startup bundle",
    "build-envelope": "Build handoff envelope from startup output",
    outer: "Run outer-loop detection",
    "watch-cycle": "Run Copilot wait cycle",
    "watch-ci": "Block-wait on provider-agnostic CI (CircleCI/Actions/external)",
    handoff: "Copilot PR handoff",
    "watch-initial": "Watch initial Copilot PR",
    "loop-state": "Detect Copilot loop state",
    "reviewer-state": "Detect reviewer loop state",
    "gate-coordination": "Detect PR gate coordination state",
    "linked-issue-pr": "Detect linked issue ↔ PR",
    "issue-refinement": "Detect issue refinement artifact",
    info: "Show read-only issue/PR state summary",
    "debt-remediate": "File debt remediation issues",
    "pre-flight-gate": "Gate local implementation mutations before planning or editing",
    "ensure-worktree": "Create/reuse and provision a loop-owned worktree",
    "ui-review-provision": "Provision an isolated worktree + boot the app for a UI review",
    "ui-review-drive": "Drive a headless browser through the PR's changed UI surfaces",
    "ui-review-diagnose": "Classify UI-review drive errors and anchor findings to the diff",
    "ui-review-report": "Post the UI-review findings as a pending PR review",
    "ui-review-teardown": "Tear down the UI-review worktree/app and emit the side-effect ledger",
    "visual-grill-capture": "Drive a headless browser to a described screen and capture it for loop-grill",
  },
  pr: {
    create: "Create PR (always draft, self-assigned by default)",
    "ready-for-review": "Mark PR ready for review",
    "reconcile-draft": "Reconcile non-draft PR",
  },
  issue: {
    edit: "Edit issue title/body/assignees/milestone/state (close/reopen)",
    create: "Create an issue",
  },
  queue: QUEUE_DESCRIPTIONS,
  project: PROJECT_DESCRIPTIONS,
  inspect: {
    run: "Inspect run state",
    viewer: "Start inspection viewer",
  },
  refine: {
    verify: "Verify epic tree refinement integrity",
  },
};

function spawnResult(command, args, options = {}) {
  try {
    const result = spawnSync(command, args, { encoding: "utf8", ...options });
    return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch {
    return { ok: false, stdout: "", stderr: "" };
  }
}

function executableCandidates(command, platform, pathExt) {
  if (platform !== "win32") return [command];
  if (path.extname(command)) return [command];
  const extensions = [...new Set(pathExt.split(";").map((e) => e.trim()).filter(Boolean))];
  return extensions.map((ext) => `${command}${ext}`);
}

async function commandExists(
  command,
  { searchPath = process.env.PATH ?? "", platform = process.platform, pathExt = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD" } = {},
) {
  if (/[\\/]/.test(command)) return false;
  const accessMode = platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
  for (const entry of searchPath.split(path.delimiter)) {
    if (!entry) continue;
    for (const candidateName of executableCandidates(command, platform, pathExt)) {
      try { await access(path.join(entry, candidateName), accessMode); return true; } catch { /* continue */ }
    }
  }
  return false;
}

function buildSubcommandLines(category, { includeHeader = false } = {}) {
  const routes = SUBCOMMAND_ROUTES[category];
  if (!routes) return [];
  const descriptions = SUBCOMMAND_DESCRIPTIONS[category] ?? {};
  const lines = Object.keys(routes).map((subcommand) => {
    const description = descriptions[subcommand];
    return description ? `    ${subcommand.padEnd(16)} ${description}` : `    ${subcommand}`;
  });
  if (!includeHeader) return lines;
  const label = HELP_CATEGORY_LABELS[category] ?? `${category} helpers`;
  return [`- dev-loops ${category} <sub> [...]    ${label}`, ...lines];
}

function buildCategoryHelp(category) {
  const routes = SUBCOMMAND_ROUTES[category];
  if (!routes) return [`Unknown category: ${category}`];
  return [
    `dev-loops ${category} <subcommand> [...]`,
    "",
    "Available subcommands:",
    ...buildSubcommandLines(category),
  ];
}

function buildCliHelpLines() {
  return [
    "dev-loops help",
    "",
    "Workflow entry:",
    "- `/dev-loop` (Claude Code) or `/skill:dev-loop` (Pi) — single public entrypoint; routing handles the rest",
    "",
    "Commands:",
    "- dev-loops help                   Show this help",
    "- dev-loops status                 Show readiness snapshot",
    "- dev-loops doctor                 Show full diagnostic checks",
    "- dev-loops gates                  Print gate state",
    "",
    "Subcommands:",
    ...TOP_LEVEL_HELP_CATEGORY_ORDER.flatMap((category) => buildSubcommandLines(category, { includeHeader: true })),
    "",
    "Use `dev-loops <category> <subcommand> --help` for per-subcommand usage.",
    "",
    "`/dev-loops hide` remains an extension-only Pi command.",
    "Run via `npx dev-loops@<version>` pinned to your plugin/extension version (a global",
    "`npm install -g dev-loops` can drift and is not the supported invocation path); see the",
    "README for Pi-extension and Claude Code plugin setup.",
  ];
}

function buildCliUsageLines(action) {
  switch (action) {
    case "help": case "status": case "doctor": case "gates":
      return ["Usage:", `- dev-loops ${action}`];
    case "hide":
      return ["Usage:", "- dev-loops hide", "`hide` is only supported without extra arguments, and only inside the Pi extension."];
    default:
      throw new Error(`Unknown CLI usage action: ${action}`);
  }
}

function orderedCliSetupSteps(checks) {
  const byId = new Map(checks.map((c) => [c.id, c]));
  const steps = [...new Set(DEV_LOOP_CHECK_IDS.filter((id) => byId.get(id)?.ok === false).map((id) => SETUP_GUIDANCE[id]))];
  if (steps.length > 0) return steps.map((step, i) => `${i + 1}. ${step}`);
  return [
    "1. Use `/dev-loop` (Claude Code) or `/skill:dev-loop` (Pi) to start or continue a dev loop — the single public entry.",
    "2. Run `dev-loops status` whenever you want a concise readiness snapshot.",
    "3. Run via `npx dev-loops@<version>` pinned to your plugin/extension version (a global `npm install -g dev-loops` can drift and is not the supported invocation path); see the README for Pi-extension and Claude Code plugin setup.",
  ];
}

function writeLines(stream, lines) { stream.write(`${lines.join("\n")}\n`); }

export function createCliRuntime({
  cwd, searchPath,
  platform, pathExt,
} = {}) {
  const effectiveCwd = cwd ?? process.cwd();
  const effectiveSearchPath = searchPath ?? process.env.PATH ?? "";
  const effectivePlatform = platform ?? process.platform;
  const effectivePathExt = pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return {
    surface: "cli",
    cwd: effectiveCwd,
    async commandExists(command) { return commandExists(command, { searchPath: effectiveSearchPath, platform: effectivePlatform, pathExt: effectivePathExt }); },
    async ghAuthOk() { return spawnResult("gh", ["auth", "status"], { cwd: effectiveCwd }).ok; },
    async insideGitRepo() { return spawnResult("git", ["rev-parse", "--is-inside-work-tree"], { cwd: effectiveCwd }).ok; },
    async getSubagentAvailability() {
      const ok = await commandExists("subagent", { searchPath: effectiveSearchPath, platform: effectivePlatform, pathExt: effectivePathExt });
      return { ok, availableDetail: "`subagent` command is available.", unavailableDetail: "Install or enable subagent support so `subagent` is available." };
    },
  };
}

// ── Subcommand routing dispatch ────────────────────────────────────

function resolveSubcommandRoute(args) {
  if (args.length === 0) return null;
  const category = args[0];
  const routes = SUBCOMMAND_ROUTES[category];
  if (!routes) return null;

  if (args.length < 2) {
    const subs = Object.keys(routes).join(", ");
    return { error: `Missing subcommand for '${category}'. Available: ${subs}` };
  }

  const requestedSubcommand = args[1];
  const alias = resolveSubcommandAlias(category, requestedSubcommand);
  const subcommand = alias ? alias.canonical : requestedSubcommand;
  const scriptPath = routes[subcommand];
  if (!scriptPath) {
    const subs = Object.keys(routes).join(", ");
    return { error: `Unknown subcommand '${requestedSubcommand}' for '${category}'. Available: ${subs}` };
  }

  return {
    scriptPath: path.resolve(REPO_ROOT, scriptPath),
    forwardedArgs: args.slice(2),
    ...(alias ? { deprecationNotice: alias.notice } : {}),
  };
}

function parseTopLevelCommand(argv) {
  const args = [...argv];
  if (args.length === 0) return { kind: "help" };

  const [cmd, sub] = args;

  // Bare --help / -h
  if (cmd === "--help" || cmd === "-h") return { kind: "help" };

  // Top-level commands
  if (TOP_LEVEL_COMMANDS.has(cmd)) {
    if (args.some((a) => a === "--help" || a === "-h")) return { kind: "help" };
    if (args.length > 1) return { kind: "malformed", message: `\`${cmd}\` does not accept additional arguments.`, usageAction: cmd };
    return { kind: "action", action: cmd };
  }

  // Subcommand routing
  const routes = SUBCOMMAND_ROUTES[cmd];
  if (routes) {
    // If second arg is --help/-h or missing, show category help
    if (!sub || sub === "--help" || sub === "-h") {
      return { kind: "category_help", category: cmd };
    }
    // Check if any remaining arg is --help — delegate to script
    if (args.slice(1).some((a) => a === "--help" || a === "-h")) {
      const alias = resolveSubcommandAlias(cmd, sub);
      const resolvedSub = alias ? alias.canonical : sub;
      const scriptPath = routes[resolvedSub];
      if (!scriptPath) return { kind: "category_help", category: cmd };
      return {
        kind: "subcommand_help",
        scriptPath: path.resolve(REPO_ROOT, scriptPath),
        // Surface the deprecation notice on the --help fast-path too, so a
        // deprecated alias signals migration in help mode (not only on dispatch).
        ...(alias ? { deprecationNotice: alias.notice } : {}),
      };
    }
    const route = resolveSubcommandRoute(args);
    if (route) return { kind: "subcommand", ...route };
    return { kind: "category_help", category: cmd };
  }

  // Unknown
  return { kind: "malformed", message: `Unrecognized command: ${cmd}.` };
}

export async function runCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  runtime,
  cwd = process.cwd(),
  // Test-only injection seam for the `doctor` registry freshness check;
  // production callers always take the real `fetchLatestPublishedVersion`.
  fetchLatestVersion,
} = {}) {
  const fromTop = parseTopLevelCommand(argv);

  switch (fromTop.kind) {
    case "help": {
      writeLines(stdout, buildCliHelpLines());
      return 0;
    }
    case "category_help": {
      writeLines(stdout, buildCategoryHelp(fromTop.category));
      return 0;
    }
    case "subcommand_help": {
      // The routed scripts import `@dev-loops/core` at their own top level, so
      // spawning one from a deps-less checkout would ERR_MODULE_NOT_FOUND in the
      // child instead of printing our friendly line — gate before spawning.
      if (!isCoreResolvable()) return writeCoreUnresolvableError(stderr);
      if (fromTop.deprecationNotice) { writeLines(stderr, [fromTop.deprecationNotice]); }
      const result = spawnSync("node", [fromTop.scriptPath, "--help"], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.stdout) stdout.write(result.stdout);
      if (result.stderr) stderr.write(result.stderr);
      return result.status ?? (result.signal ? 1 : result.error ? 1 : 0);
    }
    case "action": {
      // `gates` reads gate config via `@dev-loops/core/config` (through the
      // shared executor); every other top-level action (help/status/doctor) is
      // core-independent and must keep working in a deps-less checkout.
      if (fromTop.action === "gates" && !isCoreResolvable()) {
        return writeCoreUnresolvableError(stderr);
      }
      const activeRuntime = runtime ?? createCliRuntime({ cwd });
      const result = await executeDevLoopsCommand({ input: argv, surface: "cli", runtime: activeRuntime, stdout });
      switch (result.kind) {
        case "help": { writeLines(stdout, buildCliHelpLines()); return 0; }
        case "checks": {
          // `doctor` names @dev-loops/core resolvability explicitly: a deps-less
          // plugin/marketplace checkout can still run `doctor` itself (it needs
          // no core import), so it's the one place that diagnoses the condition
          // the preflight above exits on for every other command.
          const coreOk = isCoreResolvable();
          const checks = result.action === "doctor"
            ? [...result.checks, {
                id: "core-resolvable",
                label: "@dev-loops/core resolvable (local script execution)",
                ok: coreOk,
                detail: coreOk
                  ? "`@dev-loops/core` resolves from this checkout; local scripts can run directly."
                  : CORE_UNRESOLVABLE_DETAIL,
              }, ...await buildStaleInstallChecks({ fetchLatestVersion })]
            : result.checks;
          const summary = summarizeChecks(checks);
          const readiness = describeReadiness(checks);
          const lines = [
            `dev-loops ${result.action}: ${summary.ok}/${summary.total} checks passed`,
            `Local loop readiness: ${readiness.localReady ? "ready" : "needs setup"}`,
            `Remote GitHub/Copilot readiness: ${readiness.remoteReady ? "ready" : "needs setup"}`,
          ];
          if (result.action === "status") { lines.push("Suggested next steps:", ...orderedCliSetupSteps(checks)); }
          else { lines.push(...renderCheckLines(checks)); }
          writeLines(stdout, lines);
          return 0;
        }
        case "unsupported": { writeLines(stderr, [result.message]); return 1; }
        case "gates": { return 0; }
        case "malformed": {
          const lines = [result.message, ...buildCliHelpLines()];
          if (result.usageAction) lines.splice(1, 0, ...buildCliUsageLines(result.usageAction));
          writeLines(stderr, lines);
          return 1;
        }
        default: throw new Error(`Unhandled CLI result: ${result.kind}`);
      }
    }
    case "subcommand": {
      if (fromTop.error) { writeLines(stderr, [fromTop.error]); return 1; }
      // Same as subcommand_help: every routed script imports `@dev-loops/core`.
      if (!isCoreResolvable()) return writeCoreUnresolvableError(stderr);
      if (fromTop.deprecationNotice) { writeLines(stderr, [fromTop.deprecationNotice]); }
      const scriptArgs = fromTop.forwardedArgs || [];
      const result = spawnSync("node", [fromTop.scriptPath, ...scriptArgs], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      // Retry on usage/flag errors: parse usage for valid flags, retry once (#483).
      // Reached only once core is confirmed resolvable above, so this dynamic
      // import (not a top-level one) never throws ERR_MODULE_NOT_FOUND itself.
      const { isUsageError, buildCorrectedArgs, extractUsageText } = result.status !== 0
        ? await import("@dev-loops/core/cli/retry-wrapper")
        : {};
      if (result.status !== 0 && isUsageError(result.stderr)) {
        // An argument error's stderr JSON now carries a short `hint`, not the
        // full usage text (short-error contract), so `buildCorrectedArgs`
        // usually has nothing to extract valid flags from. `--help` still
        // prints the full usage unchanged — fetch it there instead so the
        // auto-correct retry keeps working.
        let usageSource = result.stderr;
        if (!extractUsageText(usageSource)) {
          const helpResult = spawnSync("node", [fromTop.scriptPath, "--help"], {
            cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
          });
          if (helpResult.stdout) usageSource = helpResult.stdout;
        }
        const correctedArgs = buildCorrectedArgs(scriptArgs, usageSource);
        if (correctedArgs && correctedArgs.length > 0) {
          const retryResult = spawnSync("node", [fromTop.scriptPath, ...correctedArgs], {
            cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
          });
          if (retryResult.stdout) stdout.write(retryResult.stdout);
          if (retryResult.stderr) stderr.write(retryResult.stderr);
          return retryResult.status ?? (retryResult.signal ? 1 : retryResult.error ? 1 : 0);
        }
      }
      if (result.stdout) stdout.write(result.stdout);
      if (result.stderr) stderr.write(result.stderr);
      return result.status ?? (result.signal ? 1 : result.error ? 1 : 0);
    }
    case "malformed": {
      const lines = [fromTop.message, ...buildCliHelpLines()];
      if (fromTop.usageAction) lines.splice(1, 0, ...buildCliUsageLines(fromTop.usageAction));
      writeLines(stderr, lines);
      return 1;
    }
    default:
      throw new Error(`Unhandled parse result: ${fromTop.kind}`);
  }
}

const invokedAsScript = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]));
  } catch { return false; }
})();

if (invokedAsScript) {
  process.exitCode = await runCli();
}
