import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { followRemedy } from "./_cap-round-route.mjs";

// Issue 3122 / ADR 0255: replay of PR 3087's real cap-round state. The artifacts are copied READ-ONLY from the main checkout
// into a scratch clone; nothing is written to the real tmp root, the real worktree or the real branch.
// The synthetic twin of this state runs in cap-round-no-dead-end.test.mjs; this test skips when the real artifacts are absent (CI).
const REPO = "mfittko/dev-loops";
const PR = 3087;
const CAP_HEAD = "183455c9eeeb1fa0ef7a15440fe4326e8fab0313";
const PR_HEAD = "b44405bbdf352d8bf1b92021a48512dc2fd24a1f";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const mainRoot = (() => { try { return path.dirname(git(process.cwd(), "rev-parse", "--path-format=absolute", "--git-common-dir")); } catch { return null; } })();
const ledgerDir = mainRoot && path.join(mainRoot, "tmp", "gate-findings", "mfittko-dev-loops", `pr-${PR}`);
const skipReason = !mainRoot ? "no git checkout"
  : !existsSync(path.join(ledgerDir, `draft_gate-${CAP_HEAD}.json`)) ? `PR ${PR} findings ledgers are absent under ${ledgerDir}`
    : (() => { try { git(mainRoot, "cat-file", "-e", `${PR_HEAD}^{commit}`); return null; } catch { return `commit ${PR_HEAD} (branch issue-3080) is absent from ${mainRoot}`; } })();
if (skipReason) console.warn(`SKIP replay of PR ${PR}: ${skipReason}`);

test.skipIf(skipReason !== null)(`replay of PR ${PR}: the reviewer-only route leaves report_blocked`, async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "replay-3087-"));
  try {
    git(os.tmpdir(), "clone", "-q", "--no-hardlinks", mainRoot, scratch);
    git(scratch, "fetch", "-q", mainRoot, "+refs/remotes/origin/main:refs/remotes/origin/main", "+refs/heads/issue-3080:refs/remotes/origin/issue-3080");
    git(scratch, "checkout", "-q", "--detach", PR_HEAD);
    const tmp = path.join(scratch, "tmp");
    const ledgers = path.join(tmp, "gate-findings", "mfittko-dev-loops", `pr-${PR}`);
    cpSync(ledgerDir, ledgers, { recursive: true });
    cpSync(path.join(mainRoot, "tmp", "gate-fixer", "mfittko-dev-loops", `pr-${PR}`), path.join(tmp, "gate-fixer", "mfittko-dev-loops", `pr-${PR}`), { recursive: true });
    // The delta records (and their seals and markers) of this PR's ledger heads; the other PRs' records and every patch stay behind.
    const heads = readdirSync(ledgerDir).filter((f) => /^draft_gate-[0-9a-f]{40}\.json$/.test(f)).map((f) => f.slice(11, 51));
    mkdirSync(path.join(tmp, "gate-delta"), { recursive: true });
    for (const f of readdirSync(path.join(mainRoot, "tmp", "gate-delta"))) {
      if (heads.some((h) => f.startsWith(h)) && !f.endsWith(".patch")) cpSync(path.join(mainRoot, "tmp", "gate-delta", f), path.join(tmp, "gate-delta", f));
    }
    const ctx = { repo: REPO, pr: PR, head: PR_HEAD, baseline: CAP_HEAD, ledgerPath: path.join(ledgers, `draft_gate-${CAP_HEAD}.json`) };
    const { trace, end } = await followRemedy(scratch, ctx);
    console.log(`REPLAY trace: ${JSON.stringify(trace)}\nREPLAY end: ${JSON.stringify({ fixed: end.fixed, failure: end.failure, nextAction: end.nextAction, remedy: end.remedy })}`);
    assert.notEqual(end.nextAction, "report_blocked", `still blocked: ${end.reason}`);
    assert.equal(end.fixed, true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120000);
