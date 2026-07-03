#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync, constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeReadiness,
  executeDevLoopsCommand,
  renderCheckLines,
  summarizeChecks,
  DEV_LOOP_CHECK_IDS,
} from "../lib/dev-loops-core.mjs";
import { isUsageError, buildCorrectedArgs } from "@dev-loops/core/cli/retry-wrapper";
import { createPiAdapter } from "@dev-loops/core/harness";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

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
  reconcile: "Reconcile board Status columns from live GitHub state (idempotent)",
};
const { run: _queueRunDescription, ...PROJECT_DESCRIPTIONS } = QUEUE_DESCRIPTIONS;

const SUBCOMMAND_ROUTES = {
  gate: {
    "upsert-verdict":     "scripts/github/upsert-checkpoint-verdict.mjs",
    "detect-evidence":    "scripts/github/detect-checkpoint-evidence.mjs",
    "write-findings-log": "scripts/github/write-gate-findings-log.mjs",
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
  },
  pr: {
    create:             "scripts/github/create-pr.mjs",
    "ready-for-review": "scripts/github/ready-for-review.mjs",
    "reconcile-draft":  "scripts/github/reconcile-draft-gate.mjs",
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
  queue: "Queue board: run + management (add/list/reorder/move/sync-status/archive)",
  project: "Alias for queue (GitHub Projects queue helpers)",
  inspect: "Inspection (Pi extension only)",
  refine: "Epic tree refinement verification",
};

const TOP_LEVEL_HELP_CATEGORY_ORDER = ["gate", "loop", "pr", "queue", "project", "inspect", "refine"];

const SUBCOMMAND_DESCRIPTIONS = {
  gate: {
    "upsert-verdict": "Post/update gate review comment",
    "detect-evidence": "Check merge preconditions",
    "write-findings-log": "Write disposition ledger",
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
  },
  pr: {
    create: "Create PR (always draft, self-assigned by default)",
    "ready-for-review": "Mark PR ready for review",
    "reconcile-draft": "Reconcile non-draft PR",
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

const CLI_SETUP_GUIDANCE = {
  "gh-installed": "Install GitHub CLI to enable remote GitHub/Copilot workflows.",
  "gh-auth": "Run `gh auth login` so remote GitHub/Copilot workflows can use your GitHub session.",
  "subagent-command": "Install or enable subagent support so the `subagent` command is available.",
  "git-repo": "Run the command from a git repository checkout before using repo-scoped workflows.",
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
    "Run via `npx dev-loops` (or `npm install -g dev-loops` for the shell command); see the",
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
  const steps = [...new Set(DEV_LOOP_CHECK_IDS.filter((id) => byId.get(id)?.ok === false).map((id) => CLI_SETUP_GUIDANCE[id]))];
  if (steps.length > 0) return steps.map((step, i) => `${i + 1}. ${step}`);
  return [
    "1. Use `/dev-loop` (Claude Code) or `/skill:dev-loop` (Pi) to start or continue a dev loop — the single public entry.",
    "2. Run `dev-loops status` whenever you want a concise readiness snapshot.",
    "3. Run via `npx dev-loops` (or `npm install -g dev-loops` for the shell command); see the README for Pi-extension and Claude Code plugin setup.",
  ];
}

function writeLines(stream, lines) { stream.write(`${lines.join("\n")}\n`); }

export function createCliRuntime({
  adapter = createPiAdapter(),
  cwd, searchPath,
  platform, pathExt,
} = {}) {
  const effectiveCwd = cwd ?? adapter.getCwd();
  const effectiveSearchPath = searchPath ?? adapter.getEnv().PATH ?? "";
  const effectivePlatform = platform ?? process.platform;
  const effectivePathExt = pathExt ?? adapter.getEnv().PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
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
      if (fromTop.deprecationNotice) { writeLines(stderr, [fromTop.deprecationNotice]); }
      const result = spawnSync("node", [fromTop.scriptPath, "--help"], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.stdout) stdout.write(result.stdout);
      if (result.stderr) stderr.write(result.stderr);
      return result.status ?? (result.signal ? 1 : result.error ? 1 : 0);
    }
    case "action": {
      const activeRuntime = runtime ?? createCliRuntime({ adapter: createPiAdapter({ cwd }), cwd });
      const result = await executeDevLoopsCommand({ input: argv, surface: "cli", runtime: activeRuntime, stdout });
      switch (result.kind) {
        case "help": { writeLines(stdout, buildCliHelpLines()); return 0; }
        case "checks": {
          const summary = summarizeChecks(result.checks);
          const readiness = describeReadiness(result.checks);
          const lines = [
            `dev-loops ${result.action}: ${summary.ok}/${summary.total} checks passed`,
            `Local loop readiness: ${readiness.localReady ? "ready" : "needs setup"}`,
            `Remote GitHub/Copilot readiness: ${readiness.remoteReady ? "ready" : "needs setup"}`,
          ];
          if (result.action === "status") { lines.push("Suggested next steps:", ...orderedCliSetupSteps(result.checks)); }
          else { lines.push(...renderCheckLines(result.checks)); }
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
      if (fromTop.deprecationNotice) { writeLines(stderr, [fromTop.deprecationNotice]); }
      const scriptArgs = fromTop.forwardedArgs || [];
      const result = spawnSync("node", [fromTop.scriptPath, ...scriptArgs], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      // Retry on usage/flag errors: parse usage for valid flags, retry once (#483)
      if (result.status !== 0 && isUsageError(result.stderr)) {
        const correctedArgs = buildCorrectedArgs(scriptArgs, result.stderr);
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
