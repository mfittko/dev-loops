import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { matchesGlob } from "../analysis/diff-analyzer.mjs";
import { ValidationConfig } from "../config/config.mjs";
export { classifyValidationCommand } from "./bash-command-classify.mjs";

// The `.devloops` family in loader order (the list DEVLOOPS_CONFIG_PATHS holds in scripts/loop/check-adr-tripwire.mjs; core cannot import scripts).
const DEVLOOPS_FAMILY = [".devloops", ".devloops.yaml", ".devloops.yml", ".devloops.json"];
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

/**
 * Read `validation.paths` from the first existing `.devloops` family file in
 * `<repoRoot>` (sync, schema-checked; `.json` parses as JSON, the rest as YAML).
 * An absent or malformed file yields no rules, so every path needs full
 * validation. `repoRoot` is required: no cwd-dependent lookup.
 */
export function readValidationPaths(repoRoot) {
  if (typeof repoRoot !== "string" || repoRoot === "") throw new TypeError("readValidationPaths requires an explicit repoRoot");
  try {
    const name = DEVLOOPS_FAMILY.find((candidate) => existsSync(join(repoRoot, candidate)));
    if (!name) return [];
    const parse = name.endsWith(".json") ? JSON.parse : parseYaml;
    const parsed = ValidationConfig.safeParse(parse(readFileSync(join(repoRoot, name), "utf8"))?.validation);
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
