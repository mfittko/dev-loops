// Shared file-walking primitives for the contract tests that scan shipped
// surfaces (referenced-scripts-shipped, referenced-slash-commands-shipped).
// Underscore prefix keeps the module out of the `test/contracts/*.test.mjs`
// runner glob, same as `_rule-helpers.mjs`.
import fs from "node:fs";
import path from "node:path";

export const ALWAYS_EXCLUDED_DIR_NAMES = new Set(["node_modules", ".git"]);

export function walkByExt(absDir, exts, out) {
  if (!fs.existsSync(absDir)) return out;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const absChild = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (ALWAYS_EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walkByExt(absChild, exts, out);
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(absChild);
    }
  }
  return out;
}

// Non-recursive: every direct entry whose name ends in `ext`. Deliberately no
// isFile() check — matches the inline readdir blocks it supersedes.
export function flatDir(absDir, ext, out) {
  if (!fs.existsSync(absDir)) return out;
  for (const name of fs.readdirSync(absDir)) {
    if (name.endsWith(ext)) out.push(path.join(absDir, name));
  }
  return out;
}
