import path from "node:path";
import { fileURLToPath } from "node:url";

export const USAGE = `Usage: inspect-run-viewer.mjs [--repo <owner/name>]
  [--host <host>] [--port <port>] [--allow-non-localhost] [--restart]
  [--steering-state-file <path>]
  [--copilot-input <path>] [--reviewer-input <path>]

Owned read-only local/operator inspection dashboard for inspect-run snapshots.
inspect-run remains authoritative for inspection/status state; this viewer owns local inbox discovery plus read-only presentation/prioritization.
Inbox-first mode works with no PR selected. Use ?pr=<number> to deep-link a selected PR and optionally ?repo=<owner/name> to scope the inbox.

Optional:
  --repo <owner/name>                     Restrict the inbox to one repo
  --host <host>                         Bind host (default: 127.0.0.1)
  --port <port>                         Bind port (default: 4311)
  --allow-non-localhost                 Permit non-loopback binds
                                        (otherwise rejected)
  --restart                             Stop any existing listener on the
                                        chosen port before starting
                                        (requires lsof/POSIX; sends
                                        SIGTERM to all listeners)
  --steering-state-file <path>          Pass-through to inspect-run

  --copilot-input <path>                Pass-through to inspect-run
  --reviewer-input <path>               Pass-through to inspect-run
                                                                                  (pass-through to inspect-run)
)`.trim();

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4311;
export const MERMAID_BROWSER_ASSET_ROUTE = "/assets/mermaid.min.js";
// Vendored pinned mermaid@11.15.0 browser bundle (#1089); no runtime mermaid dependency.
export const MERMAID_BROWSER_ASSET_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "vendor",
  "mermaid.min.js",
);
export const DEFAULT_INBOX_UPDATED_WITHIN_DAYS = 7;
export const DEFAULT_INBOX_PAGE_SIZE = 25;
export const MAX_INBOX_RESULT_LIMIT = 100;
export const DEFAULT_INBOX_PR_STATE = "open";
export const DEFAULT_INBOX_MODE = "assignee";
export const DEFAULT_INBOX_PAGE = 1;
export const INBOX_UPDATED_FILTER_PRESETS = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "All", value: null },
];
export const INBOX_STATE_FILTER_PRESETS = [
  { label: "Open", value: "open" },
  { label: "Closed", value: "closed" },
  { label: "All", value: "all" },
];
export const INBOX_STATE_FILTER_VALUES = new Set(
  INBOX_STATE_FILTER_PRESETS.map((preset) => preset.value),
);
export const INBOX_MODE_FILTER_PRESETS = [
  { label: "Assigned", value: "assignee" },
  { label: "Reviewer", value: "reviewer" },
  { label: "Involved", value: "involved" },
];
export const INBOX_MODE_FILTER_VALUES = new Set(
  INBOX_MODE_FILTER_PRESETS.map((preset) => preset.value),
);
