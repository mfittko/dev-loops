#!/usr/bin/env node
/**
 * Push the generated Claude assets (the committed `.claude` tree) to their
 * Multica agent/skill counterparts through the `multica` CLI, so a release keeps
 * the hand-imported Multica copies in lockstep instead of drifting after every
 * bump (MFIT-367; the hand-sync that seeded this ran on MFIT-366).
 *
 * The mapping lives in `scripts/release/multica-sync.json` so more agents
 * (developer, fixer, judge, review, …) can join later without touching code:
 *   { "targets": [ { kind, id, label, source } ] }
 *     kind:   "agent" | "skill"
 *     id:     the Multica object id
 *     label:  a stable human label for reports/backups
 *     source: repo-relative path to the committed generated asset
 *
 * Per target the desired body is:
 *   agent  → the source file with its leading YAML frontmatter stripped
 *            (`multica agent update <id> --instructions <body>`)
 *   skill  → the source SKILL.md verbatim
 *            (`multica skill update <id> --content-file <path>`)
 * These skills have no recorded import source, so `multica skill refresh` fails
 * for them; a direct content update is the sanctioned path.
 *
 * Verification: skills by sha256 hash of the stored body, the agent by a
 * byte-for-byte comparison of the re-fetched `.instructions`. Any mismatch
 * exits non-zero.
 *
 * Usage:
 *   node scripts/release/sync-multica.mjs [--dry-run] [--repo-root <path>]
 *        [--config <path>] [--jq <filter>] [--silent]
 *
 *   --dry-run   Report each target as `in-sync` or `drift`. Writes nothing.
 *               Exits 0 when everything is in sync, 1 when any target drifts.
 *   default     Back up the current bodies to a timestamped directory (printed
 *               to stderr), update every target, then verify. Exits 0 on full
 *               parity, 1 on any mismatch or CLI failure, 2 on usage error.
 *
 * Node-builtins-only import closure (plus the node:-pure jq-output helper) so it
 * never pulls in `@dev-loops/core`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCliRun } from "../lib/direct-run.mjs";
import { emitResult } from "../lib/jq-output.mjs";

const DEFAULT_CONFIG = "scripts/release/multica-sync.json";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Strip a leading YAML frontmatter block (`---\n … \n---\n`). No frontmatter → unchanged. */
export function stripFrontmatter(raw) {
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** Read the config file and validate the target shape. */
export function loadConfig(repoRoot, configPath = DEFAULT_CONFIG) {
  const abs = path.isAbsolute(configPath) ? configPath : path.join(repoRoot, configPath);
  const parsed = JSON.parse(readFileSync(abs, "utf8"));
  const targets = parsed?.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error(`${configPath}: expected a non-empty "targets" array`);
  }
  for (const t of targets) {
    if (t.kind !== "agent" && t.kind !== "skill") {
      throw new Error(`${configPath}: target ${t.label ?? t.id} has invalid kind "${t.kind}"`);
    }
    for (const key of ["id", "label", "source"]) {
      if (typeof t[key] !== "string" || t[key] === "") {
        throw new Error(`${configPath}: target ${t.label ?? t.id} is missing "${key}"`);
      }
    }
  }
  return targets;
}

/** The exact body that should live in Multica for a target. */
export function desiredBody(target, repoRoot) {
  const raw = readFileSync(path.join(repoRoot, target.source), "utf8");
  return target.kind === "agent" ? stripFrontmatter(raw) : raw;
}

// Default CLI runner: spawn the `multica` binary, capture stdout/stderr. Injectable
// so the test suite can mock the CLI without a live workspace.
function defaultRunCli(args, { input } = {}) {
  const result = spawnSync("multica", args, { input, encoding: "utf8", maxBuffer: Infinity });
  if (result.error) {
    return { status: 127, stdout: "", stderr: result.error.message };
  }
  return { status: result.status ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runOrThrow(runCli, args, opts) {
  const res = runCli(args, opts);
  if (res.status !== 0) {
    throw new Error(`multica ${args.join(" ")} exited ${res.status}: ${(res.stderr || res.stdout || "").trim()}`);
  }
  return res;
}

/** Fetch a target's current stored body and its hash. */
export function fetchCurrent(target, runCli) {
  if (target.kind === "agent") {
    const { stdout } = runOrThrow(runCli, ["agent", "get", target.id, "--output", "json"]);
    const body = JSON.parse(stdout).instructions ?? "";
    return { body, hash: sha256(body) };
  }
  const { stdout } = runOrThrow(runCli, ["skill", "get", target.id, "--with-content", "--output", "json"]);
  const doc = JSON.parse(stdout);
  const body = doc.content ?? "";
  // Prefer a server-provided content_hash when present; otherwise hash the body
  // ourselves so verification works against either CLI build.
  return { body, hash: doc.content_hash ?? sha256(body) };
}

/** Push a target's desired body to Multica. */
function pushBody(target, body, runCli) {
  if (target.kind === "agent") {
    runOrThrow(runCli, ["agent", "update", target.id, "--instructions", body]);
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "multica-sync-"));
  const file = path.join(dir, "SKILL.md");
  writeFileSync(file, body, "utf8");
  runOrThrow(runCli, ["skill", "update", target.id, "--content-file", file]);
}

/**
 * Sync (or, under dryRun, only report) every configured target.
 * @returns {{ok:boolean, dryRun:boolean, backupDir:string|null, targets:object[]}}
 */
export function syncMulti({
  repoRoot,
  configPath = DEFAULT_CONFIG,
  dryRun = false,
  runCli = defaultRunCli,
  now = new Date(),
  backupsRoot,
  stderr = process.stderr,
} = {}) {
  const targets = loadConfig(repoRoot, configPath);

  // Dry run: compare only, write nothing.
  if (dryRun) {
    const rows = targets.map((t) => {
      const want = desiredBody(t, repoRoot);
      const current = fetchCurrent(t, runCli);
      const inSync = t.kind === "agent" ? current.body === want : current.hash === sha256(want);
      return { label: t.label, kind: t.kind, id: t.id, status: inSync ? "in-sync" : "drift" };
    });
    return { ok: rows.every((r) => r.status === "in-sync"), dryRun: true, backupDir: null, targets: rows };
  }

  // Real run: back up first, then update, then verify.
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(backupsRoot ?? path.join(repoRoot, ".multica-sync-backups"), stamp);
  mkdirSync(backupDir, { recursive: true });

  const current = new Map();
  for (const t of targets) {
    const fetched = fetchCurrent(t, runCli);
    current.set(t.id, fetched);
    const ext = t.kind === "agent" ? "instructions.md" : "SKILL.md";
    writeFileSync(path.join(backupDir, `${t.label.replace(/[:/]/g, "-")}.${ext}`), fetched.body, "utf8");
  }
  stderr.write(`[sync-multica] backup written to ${backupDir}\n`);

  const rows = targets.map((t) => {
    const want = desiredBody(t, repoRoot);
    const before = current.get(t.id);
    const changed = t.kind === "agent" ? before.body !== want : before.hash !== sha256(want);
    pushBody(t, want, runCli);
    const after = fetchCurrent(t, runCli);
    const verified = t.kind === "agent" ? after.body === want : after.hash === sha256(want);
    return {
      label: t.label,
      kind: t.kind,
      id: t.id,
      status: verified ? "verified" : "mismatch",
      changed,
    };
  });

  return { ok: rows.every((r) => r.status === "verified"), dryRun: false, backupDir, targets: rows };
}

function parseArgs(argv) {
  let dryRun = false;
  let repoRoot = null;
  let configPath = DEFAULT_CONFIG;
  let jq;
  let silent = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--repo-root") repoRoot = argv[++i];
    else if (arg === "--config") configPath = argv[++i];
    else if (arg === "--jq") jq = argv[++i];
    else if (arg === "--silent" || arg === "-s") silent = true;
    else if (arg === "-h" || arg === "--help") help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { dryRun, repoRoot, configPath, jq, silent, help };
}

const USAGE =
  "Usage: node scripts/release/sync-multica.mjs [--dry-run] [--repo-root <path>] [--config <path>] [--jq <filter>] [--silent]\n";

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const repoRoot = path.resolve(
    opts.repoRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  );
  try {
    const result = syncMulti({ repoRoot, configPath: opts.configPath, dryRun: opts.dryRun });
    process.exit(emitResult(result, { jq: opts.jq, silent: opts.silent }));
  } catch (error) {
    process.stderr.write(`[sync-multica] ${error.message}\n`);
    process.exit(1);
  }
}

if (isDirectCliRun(import.meta.url)) {
  main(process.argv.slice(2));
}
