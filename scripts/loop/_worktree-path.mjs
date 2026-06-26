/**
 * Shared worktree-path helpers (issue #909). Extracted so create/cleanup agree
 * on how a path is canonicalized for comparison/safety checks.
 */
import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Canonicalize for comparison: resolve symlinks on the longest existing prefix
 * (macOS /var → /private/var), keeping any not-yet-created leaf. Lets us match a
 * git-reported worktree path against a target that may not exist yet, and lets a
 * safety prefix-check see through a symlinked namespace dir.
 */
export function canonicalize(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // hit root without resolving
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}
