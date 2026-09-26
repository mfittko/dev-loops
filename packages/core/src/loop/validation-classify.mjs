import { verificationCommandSegments } from "./bash-command-classify.mjs";

const COMPONENT_SUITES = new Set(["test:core", "test:scripts", "test:assets", "test:extension", "test:dev-loop", "test:pack", "test:docs", "test:workflows"]);
const FULL_SUITES = ["test:all", "test:docs", "test:workflows"];

/** Classify a shell command's validation reach, including compound commands. */
export function classifyValidationCommand(command) {
  const suites = new Set();
  let targeted = false;
  for (const segment of verificationCommandSegments(command)) {
    const bunTest = segment.match(/^bun\s+test(?:\s+(.*))?$/i);
    if (bunTest) {
      if (!bunTest[1] || /^--(?:coverage|all)(?:\s|$)/.test(bunTest[1])) return "full-repository";
      targeted = true;
      continue;
    }
    const packageRun = segment.match(/^(?:bun|npm|pnpm|yarn)(?:\s+--\S+)*\s+(?:run\s+)?(test(?::[\w-]+)*|verify(?::[\w-]+)*|build(?::[\w-]+)*|assets:check|schema:check)(?:\s|$)/i);
    if (packageRun) {
      const name = packageRun[1].toLowerCase();
      if (["test", "verify"].includes(name)) return "full-repository";
      suites.add(name);
      targeted = true;
      continue;
    }
    if (/^(?:bun|node)\s+scripts\/verify\.mjs(?:\s|$)/.test(segment)) return "full-repository";
    if (/^(?:bun|node)\s+scripts\/run-bun-test\.mjs(?:\s|$)/.test(segment)) {
      if (/(?:^|\s)--all(?:\s|$)/.test(segment)) suites.add("test:all");
      targeted = true;
      continue;
    }
    const direct = segment.match(/^(?:bun\s+test|node\s+--test|(?:npx|bunx|bun\s+x)?\s*vitest)(?:\s+(.*))?$/i);
    if (direct) {
      if (!direct[1] || /^(?:run|--coverage)\s*$/.test(direct[1])) return "full-repository";
      targeted = true;
    }
  }
  if (FULL_SUITES.every((suite) => suites.has(suite)) || [...COMPONENT_SUITES].every((suite) => suites.has(suite))) return "full-repository";
  return targeted ? "targeted" : "non-validation";
}

/** Pick an existing domain check for a single changed surface; mixed/unknown needs full ownership. */
export function resolveTargetedValidation(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return { profile: "full-repository", commands: [] };
  const checks = paths.map((path) => {
    if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("..") || path.includes("\\")) return null;
    if (/^packages\/core\/test\/[^/]+\.test\.mjs$/.test(path)) return ["core", `bun scripts/run-bun-test.mjs ${path}`];
    if (path.startsWith("packages/core/")) return ["core", "bun run test:core"];
    if (/^test\/(?:loop|github|docs|projects|pages|security)\/[^/]+\.test\.mjs$/.test(path)) return ["scripts", `bun scripts/run-bun-test.mjs ${path}`];
    if (path.startsWith("scripts/loop/inspect-run-viewer/")) return ["ui", "bun run test:playwright:viewer"];
    if (path.startsWith("scripts/") || path.startsWith("cli/") || path.startsWith("lib/")) return ["scripts", "bun run test:scripts"];
    if (path.startsWith("skills/docs/") || path.startsWith("docs/") || path === "AGENTS.md" || path === "README.md") return ["docs", "bun run test:docs", "bun run test:doc-guard"];
    if (path.startsWith(".github/workflows/")) return ["workflow", "bun run test:workflows"];
    if (path.startsWith("extension/")) return ["extension", "bun run test:extension"];
    if (path.startsWith(".claude/") || path.startsWith("agents/") || path.startsWith("commands/") || path.startsWith("skills/dev-loop/templates/")) return ["generated", "bun run assets:check", "bun run test:assets"];
    if (path.startsWith("test/playwright/") && path.endsWith(".spec.mjs")) return ["ui", "bun run test:playwright:viewer"];
    return null;
  });
  const surfaces = new Set(checks.map((check) => check?.[0]));
  if (surfaces.size !== 1 || surfaces.has(undefined)) return { profile: "full-repository", commands: [] };
  return { profile: "targeted", commands: [...new Set(checks.flatMap((check) => check.slice(1)))] };
}
