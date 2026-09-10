/**
 * Shared deterministic single-contributor ownership classification for
 * issue/PR assignees.
 *
 * Owner: packages/core — reusable pure logic consumed by the startup
 * resolver (`resolve-dev-loop-startup.mjs`) and the Next Up pickup source
 * (`resolve-active-board-item.mjs`). `classifyOwnership` never shells out —
 * callers fetch assignees and the viewer's login via `gh`, then classify here.
 */
import { isCopilotLogin } from "./copilot-helpers.mjs";

export const OWNERSHIP_STATE = Object.freeze({
  ASSIGNED_TO_ME: "assigned_to_me",
  ASSIGNED_TO_OTHER: "assigned_to_other",
  ASSIGNED_TO_COPILOT: "assigned_to_copilot",
  UNASSIGNED: "unassigned",
});

/**
 * Classify assignee ownership of an issue/PR relative to the viewer.
 *
 * Copilot assignment is checked FIRST and short-circuits before any human
 * comparison — the viewer login is never required to detect it, so a
 * copilot-assigned artifact is unaffected by viewer-login resolution
 * failures (matches the existing, unchanged Copilot-first flow).
 *
 * `assigned_to_me` requires the viewer to be the SOLE human assignee.
 * `gh issue/pr edit --add-assignee` is not compare-and-swap, so two loopers
 * racing to claim the same unassigned item can both end up co-assigned;
 * membership-based classification would wave both through. A viewer
 * co-assigned alongside another human is `assigned_to_other` (contested) —
 * `foreignLogins` names the OTHER humans only (never the viewer), so error
 * messages stay accurate. Login comparison is case-insensitive (GitHub
 * logins are case-insensitive).
 *
 * @param {Array<{login?: string}>} assignees
 * @param {string|null} [viewerLogin] - required only when a non-copilot
 *   assignee is present; pass null/undefined when the caller skipped
 *   resolving it (empty assignees, or a copilot assignee already found).
 * @returns {{ state: string, foreignLogins: string[] }}
 */
export function classifyOwnership(assignees, viewerLogin = null) {
  const logins = (Array.isArray(assignees) ? assignees : [])
    .map((a) => a?.login)
    .filter((login) => typeof login === "string" && login.length > 0);
  if (logins.some(isCopilotLogin)) {
    return { state: OWNERSHIP_STATE.ASSIGNED_TO_COPILOT, foreignLogins: [] };
  }
  if (logins.length === 0) {
    return { state: OWNERSHIP_STATE.UNASSIGNED, foreignLogins: [] };
  }
  const viewerLoginLower = typeof viewerLogin === "string" && viewerLogin.length > 0
    ? viewerLogin.toLowerCase()
    : null;
  const otherLogins = viewerLoginLower === null
    ? logins
    : logins.filter((login) => login.toLowerCase() !== viewerLoginLower);
  if (viewerLoginLower !== null && otherLogins.length === 0) {
    return { state: OWNERSHIP_STATE.ASSIGNED_TO_ME, foreignLogins: [] };
  }
  return { state: OWNERSHIP_STATE.ASSIGNED_TO_OTHER, foreignLogins: otherLogins };
}

/**
 * Whether classifying these assignees requires a resolved viewer login (i.e.
 * there is at least one non-copilot assignee to compare against). Lets
 * callers skip the extra `gh api user` call for the common empty/copilot
 * cases, which also keeps those cases immune to viewer-login resolution
 * failures.
 *
 * @param {Array<{login?: string}>} assignees
 * @returns {boolean}
 */
export function ownershipNeedsViewerLogin(assignees) {
  const logins = (Array.isArray(assignees) ? assignees : [])
    .map((a) => a?.login)
    .filter((login) => typeof login === "string" && login.length > 0);
  return logins.length > 0 && !logins.some(isCopilotLogin);
}
