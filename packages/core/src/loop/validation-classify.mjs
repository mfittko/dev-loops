import { verificationCommandSegments } from "./bash-command-classify.mjs";

const COMPONENT_SUITES = new Set(["test:core", "test:scripts", "test:assets", "test:extension", "test:dev-loop", "test:pack", "test:docs", "test:workflows"]);
const FULL_SUITES = ["test:all", "test:docs", "test:workflows"];
const EXACT_TEST_FILE = /^(?:run\s+)?[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?(?:\s|$)/;
const UI_SUITES = new Map([
  ["docs/presentations/introducing-dev-loops.html", "intro-deck"],
  ["docs/presentations/dev-loops-deep-dive.html", "deep-dive"],
  ["docs/presentations/how-dev-loops-decided-itself.html", "how-decided-deck"],
  ["docs/presentations/state-graph-surface.html", "state-graph-surface-deck"],
  ["docs/presentations/finding-the-flow.html", "finding-the-flow-deck"],
  ["docs/articles/introducing-dev-loops.html", "intro-article"],
  ["docs/articles/dev-loops-deep-dive.html", "deep-dive-article"],
  ["docs/articles/how-dev-loops-decided-itself.html", "how-decided-article"],
]);

/** Classify a shell command's validation reach, including compound commands. */
export function classifyValidationCommand(command) {
  if (/(?:^|[;&|\n])\s*\.\/scripts\/verify\.mjs(?:\s|$)/.test(command)) return "full-repository";
  const suites = new Set();
  let targeted = false;
  for (const segment of verificationCommandSegments(command)) {
    const bunTest = segment.match(/^bun\s+test(?:\s+(.*))?$/i);
    if (bunTest) {
      if (!EXACT_TEST_FILE.test(bunTest[1] ?? "")) return "full-repository";
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
    if (/^(?:(?:bun|node)\s+)?(?:\.\/)?scripts\/verify\.mjs(?:\s|$)/.test(segment)) return "full-repository";
    const runner = segment.match(/^(?:bun|node)\s+scripts\/run-bun-test\.mjs(?:\s+(.*))?$/);
    if (runner) {
      if (/(?:^|\s)--all(?:\s|$)/.test(runner[1] ?? "") || !EXACT_TEST_FILE.test(runner[1] ?? "")) suites.add("test:all");
      targeted = true;
      continue;
    }
    const direct = segment.match(/^(?:bun\s+test|node\s+--test|(?:npx|bunx|bun\s+x)?\s*vitest)(?:\s+(.*))?$/i);
    if (direct) {
      if (!EXACT_TEST_FILE.test(direct[1] ?? "")) return "full-repository";
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
    if (path === "scripts/claude/generate-claude-assets.mjs") return ["generated", "bun run assets:check", "bun run test:doc-guard"];
    if (UI_SUITES.has(path)) return ["ui", `bun run test:playwright:${UI_SUITES.get(path)}`];
    if (/^docs\/(?:presentations|articles)\/[^/]+\.html$/.test(path)) return null;
    if (path.startsWith("test/playwright/") && path.endsWith(".spec.mjs")) {
      const suite = path.slice("test/playwright/".length, -".spec.mjs".length);
      if (suite === "inspect-run-viewer") return ["ui", "bun run test:playwright:viewer"];
      if (suite === "deep-dive-deck") return ["ui", "bun run test:playwright:deep-dive"];
      if ([...UI_SUITES.values()].includes(suite)) return ["ui", `bun run test:playwright:${suite}`];
      return null;
    }
    if (path.startsWith("scripts/loop/inspect-run-viewer/")) return ["ui", "bun run test:playwright:viewer"];
    if (path.startsWith("scripts/") || path.startsWith("cli/") || path.startsWith("lib/")) return ["scripts", "bun run test:scripts"];
    if (path.startsWith("skills/docs/") || path.startsWith("docs/") || path === "AGENTS.md" || path === "README.md") return ["docs", "bun run test:docs", "bun run test:doc-guard"];
    if (path.startsWith(".github/workflows/")) return ["workflow", "bun run test:workflows"];
    if (path.startsWith("extension/")) return ["extension", "bun run test:extension"];
    if (path.startsWith(".claude/") || path.startsWith("agents/") || path.startsWith("commands/") || path.startsWith("skills/dev-loop/templates/")) return ["generated", "bun run assets:check", "bun run test:assets"];
    return null;
  });
  const surfaces = new Set(checks.map((check) => check?.[0]));
  if (surfaces.size !== 1 || surfaces.has(undefined)) return { profile: "full-repository", commands: [] };
  return { profile: "targeted", commands: [...new Set(checks.flatMap((check) => check.slice(1)))] };
}
