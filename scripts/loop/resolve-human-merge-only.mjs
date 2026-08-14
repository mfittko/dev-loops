#!/usr/bin/env node
/**
 * resolve-human-merge-only
 *
 * Prints the effective `autonomy.humanMergeOnly` invariant for the repo at `cwd` as `true`/`false`
 * on stdout. Used by the Claude PreToolUse bash-gate hook to enforce STOP-HUMAN-MERGE-001 (#1622):
 * the hook bundle is self-contained and cannot import `@dev-loops/core`, so it defers this one
 * config resolution to this repo-root script and fails open (`false`) when the script or config
 * is unavailable. The loop-level merge safety already refuses merge under humanMergeOnly regardless
 * (lifecycle-state + handoff stopRules); this script lets the Bash gate add the same bound.
 */
import { loadDevLoopConfig, resolveHumanMergeOnly } from "@dev-loops/core/config";

const result = await loadDevLoopConfig({ cwd: process.cwd() });
const config = result.config ?? result;
process.stdout.write(resolveHumanMergeOnly(config) ? "true\n" : "false\n");
