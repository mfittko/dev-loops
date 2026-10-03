// UI e2e auto-scoping (issue #976).
//
// Deterministic, path-triggered criterion: a PR that adds or modifies a
// *rendered* HTML artifact (a presentation deck, an article page, or the
// inspect-run viewer's served page/component) requires shared UI e2e assertions
// (mobile + desktop) and suite registration. Explicit manual-only scheduling
// exceptions retain rendered classification and independent review scope.
// Inclusion is path-triggered, never a human annotation on the PR.
//
// This module is the testable core of that criterion: classify changed paths
// → rendered-artifact set → check each is registered → fail closed if a
// rendered artifact changed with no registered/passing coverage.

// Explicit path globs for rendered artifacts. Kept conservative and explicit
// (issue #976 scope discipline): only artifacts that render to a page/component.
export const RENDERED_ARTIFACT_GLOBS = Object.freeze([
  "docs/articles/*.html",
  "docs/presentations/*.html",
]);

// The inspect-run viewer is served from a component, not a static .html file,
// so its trigger is the served-page source (matches the existing
// inspect-run-viewer-ci-changes.mjs trigger seam).
export const VIEWER_SOURCE_PATHS = Object.freeze([
  "scripts/loop/inspect-run-viewer.mjs",
]);

// Registered artifacts — keyed by FULL repo-relative path (not basename), so
// docs/articles/X.html and docs/presentations/X.html (which share basenames,
// e.g. introducing-dev-loops.html) are DISTINCT and can never alias onto each
// other. Mirrors the registries' actual on-disk locations:
//   decks   → DECK_REGISTRY served from docs/presentations/<deck>
//   articles→ ARTICLE_REGISTRY served from docs/articles/<file>
// Kept explicit here instead of importing the harness, which pulls
// @playwright/test into core.
export const REGISTERED_ARTIFACT_SUITES = Object.freeze({
  "docs/presentations/introducing-dev-loops.html": "intro-deck",
  "docs/presentations/dev-loops-deep-dive.html": "deep-dive",
  "docs/presentations/how-dev-loops-decided-itself.html": "how-decided-deck",
  "docs/presentations/state-graph-surface.html": "state-graph-surface-deck",
  "docs/presentations/finding-the-flow.html": "finding-the-flow-deck",
  "docs/articles/introducing-dev-loops.html": "intro-article",
  "docs/articles/dev-loops-deep-dive.html": "deep-dive-article",
  "docs/articles/how-dev-loops-decided-itself.html": "how-decided-article",
  "docs/articles/simulator.html": "simulator-article",
  "docs/articles/simulator-overview.html": "simulator-overview-article",
  "docs/articles/assets/workflow-models": "workflow-examples",
});
export const REGISTERED_ARTIFACT_PATHS = Object.freeze(Object.keys(REGISTERED_ARTIFACT_SUITES));

// User-authorized scheduling exception, not a rendered-artifact/review exemption.
const MANUAL_ONLY_UI_E2E_SUITES = Object.freeze(["workflow-examples"]);
export function isAutomaticUiE2eSuite(suite) {
  return !MANUAL_ONLY_UI_E2E_SUITES.includes(suite);
}

export function isManualUiE2ePath(filePath) {
  const path = normalizePath(filePath);
  const artifact = classifyRenderedArtifactPath(path);
  const suite = artifact ? REGISTERED_ARTIFACT_SUITES[artifact.id] : path.match(/^test\/playwright\/([^/]+)\.spec\.mjs$/u)?.[1];
  return !isAutomaticUiE2eSuite(suite);
}

export const VIEWER_ARTIFACT_ID = "inspect-run-viewer";

// CI check names that constitute the shared UI e2e coverage. The detect layer
// reads these from the statusCheckRollup to set uiE2ePassed. Note: a plain
// name match against the rollup is enough; the gate only needs to know whether
// the suite passed for this head. Each rendered-artifact family has a stable CI
// job whose name appears here; an absent check is unknown → fails closed.
export const UI_E2E_CHECK_NAMES = Object.freeze(["viewer-smoke", "deck-smoke", "article-smoke"]);

function normalizePath(filePath) {
  return String(filePath ?? "").trim().replace(/^\.\/+/u, "");
}

// Match a single explicit "dir/*.ext" glob (one path segment, no recursion).
function matchesGlob(normalizedPath, glob) {
  const [dir, file] = [glob.slice(0, glob.lastIndexOf("/")), glob.slice(glob.lastIndexOf("/") + 1)];
  if (!file.startsWith("*.")) return normalizedPath === glob;
  const ext = file.slice(1); // ".html"
  if (!normalizedPath.startsWith(`${dir}/`)) return false;
  const rest = normalizedPath.slice(dir.length + 1);
  return rest.length > 0 && !rest.includes("/") && rest.endsWith(ext);
}

// Classify one changed path into a rendered-artifact descriptor, or null.
// A descriptor carries the path, a stable `id` (the deck filename or the
// viewer id) and whether that id is registered in the e2e suite.
export function classifyRenderedArtifactPath(filePath) {
  const normalized = normalizePath(filePath);
  if (normalized.length === 0) return null;

  if (VIEWER_SOURCE_PATHS.includes(normalized)) {
    return { path: normalized, kind: "viewer", id: VIEWER_ARTIFACT_ID, registered: true };
  }
  if (normalized === "docs/articles/assets/workflow-models" || normalized === "scripts/pages/workflow-examples.mjs" || normalized.startsWith("docs/articles/assets/workflow-models/")) {
    return { path: normalized, kind: "article", id: "docs/articles/assets/workflow-models", registered: true };
  }

  for (const glob of RENDERED_ARTIFACT_GLOBS) {
    if (matchesGlob(normalized, glob)) {
      // Key registration on the FULL repo-relative path so an article and a
      // deck that share a basename are distinct artifacts. id is the full path
      // too, so the fail-closed reason names the exact file to register.
      return {
        path: normalized,
        kind: normalized.startsWith("docs/articles/") ? "article" : "deck",
        id: normalized,
        registered: REGISTERED_ARTIFACT_PATHS.includes(normalized),
      };
    }
  }
  return null;
}

/**
 * Deterministic UI e2e scoping check.
 *
 * @param {string[]} changedPaths - PR changed-file paths.
 * @param {{ uiE2ePassed?: boolean|null }} [coverage]
 *   uiE2ePassed: whether the shared UI e2e suite passed for this head.
 *   null/undefined means "not run / unknown" → fails closed.
 * @returns {{
 *   required: boolean,
 *   artifacts: Array<{path,kind,id,registered}>,
 *   unregistered: string[],
 *   satisfied: boolean,
 *   reason: string|null,
 * }}
 */
export function evaluateUiE2eScoping(changedPaths = [], { uiE2ePassed = null } = {}) {
  const artifacts = [];
  const seen = new Set();
  for (const p of Array.isArray(changedPaths) ? changedPaths : []) {
    const descriptor = classifyRenderedArtifactPath(p);
    if (descriptor && !seen.has(descriptor.path)) {
      seen.add(descriptor.path);
      artifacts.push(descriptor);
    }
  }

  const automaticArtifacts = artifacts.filter((artifact) => isAutomaticUiE2eSuite(REGISTERED_ARTIFACT_SUITES[artifact.id]));
  const required = automaticArtifacts.length > 0;
  if (!required) {
    return { required: false, artifacts, unregistered: [], satisfied: true, reason: null };
  }

  // Fail closed: any touched rendered artifact that is not registered blocks
  // and names itself so the fix is unambiguous (register it in the suite).
  const unregistered = automaticArtifacts.filter((a) => !a.registered).map((a) => a.id);
  if (unregistered.length > 0) {
    return {
      required: true,
      artifacts,
      unregistered,
      satisfied: false,
      reason:
        `UI e2e coverage is required: this PR changes rendered artifact(s) ` +
        `${unregistered.join(", ")} that are not registered in the shared UI e2e suite ` +
        `(DECK_REGISTRY or ARTICLE_REGISTRY in test/playwright/harness/deck-fit-harness.mjs, ` +
        `or VIEWER_REGISTRY in test/playwright/harness/inspect-run-viewer-harness.mjs). ` +
        `Register the artifact and add a spec that runs ` +
        `the mobile + desktop assertions before this gate can pass.`,
    };
  }

  // All automatic artifacts are registered — their coverage must have passed.
  if (uiE2ePassed !== true) {
    const touched = automaticArtifacts.map((a) => a.id).join(", ");
    return {
      required: true,
      artifacts,
      unregistered: [],
      satisfied: false,
      reason:
        `UI e2e coverage is required: this PR changes rendered artifact(s) ${touched}, ` +
        `but the shared UI e2e suite (mobile + desktop) has not passed for this head ` +
        `(uiE2ePassed=${String(uiE2ePassed)}). Run the UI/mobile e2e loop and let it pass ` +
        `before this gate can proceed.`,
    };
  }

  return { required: true, artifacts, unregistered: [], satisfied: true, reason: null };
}
