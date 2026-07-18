import { createTrackerAdapter } from "./adapter.mjs";
import {
  viewIssue,
  createIssue as coreCreateIssue,
  editIssue as coreEditIssue,
  commentIssue as coreCommentIssue,
  listIssues as coreListIssues,
  detectLinkedIssuePr,
} from "../github/issue-ops.mjs";
import { main as moveQueueItemMain } from "../projects/move-queue-item.mjs";
import { main as listQueueItemsMain } from "../projects/list-queue-items.mjs";
import { DEFAULT_STATE_COLUMN_NAMES } from "../loop/queue-board-sync.mjs";

/**
 * The v1 built-in GitHub tracker provider (issue #1408). A facade over the
 * existing `gh issue` calls (now extracted to `../github/issue-ops.mjs`) and
 * the GitHub Projects board tooling already in the repo — wiring, not a
 * rewrite. Registered as the default provider by `./index.mjs`.
 *
 * Board capability is intentionally PARTIAL in this pass: only
 * `listQueueItems`/`setItemStatus` are wired (the two board primitives
 * already extracted to `../projects/*.mjs`). `ensureBoard`/`addQueueItem`/
 * `reorderItem`/`archiveItems` still live only as `scripts/projects/*.mjs`
 * CLI tools and are intentionally NOT duplicated into this adapter — no hot
 * caller in this pass needs them through the seam, and `packages/core` must
 * not import from repo-root `scripts/` (that would break `@dev-loops/core`
 * when installed standalone). Extract them here too when a real caller needs
 * board-writer access through the adapter (YAGNI).
 */
export function createGithubTrackerAdapter({ env = process.env, ghCommand = "gh", run } = {}) {
  const deps = { env, ghCommand, ...(run ? { run } : {}) };
  // detectLinkedIssuePr and the projects/*.mjs board primitives all name
  // their DI param `runChild` (not `run`, unlike the other issue-ops
  // functions) — pass the same injected runner under both names so a
  // caller-supplied `run` reaches every dependency, not just issue-ops.
  const runChildDeps = { env, ...(run ? { runChild: run } : {}) };
  const linkedPrDeps = { ...runChildDeps, ghCommand };

  function parseRef(urlOrRef) {
    const trimmed = String(urlOrRef ?? "").trim();
    // owner/repo#123
    const hashMatch = /^([^/#\s]+\/[^/#\s]+)#(\d+)$/u.exec(trimmed);
    if (hashMatch) {
      return { repo: hashMatch[1], id: Number(hashMatch[2]) };
    }
    // Full GitHub issue URL: https://github.com/owner/repo/issues/123
    const urlMatch = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)(?:[/?#].*)?$/u.exec(trimmed);
    if (urlMatch) {
      return { repo: urlMatch[1], id: Number(urlMatch[2]) };
    }
    throw new Error(`parseRef: unrecognized issue reference "${urlOrRef}" (expected "owner/repo#123" or a github.com issue URL)`);
  }

  async function getIssue({ repo, id }) {
    const { issue } = await viewIssue({ repo, issue: id, fields: "number,title,body,url,state,assignees" }, deps);
    return {
      id: issue.number,
      title: issue.title ?? "",
      body: issue.body ?? "",
      url: issue.url ?? "",
      state: typeof issue.state === "string" ? issue.state.toLowerCase() : "",
      assignees: Array.isArray(issue.assignees)
        ? issue.assignees.map((a) => (typeof a?.login === "string" ? a.login : null)).filter((l) => l !== null)
        : [],
    };
  }

  async function createIssue({ repo, title, body, milestone, labels, assignees }) {
    const result = await coreCreateIssue({ repo, title, body, milestone, labels, assignees }, deps);
    return { id: result.issueNumber, url: result.url };
  }

  async function editIssue({ repo, id }, { title, body, assignees, milestone } = {}) {
    // The tracker interface's flat `assignees` has no gh-native "replace"
    // equivalent (`gh issue edit` only supports add/remove); this adapter
    // treats it as an ADD list, matching the only current usage pattern in
    // this repo (claiming an issue — see resolve-dev-loop-startup.mjs).
    const result = await coreEditIssue({
      repo,
      issue: id,
      title,
      body,
      addAssignees: assignees,
      milestone,
    }, deps);
    return { edited: result.edited };
  }

  async function commentIssue({ repo, id }, body) {
    const result = await coreCommentIssue({ repo, issue: id, body }, deps);
    return { commentUrl: result.commentUrl };
  }

  async function listIssues({ repo, state, labels, limit }) {
    const result = await coreListIssues({ repo, state, labels, limit }, deps);
    // Normalize to the Tracker interface's Issue shape (same field names as
    // getIssue), not the raw {number,title,state,labels} coreListIssues
    // shape. `gh issue list` only returns number/title/state/labels — body/
    // url/assignees are per-item fields `gh issue view` fetches, and this
    // repo's list path never had them; fetching them here would be an N+1 gh
    // call per listed issue. They are populated empty ("", []) rather than
    // omitted, so every listIssues() result is still Issue-shaped (see
    // TrackerAdapter.listIssues JSDoc in ./adapter.mjs).
    return result.issues.map((issue) => ({
      id: issue.number,
      title: issue.title,
      body: "",
      url: "",
      state: issue.state,
      assignees: [],
    }));
  }

  async function detectLinkedPr({ repo, id }) {
    const result = await detectLinkedIssuePr({ repo, issue: id }, linkedPrDeps);
    return { hasOpenLinkedPr: result.hasOpenLinkedPr, prNumber: result.prNumber };
  }

  async function listQueueItems(board) {
    const result = await listQueueItemsMain({ repo: board.repo, project: board.project }, runChildDeps);
    return result.items ?? [];
  }

  // `board.columnNames` is the github provider's logical-column -> Status
  // mapping — callers source it from the existing, already-load-bearing
  // `queue.statusColumns` config (via `loadStateColumnMap` in
  // `../loop/queue-board-sync.mjs`), not a tracker-owned config key; unset
  // falls back to the provider's own defaults (DEFAULT_STATE_COLUMN_NAMES).
  async function setItemStatus(board, item, logicalColumn) {
    const columnNames = { ...DEFAULT_STATE_COLUMN_NAMES, ...(board.columnNames ?? {}) };
    const toColumn = columnNames[logicalColumn];
    if (!toColumn) {
      throw new Error(`setItemStatus: no display column configured for logical column "${logicalColumn}"`);
    }
    const itemRef = String(item?.itemId ?? item?.number ?? item);
    await moveQueueItemMain({ repo: board.repo, project: board.project, item: itemRef, toColumn }, runChildDeps);
  }

  return createTrackerAdapter({
    parseRef,
    getIssue,
    createIssue,
    editIssue,
    commentIssue,
    listIssues,
    detectLinkedPr,
    listQueueItems,
    setItemStatus,
  });
}
