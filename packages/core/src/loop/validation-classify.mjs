import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse as parseYaml } from "yaml";
import { matchesGlob } from "../analysis/diff-analyzer.mjs";
import { ValidationConfig } from "../config/config.mjs";
import { verificationCommandSegments } from "./bash-command-classify.mjs";

const COMPONENT_SUITES = new Set(["test:core", "test:scripts", "test:assets", "test:extension", "test:dev-loop", "test:pack", "test:docs", "test:workflows"]);
const FULL_SUITES = ["test:all", "test:docs", "test:workflows"];
const EXACT_TEST_FILE = /^(?:run\s+)?[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?(?:\s|$)/;

/** Classify a shell command's validation reach, including compound commands. */
export function classifyValidationCommand(command) {
  if (/(?:^|[;&|\n])\s*\.\/scripts\/verify\.mjs(?:\s|$)/.test(command)) return "full-repository";
  const suites = new Set();
  let targeted = false;
  for (const segment of verificationCommandSegments(command)) {
    const scriptPath = segment.match(/^(?:(?:bun|node)\s+)?((?:\.\/)?scripts\/[\w./-]+\.mjs)(?:\s|$)/)?.[1];
    if (scriptPath && posix.normalize(scriptPath) === "scripts/verify.mjs") return "full-repository";
    const bunTest = segment.match(/^bun\s+test(?:\s+(.*))?$/i);
    if (bunTest) {
      if (!EXACT_TEST_FILE.test(bunTest[1] ?? "")) return "full-repository";
      targeted = true;
      continue;
    }
    const packageRun = segment.match(/^(?:bun|npm|pnpm|yarn)(?:\s+(?:(?:--prefix|--dir|--cwd)\s+\S+|--\S+))*\s+(?:run\s+)?(test(?::[\w-]+)*|verify(?::[\w-]+)*|build(?::[\w-]+)*|assets:check|schema:check)(?:\s|$)/i);
    if (packageRun) {
      const name = packageRun[1].toLowerCase();
      if (["test", "verify"].includes(name)) return "full-repository";
      suites.add(name);
      targeted = true;
      continue;
    }
    const runner = segment.match(/^(?:bun|node)\s+scripts\/run-bun-test\.mjs(?:\s+(.*))?$/);
    if (runner) {
      if (/(?:^|\s)--all(?:\s|$)/.test(runner[1] ?? "") || !EXACT_TEST_FILE.test(runner[1] ?? "")) suites.add("test:all");
      targeted = true;
      continue;
    }
    const direct = segment.match(/^(?:node\s+--test|(?:npx|bunx|bun\s+x)?\s*vitest)(?:\s+(.*))?$/i);
    if (direct) {
      if (!EXACT_TEST_FILE.test(direct[1] ?? "")) return "full-repository";
      targeted = true;
    }
  }
  if (FULL_SUITES.every((suite) => suites.has(suite)) || [...COMPONENT_SUITES].every((suite) => suites.has(suite))) return "full-repository";
  return targeted ? "targeted" : "non-validation";
}

const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

/**
 * Read `validation.paths` from `<repoRoot>/.devloops` (sync, schema-checked).
 * An absent or malformed file yields no rules, so every path needs full
 * validation. `repoRoot` is required: no cwd-dependent lookup.
 */
export function readValidationPaths(repoRoot) {
  if (typeof repoRoot !== "string" || repoRoot === "") throw new TypeError("readValidationPaths requires an explicit repoRoot");
  try {
    const parsed = ValidationConfig.safeParse(parseYaml(readFileSync(join(repoRoot, ".devloops"), "utf8"))?.validation);
    return parsed.success ? parsed.data.paths ?? [] : [];
  } catch {
    return [];
  }
}

// The checkout's repo root, so the default lookup does not depend on the cwd.
function checkoutRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined }, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return process.cwd();
  }
}

/**
 * Pick the configured check for a single changed surface; mixed or unmapped
 * paths need full ownership. Without explicit `rules`, they come from the
 * checkout's `.devloops` `validation.paths` (first match wins) at the git repo
 * root, an author-local worker self-check. The gate refuses a checkout
 * `validation` block that differs from the base branch (ADR 0137), so a
 * gate-consumed command or `--suite` never comes from a checkout-only edit.
 */
export function resolveTargetedValidation(paths, rules = readValidationPaths(checkoutRoot())) {
  const full = { profile: "full-repository", commands: [], gateSuites: [] };
  if (!Array.isArray(paths) || paths.length === 0) return full;
  const checks = paths.map((path) => {
    if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("..") || path.includes("\\")) return null;
    const rule = rules.find(({ match }) => [match].flat().some((glob) => matchesGlob(path, glob)));
    if (!rule || rule.commands.length === 0) return null;
    const templated = rule.commands.some((command) => command.includes("{path}"));
    // A leading "-" on the path or any segment would read as an option to the command.
    if (templated && (!SAFE_PATH.test(path) || path.split("/").some((segment) => segment.startsWith("-")))) return null;
    const commands = rule.commands.map((command) => command.replaceAll("{path}", path));
    const gateSuites = [...(rule.gateSuites ?? []), ...commands.filter((c) => c.startsWith("bun run ")).map((c) => c.slice(8))];
    return { surface: rule.surface, commands, gateSuites };
  });
  if (checks.includes(null) || new Set(checks.map((check) => check.surface)).size !== 1) return full;
  const unique = (list) => [...new Set(list)].sort();
  return { profile: "targeted", commands: unique(checks.flatMap((c) => c.commands)), gateSuites: unique(checks.flatMap((c) => c.gateSuites)) };
}
