import { createTrackerAdapter } from "./adapter.mjs";

/**
 * Create a minimal, in-memory tracker adapter for tests. Every Issues method
 * is a deterministic stub; Board methods are included so tests can also
 * exercise the optional capability without a real GitHub Projects board.
 *
 * @param {Partial<import("./adapter.mjs").TrackerAdapter>} [overrides]
 * @returns {import("./adapter.mjs").TrackerAdapter}
 */
export function createNoopTrackerAdapter(overrides = {}) {
  return createTrackerAdapter({
    parseRef: (urlOrRef) => ({ repo: "", id: String(urlOrRef) }),
    getIssue: async (ref) => ({
      id: ref?.id ?? "",
      title: "",
      body: "",
      url: "",
      state: "open",
      assignees: [],
    }),
    createIssue: async () => ({ id: "0", url: "" }),
    editIssue: async () => ({ edited: [] }),
    commentIssue: async () => ({ commentUrl: "" }),
    listIssues: async () => [],
    detectLinkedPr: async () => null,
    ensureBoard: async () => ({}),
    listQueueItems: async () => [],
    addQueueItem: async () => ({}),
    setItemStatus: async () => {},
    reorderItem: async () => {},
    archiveItems: async () => {},
    ...overrides,
  });
}
