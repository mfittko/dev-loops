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

export { resolveSettings };
