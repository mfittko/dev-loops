import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

// Read .devloops (and extension variants) queue settings, mirroring the
// resolution used by ensure-queue-board.mjs. Returns { project }, { title },
// and/or { olderThanDays } when configured; never throws on a missing/bad file.
function resolveSettings(cwd) {
  const basePath = path.join(cwd, ".devloops");
  const extensions = ["", ".yaml", ".yml", ".json"];
  for (const ext of extensions) {
    try {
      const raw = readFileSync(basePath + ext, "utf-8");
      const settings = ext === ".json" ? JSON.parse(raw) : parseYaml(raw);
      const queue = settings?.queue;
      if (!queue) return null;
      const out = {};
      if (typeof queue.projectNumber === "number" && Number.isInteger(queue.projectNumber) && queue.projectNumber > 0) {
        out.project = queue.projectNumber;
      } else if (typeof queue.boardTitle === "string" && queue.boardTitle.trim().length > 0) {
        out.title = queue.boardTitle.trim();
      }
      if (typeof queue.archiveOlderThanDays === "number" && Number.isInteger(queue.archiveOlderThanDays) && queue.archiveOlderThanDays > 0) {
        out.olderThanDays = queue.archiveOlderThanDays;
      }
      return out;
    } catch {
      // extension not present or unparseable — try next
    }
  }
  return null;
}

// Shape of the node IDs this tooling actually receives from the Projects V2
// API (e.g. "PVT_…", "PVTI_…", "I_…", "PR_…"): a type prefix, "_", then a
// base64url-ish payload. Intentionally narrower than an arbitrary GraphQL
// global node ID (which is opaque and carries no guaranteed prefix_payload
// shape). The payload alphabet includes "-" and "_" (base64url), which a
// plain [A-Za-z0-9_] class rejects — the exact shape that broke real PVTI_
// ids containing a hyphen.
const NODE_ID_RE = /^[A-Za-z]+_[A-Za-z0-9_-]+$/;

// Parse a --project value into { kind:"id"|"number"|"uri", ... }. Throws
// INVALID_PROJECT on empty/malformed input (bare "0" is rejected too).
//
// Supported forms:
//   <n>           positive integer  → { kind:"number", value:<n> }
//   <NODE_ID>     GraphQL node ID    → { kind:"id", value:<NODE_ID> }
//   https://github.com/users/<login>/projects/<n>
//   https://github.com/orgs/<login>/projects/<n>
//                 board URI        → { kind:"uri", number:<n>, owner:<login>, ownerKind:"user"|"org" }

// GitHub Projects V2 board URI pattern (user- or org-scoped boards).
const BOARD_URI_RE = /^https:\/\/github\.com\/(users|orgs)\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/projects\/(\d+)$/;

function parseProjectRef(raw) {
  if (!raw || typeof raw !== "string" || raw.trim().length === 0) {
    throw Object.assign(new Error("--project is required"), { code: "INVALID_PROJECT" });
  }
  const trimmed = raw.trim();

  // Board URI: https://github.com/users/<login>/projects/<n>
  //            https://github.com/orgs/<login>/projects/<n>
  const uriMatch = BOARD_URI_RE.exec(trimmed);
  if (uriMatch) {
    const ownerKind = uriMatch[1] === "users" ? "user" : "org";
    const owner = uriMatch[2];
    const number = Number(uriMatch[3]);
    if (number < 1) {
      throw Object.assign(
        new Error(`--project board URI must reference a positive project number, got "${raw}"`),
        { code: "INVALID_PROJECT" },
      );
    }
    return { kind: "uri", number, owner, ownerKind };
  }

  const asNum = Number(trimmed);
  if (Number.isInteger(asNum) && asNum > 0 && String(asNum) === trimmed) {
    return { kind: "number", value: asNum };
  }
  // Reject bare "0" — valid node ID character but not a meaningful project reference
  if (trimmed === "0") {
    throw Object.assign(
      new Error(`--project must be a positive integer, a node ID, or a board URI, got "${raw}"`),
      { code: "INVALID_PROJECT" },
    );
  }
  if (NODE_ID_RE.test(trimmed)) {
    return { kind: "id", value: trimmed };
  }
  throw Object.assign(
    new Error(`--project must be a positive integer, a node ID, or a board URI, got "${raw}"`),
    { code: "INVALID_PROJECT" },
  );
}

// Parse an item ref into { kind:"id"|"number" }. Throws INVALID_ITEM on
// empty/malformed input (bare "0" is rejected too). Shared by every item-ref
// consumer (move-queue-item --item; reorder-queue-item --item/--after/
// positionals) so the accepted node-ID alphabet is defined once. `label`
// names the flag/argument in error messages.
//
// Supported forms:
//   <n>           positive integer → { kind:"number", value:<n> }
//   <NODE_ID>     item node ID      → { kind:"id", value:<NODE_ID> }
function parseItemRef(raw, label = "--item") {
  if (!raw || typeof raw !== "string" || raw.trim().length === 0) {
    throw Object.assign(new Error(`${label} is required`), { code: "INVALID_ITEM" });
  }
  const trimmed = raw.trim();
  const asNum = Number(trimmed);
  if (Number.isInteger(asNum) && asNum > 0 && String(asNum) === trimmed) {
    return { kind: "number", value: asNum };
  }
  if (trimmed === "0") {
    throw Object.assign(new Error(`${label} must be a positive integer or an item node ID, got "${raw}"`), { code: "INVALID_ITEM" });
  }
  if (NODE_ID_RE.test(trimmed)) {
    return { kind: "id", value: trimmed };
  }
  throw Object.assign(new Error(`${label} must be a positive integer or an item node ID, got "${raw}"`), { code: "INVALID_ITEM" });
}

// Selector precedence: explicit --project ref wins; else resolve by board title
// from .devloops (passed as args.projectTitle by runCli). Fail closed if neither.
function resolveProjectSelector(args) {
  const hasProjectRef = typeof args.project === "string" && args.project.trim().length > 0;
  const projectRef = hasProjectRef ? parseProjectRef(args.project) : null;
  const projectTitle = !hasProjectRef && typeof args.projectTitle === "string" && args.projectTitle.trim().length > 0
    ? args.projectTitle.trim()
    : null;
  if (!projectRef && !projectTitle) {
    throw Object.assign(
      new Error("--project is required (or set queue.projectNumber / queue.boardTitle in .devloops)"),
      { code: "INVALID_PROJECT" },
    );
  }
  return { projectRef, projectTitle };
}

// Find the project in `projects` matching the resolved selector; throws
// PROJECT_NOT_FOUND (desc: "<id>" / number N / title "T" / URI number N under "<owner>").
function findProject(projects, { projectRef, projectTitle }, owner) {
  let project;
  if (projectRef) {
    if (projectRef.kind === "id") {
      project = projects.find((p) => p.id === projectRef.value);
    } else if (projectRef.kind === "uri") {
      project = projects.find((p) => p.number === projectRef.number);
    } else {
      project = projects.find((p) => p.number === projectRef.value);
    }
  } else {
    project = projects.find((p) => p.title === projectTitle);
  }
  if (!project) {
    const desc = projectRef
      ? (projectRef.kind === "id"
          ? `"${projectRef.value}"`
          : projectRef.kind === "uri"
            ? `URI number ${projectRef.number} under "${projectRef.owner}"`
            : `number ${projectRef.value}`)
      : `title "${projectTitle}"`;
    throw Object.assign(
      new Error(`Project ${desc} not found under owner "${owner}"`),
      { code: "PROJECT_NOT_FOUND" },
    );
  }
  return project;
}

// Apply .devloops board settings when --project was not passed. Precedence:
// explicit --project flag > queue.projectNumber/boardTitle. Mutates args.
function applyDevloopsBoard(args, cwd) {
  if (args.project === undefined) {
    const settings = resolveSettings(cwd);
    if (settings?.project) args.project = String(settings.project);
    else if (settings?.title) args.projectTitle = settings.title;
  }
}

export { resolveSettings, parseProjectRef, parseItemRef, resolveProjectSelector, findProject, applyDevloopsBoard };
