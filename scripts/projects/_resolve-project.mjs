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

// Parse a --project value into { kind:"id"|"number", value }. Throws
// INVALID_PROJECT on empty/malformed input (bare "0" is rejected too).
const GLOBAL_NODE_ID_RE = /^[A-Za-z0-9_]+$/;

function parseProjectRef(raw) {
  if (!raw || typeof raw !== "string" || raw.trim().length === 0) {
    throw Object.assign(new Error("--project is required"), { code: "INVALID_PROJECT" });
  }
  const trimmed = raw.trim();
  const asNum = Number(trimmed);
  if (Number.isInteger(asNum) && asNum > 0 && String(asNum) === trimmed) {
    return { kind: "number", value: asNum };
  }
  // Reject bare "0" — valid node ID character but not a meaningful project reference
  if (trimmed === "0") {
    throw Object.assign(
      new Error(`--project must be a positive integer or a node ID, got "${raw}"`),
      { code: "INVALID_PROJECT" },
    );
  }
  if (GLOBAL_NODE_ID_RE.test(trimmed)) {
    return { kind: "id", value: trimmed };
  }
  throw Object.assign(
    new Error(`--project must be a positive integer or a node ID, got "${raw}"`),
    { code: "INVALID_PROJECT" },
  );
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
// PROJECT_NOT_FOUND (desc: "<id>" / number N / title "T") under `owner`.
function findProject(projects, { projectRef, projectTitle }, owner) {
  const project = projectRef
    ? (projectRef.kind === "id"
        ? projects.find((p) => p.id === projectRef.value)
        : projects.find((p) => p.number === projectRef.value))
    : projects.find((p) => p.title === projectTitle);
  if (!project) {
    const desc = projectRef
      ? (projectRef.kind === "id" ? `"${projectRef.value}"` : `number ${projectRef.value}`)
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

export { resolveSettings, parseProjectRef, resolveProjectSelector, findProject, applyDevloopsBoard };
