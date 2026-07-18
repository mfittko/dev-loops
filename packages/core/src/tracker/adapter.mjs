/**
 * Tracker adapter interface (issue #1408, the tracker-agnostic seam).
 *
 * Abstracts the work-item tracker (issues + optional board/queue) so the loop
 * reads/writes issues and drives the queue/board through one generic seam.
 * Mirrors the harness-adapter idiom exactly (`../harness/adapter.mjs`):
 * `createTrackerAdapter(impl)` validates the Issues REQUIRED_METHODS and
 * freezes the result; `resolveTrackerAdapter(config)` (see `./index.mjs`)
 * picks a provider by config, with GitHub as the built-in default.
 *
 * Two capability groups (per the #1408 RFC):
 *   - Issues (REQUIRED): every provider must implement these — the spec of
 *     record a tracker-backed loop reads/writes.
 *   - Board (OPTIONAL): present only when the provider has a board/queue.
 *     Kept as a distinct, checkable capability (not folded into
 *     REQUIRED_METHODS) so a provider with no board — or a future
 *     composite/split adapter delegating board vs issues to different
 *     providers (see the #1408 hybrid-tracker design note) — is still a
 *     valid Tracker.
 *
 * @typedef {Object} TrackerIssue
 * @property {string|number} id
 * @property {string} title
 * @property {string} body
 * @property {string} url
 * @property {string} state
 * @property {string[]} assignees
 *
 * @typedef {Object} TrackerRef
 * @property {string} repo
 * @property {string|number} id
 *
 * @typedef {Object} TrackerAdapter
 * @property {(urlOrRef: string) => TrackerRef} parseRef
 * @property {(ref: TrackerRef) => Promise<TrackerIssue>} getIssue
 * @property {(input: {repo: string, title: string, body: string}) => Promise<{id: string|number, url: string}>} createIssue
 * @property {(ref: TrackerRef, edits: {title?: string, body?: string, assignees?: string[], milestone?: string}) => Promise<{edited: string[]}>} editIssue
 * @property {(ref: TrackerRef, body: string) => Promise<{commentUrl: string}>} commentIssue
 * @property {(filter: {repo: string, state?: string, labels?: string[], limit?: number}) => Promise<TrackerIssue[]>} listIssues
 * @property {(ref: TrackerRef) => Promise<{hasOpenLinkedPr: boolean, prNumber: number|null}|null>} detectLinkedPr
 * @property {(cfg: object) => Promise<object>} [ensureBoard]
 * @property {(board: object) => Promise<object[]>} [listQueueItems]
 * @property {(board: object, issueId: string|number) => Promise<object>} [addQueueItem]
 * @property {(board: object, item: object, logicalColumn: string) => Promise<void>} [setItemStatus]
 * @property {(board: object, item: object, position: object) => Promise<void>} [reorderItem]
 * @property {(board: object, filter: object) => Promise<void>} [archiveItems]
 */

/** Issues capability — REQUIRED on every tracker provider. */
export const REQUIRED_METHODS = Object.freeze([
  "parseRef",
  "getIssue",
  "createIssue",
  "editIssue",
  "commentIssue",
  "listIssues",
  "detectLinkedPr",
]);

/** Board capability — OPTIONAL; present only when the provider has a board. */
export const BOARD_METHODS = Object.freeze([
  "ensureBoard",
  "listQueueItems",
  "addQueueItem",
  "setItemStatus",
  "reorderItem",
  "archiveItems",
]);

/**
 * Validate and freeze a tracker-adapter implementation. Requires the full
 * Issues capability; Board methods are copied through (frozen) when present
 * but are not required — a provider with no board is still a valid adapter.
 *
 * @param {Partial<TrackerAdapter>} impl
 * @returns {TrackerAdapter}
 */
export function createTrackerAdapter(impl) {
  if (!impl || typeof impl !== "object") {
    throw new TypeError("createTrackerAdapter: impl must be an object");
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof impl[method] !== "function") {
      throw new TypeError(`createTrackerAdapter: missing required method "${method}"`);
    }
  }

  const adapter = {};
  for (const method of REQUIRED_METHODS) {
    adapter[method] = impl[method];
  }
  for (const method of BOARD_METHODS) {
    if (typeof impl[method] === "function") {
      adapter[method] = impl[method];
    }
  }

  return Object.freeze(adapter);
}

/**
 * Type guard for a value implementing at least the required Issues capability.
 * @param {*} value
 * @returns {value is TrackerAdapter}
 */
export function isTrackerAdapter(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  return REQUIRED_METHODS.every((method) => typeof value[method] === "function");
}

/**
 * Whether an adapter also implements the optional Board capability in full.
 * @param {*} value
 * @returns {boolean}
 */
export function hasBoardCapability(value) {
  if (!isTrackerAdapter(value)) return false;
  return BOARD_METHODS.every((method) => typeof value[method] === "function");
}
