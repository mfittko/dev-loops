import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scrubGitEnv = (env) => ({ ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined });

// The verbatim patch-id of origin/<base>...<head> (whitespace and binary changes count), or null on any error (fail closed to head-only approval).
// The diff pins context (-U3 binds line position), prefixes, renames, algorithm and quoting so the id is a function of the commits only, and stays a Buffer so no byte is lost.
export function defaultComputePatchId({ base, head, repoRoot }) {
  let scratch = null;
  try {
    const env = { ...scrubGitEnv(process.env), GIT_ATTR_NOSYSTEM: "1" };
    const git = (args, opts) => execFileSync("git", args, { cwd: repoRoot, env, maxBuffer: 512 * 1024 * 1024, ...opts });
    const [baseSha, headSha] = [base, head].map((rev) => git(["rev-parse", "--verify", `${rev}^{commit}`], { encoding: "utf8" }).trim());
    const objects = git(["rev-parse", "--path-format=absolute", "--git-path", "objects"], { encoding: "utf8" }).trim();
    // A scratch git dir over the repo's objects has no info/attributes, which --attr-source cannot override; attributes then come from the head tree only (ADR 0279).
    scratch = mkdtempSync(path.join(tmpdir(), "patch-id-"));
    git(["init", "-q", "--bare", "--template=", scratch]); // --template= keeps a global init.templateDir from seeding info/attributes
    // No ambient config reaches the diff: global and system files are off and every GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n entry is dropped.
    const ambient = Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_CONFIG_(PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$/.test(key)));
    const scratchEnv = { ...ambient, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_DIR: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
    const diff = execFileSync("git", [`--attr-source=${headSha}`, "-c", "core.attributesFile=/dev/null", "-c", "core.quotePath=true", "-c", "diff.interHunkContext=0", "-c", "diff.indentHeuristic=true", "-c", "diff.suppressBlankEmpty=false", "diff", "-U3", "--submodule=short", "--ignore-submodules=none", "--no-color", "--no-ext-diff", "--no-textconv", "--binary", "--no-renames", "--diff-algorithm=myers", "--src-prefix=a/", "--dst-prefix=b/", `${baseSha}...${headSha}`], { cwd: scratch, env: scratchEnv, maxBuffer: 512 * 1024 * 1024 });
    const out = execFileSync("git", ["patch-id", "--verbatim"], { cwd: scratch, env: scratchEnv, input: diff, encoding: "utf8" });
    return out.trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

// The patch-id counts only when the head contains the base tip (ADR 0279); any git error or a head that lacks the base tip yields null (head-only approval).
export function computePatchIdWhenIntegrated({ base, head, repoRoot, computePatchId = defaultComputePatchId }) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", base, head], { cwd: repoRoot, env: scrubGitEnv(process.env), stdio: "ignore" });
    return computePatchId({ base, head, repoRoot });
  } catch {
    return null;
  }
}
