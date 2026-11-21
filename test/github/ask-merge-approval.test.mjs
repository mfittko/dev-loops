// Ask-dialog merge approval (MERGE-ASK-APPROVAL, ADR 0315). Fixtures and a stub `gh` only: no real
// repository, no real approve-merge line. Negative cases first.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import {
  approvalDir, buildApprovalQuestion, extractYesApproval, writeApprovalRecord, buildApprovalComment,
  filterAskApprovalComments, parseMarkedComment, parseApprovalQuestion, approvalKeyPresent, isApprovalPath, commandNamesApprovalDir,
  ASK_APPROVAL_RECOVERY, ASK_APPROVAL_KEY_RECOVERY, ASK_APPROVAL_NO_DIALOG_RECOVERY,
} from "@dev-loops/core/github/ask-merge-approval";
import { verifyPolicyChangeApproval } from "../../scripts/github/_policy-change-approval.mjs";
import { buildPreMergeGateCheck } from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { verifyFreshHumanApproval } from "@dev-loops/core/loop/merge-approval";

const REPO = "example/fixture";
const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const PATCH = "c".repeat(40);
const OTHER_PATCH = "d".repeat(40);
const POST_HOOK = path.resolve(".claude/hooks/post-tool-use-ask-approval.mjs");
const GUARD_HOOK = path.resolve(".claude/hooks/pre-tool-use-approval-guard.mjs");
const BASH_HOOK = path.resolve(".claude/hooks/pre-tool-use-bash-gate.mjs");
const PRELOAD = path.resolve("test/github/ask-approval-userinfo-preload.mjs");
const SKIP_UNDER_ROOT = process.getuid?.() === 0;

// The in-process functions take f.env (override). The hook subprocesses ignore the override, like the merge
// verifier, and reach the same directory through the preload's account home (DEVLOOPS_TEST_HOME = root).
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-ask-approval-"));
  const dir = path.join(root, ".config", "dev-loops", "merge-approvals");
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const stub = path.join(root, "gh-stub.sh");
  const out = path.join(root, "gh-args.txt");
  fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\n`, { mode: 0o755 });
  return { root, dir, stub, out, env: { ...process.env, DEVLOOPS_APPROVAL_DIR: dir, DEVLOOPS_APPROVAL_TEST_MODE: "1", DEVLOOPS_GH_COMMAND: stub, DEVLOOPS_TEST_HOME: root } };
}

const question = (over = {}) => buildApprovalQuestion({ repo: REPO, pr: 7, headSha: HEAD, patchId: PATCH, ...over });
// Shaped like a real AskUserQuestion PostToolUse payload: options with label and description, multiSelect, and the answers map echoed in tool_response.
const YES_NO = [{ label: "Yes", description: "Approve this merge" }, { label: "No", description: "Do not merge" }];
const askPayload = (text, answer = "Yes", over = {}) => {
  const q = { question: text, header: "Merge", options: YES_NO, multiSelect: false, ...over };
  return {
    session_id: "s1", transcript_path: "/tmp/transcript.jsonl", cwd: "/tmp/checkout", permission_mode: "default",
    hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_01",
    tool_input: { questions: [q] },
    tool_response: { questions: [q], answers: { [text]: answer } },
  };
};
const runHook = (script, input, env, extra = {}) => spawnSync("node", ["--import", PRELOAD, script], { input: JSON.stringify(input), encoding: "utf8", env, ...extra });
const decision = (r) => (r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : "allow");
const ask = (env, over) => {
  const approval = extractYesApproval(askPayload(question(over)));
  return writeApprovalRecord({ approval, session: "s1" }, env);
};
const comment = (id, headSha = HEAD, patchId = PATCH) => ({ login: "operator", body: buildApprovalComment({ id, headSha, patchId }) });
const filter = (env, comments, over = {}) => filterAskApprovalComments({ comments, repo: REPO, pr: 7, currentHeadSha: HEAD, currentPatchId: PATCH, env, ...over });

// ac:3 negative: forged record
test("a record signed without the harness key is refused with a recovery", () => {
  const f = fixture();
  const { id, record } = ask(f.env);
  const file = path.join(f.dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...record, mac: "0".repeat(64) }));
  const { comments, refusals } = filter(f.env, [comment(id)]);
  assert.equal(comments.length, 0);
  assert.match(refusals[0], /forged or missing/);
  assert.ok(refusals[0].includes(ASK_APPROVAL_RECOVERY));
});

test("an agent-forged comment with a made-up record id is refused", () => {
  const f = fixture();
  ask(f.env);
  const { comments, refusals } = filter(f.env, [comment("e".repeat(64))]);
  assert.equal(comments.length, 0);
  assert.equal(refusals.length, 1);
});

test("a record whose facts were edited after signing is refused", () => {
  const f = fixture();
  const { id, record } = ask(f.env);
  fs.writeFileSync(path.join(f.dir, `${id}.json`), JSON.stringify({ ...record, headSha: OTHER_HEAD, mac: JSON.parse(fs.readFileSync(path.join(f.dir, `${id}.json`), "utf8")).mac }));
  assert.equal(filter(f.env, [comment(id, OTHER_HEAD)]).comments.length, 0);
});

// ac:3 negative: stale head and stale patch-id
test("a record for another head and patch-id is refused", () => {
  const f = fixture();
  const { id } = ask(f.env, { headSha: OTHER_HEAD, patchId: OTHER_PATCH });
  const { comments, refusals } = filter(f.env, [comment(id, OTHER_HEAD, OTHER_PATCH)]);
  assert.equal(comments.length, 0);
  assert.match(refusals[0], /not the current head/);
});

test("a comment naming another head than its record is refused", () => {
  const f = fixture();
  const { id } = ask(f.env);
  const { comments, refusals } = filter(f.env, [comment(id, OTHER_HEAD, PATCH)]);
  assert.equal(comments.length, 0);
  assert.match(refusals[0], /another head or patch-id than its record/);
});

test("a record for another repo or PR is refused", () => {
  const f = fixture();
  const { id } = ask(f.env);
  assert.equal(filter(f.env, [comment(id)], { pr: 8 }).comments.length, 0);
  assert.equal(filter(f.env, [comment(id)], { repo: "example/other" }).comments.length, 0);
});

test("merge verification refuses a matching record whose patch-id is stale and head moved", () => {
  const f = fixture();
  const { id } = ask(f.env);
  const { comments } = filter(f.env, [comment(id)], { currentHeadSha: OTHER_HEAD, currentPatchId: OTHER_PATCH });
  assert.equal(comments.length, 0);
});

// ac:1, ac:2
test("a yes answer makes the hook write a signed record and post the marked comment", () => {
  const f = fixture();
  const r = runHook(POST_HOOK, askPayload(question()), f.env);
  assert.equal(r.status, 0, r.stderr);
  const files = fs.readdirSync(f.dir).filter((n) => n.endsWith(".json"));
  assert.equal(files.length, 1);
  const record = JSON.parse(fs.readFileSync(path.join(f.dir, files[0]), "utf8"));
  assert.deepEqual([record.repo, record.pr, record.headSha, record.patchId, record.answer, record.session], [REPO, 7, HEAD, PATCH, "Yes", "s1"]);
  assert.equal(record.question, question());
  assert.ok(record.time && record.mac);
  const args = fs.readFileSync(f.out, "utf8").split("\n");
  assert.deepEqual(args.slice(0, 5), ["pr", "comment", "7", "--repo", REPO]);
  const body = args.slice(6).join("\n");
  const marked = parseMarkedComment(body);
  assert.equal(`${marked.id}.json`, files[0]);
  assert.match(body, new RegExp(`^approve merge ${HEAD} patch-id ${PATCH}`));
  // The posted comment, fed to the merge reader with its record, is a fresh approval.
  const { comments } = filter(f.env, [{ login: "operator", body }]);
  const verdict = verifyFreshHumanApproval({ approvedBy: "operator", currentHeadSha: HEAD, currentPatchId: PATCH, comments });
  assert.equal(verdict.satisfied, true);
});

test("a no answer, or a question without the bound facts, writes nothing", () => {
  const f = fixture();
  runHook(POST_HOOK, askPayload(question(), "No"), f.env);
  runHook(POST_HOOK, askPayload("Approve the merge?"), f.env);
  assert.equal(fs.existsSync(f.dir), false);
  assert.equal(fs.existsSync(f.out), false);
});

// ac:4
test("the guard hook denies agent tool access to the record directory", () => {
  const f = fixture();
  const cwd = f.root;
  const denied = [
    { tool_name: "Write", tool_input: { file_path: path.join(f.dir, "x.json") } },
    { tool_name: "Edit", tool_input: { file_path: path.join(f.dir, ".key") } },
    { tool_name: "Read", tool_input: { file_path: path.join(f.dir, ".key") } },
    { tool_name: "Grep", tool_input: { path: f.dir } },
    { tool_name: "Bash", tool_input: { command: `cat ${f.dir}/.key` } },
    { tool_name: "Bash", tool_input: { command: "ls ~/.config/dev-loops/merge-approvals" } },
  ];
  for (const input of denied) assert.equal(decision(runHook(GUARD_HOOK, { ...input, cwd }, f.env)), "deny", JSON.stringify(input));
  assert.equal(decision(runHook(GUARD_HOOK, { tool_name: "Write", tool_input: { file_path: path.join(f.root, "other.txt") }, cwd }, f.env)), "allow");
});

test("the bash gate denies an agent post of the approve-merge line", () => {
  const f = fixture();
  const command = `gh pr comment 7 --repo ${REPO} --body "approve merge ${HEAD} patch-id ${PATCH}"`;
  for (const agent_type of [undefined, "developer", "dev-loop"]) {
    const input = { tool_name: "Bash", tool_input: { command }, cwd: path.resolve("."), ...(agent_type ? { agent_type } : {}) };
    assert.equal(decision(runHook(BASH_HOOK, input, f.env)), "deny", String(agent_type));
  }
});

test("the default approval directory is outside the checkout", () => {
  const dir = approvalDir({});
  assert.equal(dir.startsWith(path.resolve(".")), false);
});

// ac:5: the Pi comment-line path has no harness check and no record
test("an unmarked operator comment line passes through unchanged (Pi path, #1086)", () => {
  const f = fixture();
  const piComment = { login: "operator", body: `approve merge ${HEAD} patch-id ${PATCH}` };
  const { comments, refusals } = filter(f.env, [piComment]);
  assert.deepEqual(comments, [piComment]);
  assert.deepEqual(refusals, []);
  assert.equal(fs.existsSync(f.dir), false, "no record directory is read or created");
  assert.equal(verifyFreshHumanApproval({ approvedBy: "operator", currentHeadSha: HEAD, currentPatchId: PATCH, comments }).satisfied, true);
});

// H1: once the hook key exists on this machine, every approve-merge comment needs its record
test("with the hook key present, a hand-typed approve-merge comment is refused with a recovery", () => {
  const f = fixture();
  ask(f.env);
  for (const body of [`approve merge ${HEAD} patch-id ${PATCH}`, `approve merge ${HEAD}`]) {
    const { comments, refusals } = filter(f.env, [{ login: "operator", body }]);
    assert.equal(comments.length, 0, body);
    assert.match(refusals[0], /no hook marker/);
    assert.ok(refusals[0].includes(ASK_APPROVAL_RECOVERY));
  }
  const chat = { login: "operator", body: "looks good to me" };
  assert.deepEqual(filter(f.env, [chat]).comments, [chat]);
});

test("a marked comment with more than one approve-merge line is refused", () => {
  const f = fixture();
  const { id } = ask(f.env);
  const body = `${buildApprovalComment({ id, headSha: HEAD, patchId: PATCH })}\napprove merge ${OTHER_HEAD} patch-id ${OTHER_PATCH}`;
  const { comments, refusals } = filter(f.env, [{ login: "operator", body }]);
  assert.equal(comments.length, 0);
  assert.match(refusals[0], /more than one approve-merge line/);
});

// H2: the override variable is test-only
test("the directory override applies only with the test flag", () => {
  assert.notEqual(approvalDir({ DEVLOOPS_APPROVAL_DIR: "/x/approvals" }), "/x/approvals");
  assert.equal(approvalDir({ DEVLOOPS_APPROVAL_DIR: "/x/approvals", DEVLOOPS_APPROVAL_TEST_MODE: "1" }), "/x/approvals");
});

// H3: exactly Yes and No, single select, answer exactly Yes
test("an answer other than exactly Yes, or options other than Yes and No, record nothing", () => {
  const q = question();
  const cases = [
    askPayload(q, "yes"),
    askPayload(q, "Yes, but wait"),
    askPayload(q, "Other: Yes"),
    askPayload(q, "Yes", { multiSelect: true }),
    askPayload(q, "Yes", { options: [{ label: "Yes" }, { label: "No" }, { label: "Later" }] }),
    askPayload(q, "Yes", { options: [{ label: "Yes" }] }),
    askPayload(q, "Yes", { options: [{ label: "Approve" }, { label: "No" }] }),
    askPayload(q, "Yes", { options: undefined }),
  ];
  for (const payload of cases) assert.equal(extractYesApproval(payload), null, JSON.stringify(payload.tool_response.answers));
  assert.equal(extractYesApproval(askPayload(q, "Yes", { options: [{ label: "No" }, { label: "Yes" }] }))?.answer, "Yes");
});

// key, directory and record hardening
test("a key that is not 32 bytes, a loose directory mode or a symlinked key is refused", () => {
  const f = fixture();
  const { id } = ask(f.env);
  const keyPath = path.join(f.dir, ".key");
  const key = fs.readFileSync(keyPath);
  assert.equal(key.length, 32);
  fs.writeFileSync(keyPath, key.subarray(0, 16));
  assert.equal(filter(f.env, [comment(id)]).comments.length, 0, "short key");
  fs.writeFileSync(keyPath, key);
  assert.equal(filter(f.env, [comment(id)]).comments.length, 1, "restored key verifies");
  fs.chmodSync(f.dir, 0o755);
  assert.equal(filter(f.env, [comment(id)]).comments.length, 0, "group-readable directory");
  fs.chmodSync(f.dir, 0o700);
  const elsewhere = path.join(f.root, "key-copy");
  fs.writeFileSync(elsewhere, key, { mode: 0o600 });
  fs.rmSync(keyPath);
  fs.symlinkSync(elsewhere, keyPath);
  const { comments, refusals } = filter(f.env, [comment(id)]);
  assert.equal(comments.length, 0, "symlinked key");
  assert.ok(refusals[0].includes(ASK_APPROVAL_KEY_RECOVERY), "a key problem names its own recovery");
  assert.equal(refusals[0].includes(ASK_APPROVAL_RECOVERY), false, "not the ask-again recovery");
  assert.throws(() => ask(f.env), /private regular file/);
});

// M-1, M-4: only ENOENT is absent; key and directory problems name the concrete fix
test("a 0-byte key and a wrong-size key each refuse with the key recovery", () => {
  const f = fixture();
  const { id } = ask(f.env);
  const keyPath = path.join(f.dir, ".key");
  const key = fs.readFileSync(keyPath);
  for (const bad of [Buffer.alloc(0), key.subarray(0, 31), Buffer.concat([key, key])]) {
    fs.writeFileSync(keyPath, bad, { mode: 0o600 });
    const { comments, refusals } = filter(f.env, [comment(id), { login: "operator", body: `approve merge ${HEAD}` }]);
    assert.equal(comments.length, 0, `${bad.length} bytes`);
    assert.equal(refusals.length, 2);
    for (const r of refusals) assert.ok(r.includes(ASK_APPROVAL_KEY_RECOVERY) && !r.includes(ASK_APPROVAL_RECOVERY), r);
    assert.match(refusals[0], /exactly 32/);
  }
  fs.rmSync(keyPath);
  assert.equal(approvalKeyPresent(f.env), false, "ENOENT is absent");
});

// Root reads a 0o000 directory, so these two permission cases cannot hold under uid 0.
test.skipIf(SKIP_UNDER_ROOT)("an unreadable key directory refuses with the key recovery", () => {
  const f = fixture();
  const { id } = ask(f.env);
  fs.chmodSync(f.dir, 0o000);
  try {
    assert.equal(approvalKeyPresent(f.env), true, "EACCES is not absent");
    const { comments, refusals } = filter(f.env, [{ login: "operator", body: `approve merge ${HEAD}` }, comment(id)]);
    assert.equal(comments.length, 0);
    assert.equal(refusals.length, 2);
    for (const r of refusals) assert.ok(r.includes(ASK_APPROVAL_KEY_RECOVERY) && r.includes("where the verifier can read the approval directory"), r);
  } finally { fs.chmodSync(f.dir, 0o700); }
});

test("creating the key leaves no temp file", () => {
  const f = fixture();
  ask(f.env);
  assert.deepEqual(fs.readdirSync(f.dir).filter((n) => n.startsWith(".key")), [".key"]);
});

test.skipIf(SKIP_UNDER_ROOT)("an unwritable directory is a key problem", () => {
  const g = fixture();
  fs.chmodSync(path.dirname(g.dir), 0o500);
  try {
    assert.throws(() => ask(g.env), (error) => error.keyProblem === true && /not usable/.test(error.message));
  } finally { fs.chmodSync(path.dirname(g.dir), 0o700); }
});

// M-5: Pi on a machine that holds the key
test("Pi on a machine with the key is refused with a Pi-capable recovery (accepted H1 consequence)", () => {
  const f = fixture();
  ask(f.env);
  const { comments, refusals } = filter(f.env, [{ login: "operator", body: `approve merge ${HEAD} patch-id ${PATCH}` }]);
  assert.equal(comments.length, 0);
  assert.ok(refusals[0].includes(ASK_APPROVAL_NO_DIALOG_RECOVERY));
  assert.match(ASK_APPROVAL_NO_DIALOG_RECOVERY, /APPROVED review/);
  assert.match(ASK_APPROVAL_NO_DIALOG_RECOVERY, /Claude Code/);
  assert.equal(verifyFreshHumanApproval({ approvedBy: "operator", currentHeadSha: HEAD, reviews: [{ user: { login: "operator" }, state: "APPROVED", commit_id: HEAD }] }).satisfied, true);
});

// H-A: the patch-id is optional end to end (the merge check prints none when the head lacks the base tip)
test("an approval question without a patch-id is recorded, posted and verified by head only", () => {
  const f = fixture();
  const text = buildApprovalQuestion({ repo: REPO, pr: 7, headSha: HEAD });
  assert.equal(text, `Approve merge of ${REPO} PR #7 at head ${HEAD}?`);
  assert.equal(extractYesApproval(askPayload(text)).patchId, null);
  assert.equal(parseApprovalQuestion(`${text} with patch-id ${PATCH} patch-id ${OTHER_PATCH}`), null, "two patch-ids stay ambiguous");
  const r = runHook(POST_HOOK, askPayload(text), f.env);
  assert.equal(r.status, 0, r.stderr);
  const body = fs.readFileSync(f.out, "utf8").split("\n").slice(6).join("\n");
  assert.match(body, new RegExp(`^approve merge ${HEAD}\\n<!-- dev-loops:ask-approval id=`));
  assert.equal(parseMarkedComment(body).patchId, null);
  const { comments, refusals } = filter(f.env, [{ login: "operator", body }], { currentPatchId: null });
  assert.deepEqual(refusals, []);
  assert.equal(verifyFreshHumanApproval({ approvedBy: "operator", currentHeadSha: HEAD, currentPatchId: null, comments }).satisfied, true);
  // A head-only record does not survive a head change, even with no current patch-id on either side.
  assert.equal(filter(f.env, [{ login: "operator", body }], { currentHeadSha: OTHER_HEAD, currentPatchId: null }).comments.length, 0);
  assert.equal(filter(f.env, [{ login: "operator", body }], { currentHeadSha: OTHER_HEAD, currentPatchId: PATCH }).comments.length, 0);
});

test("a record with a patch-id is refused when the head moved and no current patch-id is known", () => {
  const f = fixture();
  const { id } = ask(f.env);
  assert.equal(filter(f.env, [comment(id)], { currentHeadSha: OTHER_HEAD, currentPatchId: null }).comments.length, 0);
  assert.equal(filter(f.env, [comment(id)], { currentPatchId: null }).comments.length, 1, "same head still matches");
});

// L-2
test("the repo comparison is case-folded", () => {
  const f = fixture();
  const { id } = ask(f.env);
  assert.equal(filter(f.env, [comment(id)], { repo: "Example/Fixture" }).comments.length, 1);
});

// M-3: the verifier ignores the process environment override and $HOME
test("the verifier ignores the process-env override and $HOME", () => {
  const saved = { dir: process.env.DEVLOOPS_APPROVAL_DIR, flag: process.env.DEVLOOPS_APPROVAL_TEST_MODE, home: process.env.HOME };
  try {
    process.env.DEVLOOPS_APPROVAL_DIR = "/x/approvals";
    process.env.DEVLOOPS_APPROVAL_TEST_MODE = "1";
    process.env.HOME = "/x/home";
    const expected = path.join(os.userInfo().homedir, ".config", "dev-loops", "merge-approvals");
    assert.equal(approvalDir(), expected);
    assert.equal(approvalDir({ HOME: "/x/home" }), expected);
  } finally {
    for (const [k, v] of [["DEVLOOPS_APPROVAL_DIR", saved.dir], ["DEVLOOPS_APPROVAL_TEST_MODE", saved.flag], ["HOME", saved.home]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("a symlinked approval directory is refused for writing and reading", () => {
  const f = fixture();
  const real = path.join(f.root, "real");
  fs.mkdirSync(real, { mode: 0o700 });
  fs.symlinkSync(real, f.dir);
  assert.throws(() => ask(f.env), /private directory/);
  assert.deepEqual(fs.readdirSync(real), []);
});

test("a record copied under another name is refused, and a second write reuses the key", () => {
  const f = fixture();
  const first = ask(f.env);
  const other = "9".repeat(64);
  fs.copyFileSync(path.join(f.dir, `${first.id}.json`), path.join(f.dir, `${other}.json`));
  assert.equal(filter(f.env, [comment(other)]).comments.length, 0);
  const second = ask(f.env, { headSha: OTHER_HEAD });
  assert.equal(filter(f.env, [comment(second.id, OTHER_HEAD, PATCH)]).comments.length, 1);
  assert.equal(filter(f.env, [comment(first.id)]).comments.length, 1, "first record still verifies under the reused key");
});

test("the record temp file is created exclusively", () => {
  const f = fixture();
  const now = new Date("2026-11-21T00:00:00Z");
  const approval = extractYesApproval(askPayload(question()));
  const { id } = writeApprovalRecord({ approval, now }, f.env);
  fs.rmSync(path.join(f.dir, `${id}.json`));
  const tmp = path.join(f.dir, `${id}.json.${process.pid}.tmp`);
  fs.symlinkSync(path.join(f.root, "planted"), tmp);
  assert.throws(() => writeApprovalRecord({ approval, now }, f.env), /EEXIST/);
  assert.equal(fs.existsSync(path.join(f.root, "planted")), false);
});

// H2: guard coverage
test("the guard denies case-folded, symlinked, Glob, Grep glob and MCP arguments", () => {
  const f = fixture();
  fs.mkdirSync(f.dir, { mode: 0o700 });
  const link = path.join(f.root, "link");
  fs.symlinkSync(f.dir, link);
  const cwd = f.root;
  const denied = [
    { tool_name: "Read", tool_input: { file_path: path.join(f.dir.toUpperCase(), ".KEY") } },
    { tool_name: "Read", tool_input: { file_path: path.join(link, ".key") } },
    { tool_name: "Glob", tool_input: { pattern: `${f.dir}/*` } },
    { tool_name: "Glob", tool_input: { pattern: "**/merge-approvals/*" } },
    { tool_name: "Grep", tool_input: { pattern: "mac", glob: "**/Merge-Approvals/*.json", path: f.root } },
    { tool_name: "mcp__files__read", tool_input: { target: { uri: path.join(f.dir, ".key") } } },
    { tool_name: "Bash", tool_input: { command: "echo $DEVLOOPS_APPROVAL_TEST_MODE" } },
    // M-1, M-2: the parent directory and a key path under it
    { tool_name: "Bash", tool_input: { command: "ls -la ~/.config/dev-loops" } },
    { tool_name: "Bash", tool_input: { command: "cat ~/.config/dev-loops/merge-approvals/.key" } },
    { tool_name: "Glob", tool_input: { pattern: "**/.config/dev-loops/**" } },
    { tool_name: "Grep", tool_input: { pattern: ".", path: path.join(os.userInfo().homedir, ".config", "dev-loops") } },
    { tool_name: "Read", tool_input: { file_path: path.join(os.userInfo().homedir, ".config", "dev-loops", "merge-approvals", ".key") } },
  ];
  for (const input of denied) assert.equal(decision(runHook(GUARD_HOOK, { ...input, cwd }, f.env)), "deny", JSON.stringify(input));
  const prose = { tool_name: "Write", tool_input: { file_path: path.join(f.root, "doc.md"), content: "keys live in merge-approvals" }, cwd };
  assert.equal(decision(runHook(GUARD_HOOK, prose, f.env)), "allow", "a file body is not an address");
});

test("the shipped settings deny the record directory to Read, Edit, Write and the sandbox, and guard MCP tools", () => {
  const settings = JSON.parse(fs.readFileSync(path.resolve(".claude/settings.json"), "utf8"));
  const dir = "~/.config/dev-loops/merge-approvals";
  for (const tool of ["Read", "Edit", "Write"]) assert.ok(settings.permissions.deny.includes(`${tool}(${dir}/**)`), tool);
  assert.ok(settings.sandbox.filesystem.denyRead.includes(dir));
  const guard = settings.hooks.PreToolUse.find((h) => h.hooks.some((x) => x.command.includes("pre-tool-use-approval-guard")));
  assert.match(guard.matcher, /Glob/);
  assert.match(guard.matcher, /mcp__/);
});

// hook output tells the model the outcome
test("the post hook reports success, a failed post and an unrecorded answer through additionalContext", () => {
  const f = fixture();
  const context = (r) => JSON.parse(r.stdout).hookSpecificOutput;
  const ok = context(runHook(POST_HOOK, askPayload(question()), f.env));
  assert.equal(ok.hookEventName, "PostToolUse");
  assert.match(ok.additionalContext, /recorded the yes answer/);
  const failed = context(runHook(POST_HOOK, askPayload(question()), { ...f.env, DEVLOOPS_GH_COMMAND: "/usr/bin/false" }));
  assert.match(failed.additionalContext, /could not record or post/);
  assert.ok(failed.additionalContext.includes(ASK_APPROVAL_RECOVERY));
  const no = context(runHook(POST_HOOK, askPayload(question(), "No"), f.env));
  assert.match(no.additionalContext, /no approval recorded/);
  const badOptions = context(runHook(POST_HOOK, askPayload(question(), "Yes", { multiSelect: true }), f.env));
  assert.match(badOptions.additionalContext, /no approval recorded/);
  assert.equal(runHook(POST_HOOK, askPayload("Which color?"), f.env).stdout.trim(), "", "an unrelated question stays silent");
});

// Cluster 4: the guard's catch is its only protection when path resolution throws. readHookInput swallows
// non-JSON stdin, so the preload makes the account home a non-string to reach the catch.
test("the guard hook fails closed with exit 2 when its path resolution throws", () => {
  const f = fixture();
  const r = runHook(GUARD_HOOK, { tool_name: "Read", tool_input: { file_path: path.join(f.root, "other.txt") }, cwd: f.root }, { ...f.env, DEVLOOPS_TEST_USERINFO: "bad-home" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /approval guard failed/);
  assert.equal(r.stdout.trim(), "", "no allow decision is emitted");
});

// Cluster 5: the post hook names the key recovery for a key problem and the ask-again recovery for a failed post
test("the post hook names the key recovery when the record write fails on a key problem", () => {
  const f = fixture();
  const real = path.join(f.root, "real");
  fs.mkdirSync(real, { mode: 0o700 });
  fs.symlinkSync(real, f.dir);
  const context = JSON.parse(runHook(POST_HOOK, askPayload(question()), f.env).stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /could not record or post/);
  assert.ok(context.includes(ASK_APPROVAL_KEY_RECOVERY));
  assert.equal(context.includes(ASK_APPROVAL_RECOVERY), false);
  assert.equal(fs.existsSync(f.out), false, "no comment is posted without a record");
});

// Cluster 7: the writer and the verifier resolve one directory even when both test variables are set in the harness environment
test("the post hook ignores the test override in its real environment and writes where the verifier reads", () => {
  const f = fixture();
  const elsewhere = path.join(f.root, "override-dir");
  const r = runHook(POST_HOOK, askPayload(question()), { ...f.env, DEVLOOPS_APPROVAL_DIR: elsewhere, DEVLOOPS_APPROVAL_TEST_MODE: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(elsewhere), false, "the override directory is never written");
  const files = fs.readdirSync(f.dir).filter((n) => n.endsWith(".json"));
  assert.equal(files.length, 1);
  const body = fs.readFileSync(f.out, "utf8").split("\n").slice(6).join("\n");
  assert.equal(`${parseMarkedComment(body).id}.json`, files[0]);
  // The verifier on the same account home finds the record through the real-env rule.
  assert.equal(path.join(os.userInfo().homedir, ".config", "dev-loops", "merge-approvals"), approvalDir());
  assert.equal(filter(f.env, [{ login: "operator", body }]).comments.length, 1);
});

// Cluster 9: an account with no passwd entry
test("a UID with no account home has no key, the guard keeps its name scan and the hook recovers", () => {
  const real = os.userInfo;
  os.userInfo = () => { throw new Error("ENOENT: no passwd entry"); };
  try {
    assert.equal(approvalDir({}), null);
    assert.equal(approvalKeyPresent({}), false, "a host with no account home has no key");
    const plain = { login: "operator", body: `approve merge ${HEAD}` };
    assert.deepEqual(filterAskApprovalComments({ comments: [plain], repo: REPO, pr: 7, currentHeadSha: HEAD, env: {} }), { comments: [plain], refusals: [] });
    assert.equal(isApprovalPath("/some/file", {}), false);
    assert.equal(commandNamesApprovalDir("cat merge-approvals/.key", {}), true, "the name scan stays");
    assert.equal(commandNamesApprovalDir("ls /tmp", {}), false);
    assert.throws(() => ask({}), (error) => error.keyProblem === true && /no home directory/.test(error.message));
  } finally { os.userInfo = real; }
  const f = fixture();
  const env = { ...f.env, DEVLOOPS_TEST_USERINFO: "throw" };
  const allow = runHook(GUARD_HOOK, { tool_name: "Read", tool_input: { file_path: path.join(f.root, "other.txt") }, cwd: f.root }, env);
  assert.equal(allow.status, 0, allow.stderr);
  assert.equal(decision(allow), "allow", "an unrelated Read is allowed");
  assert.equal(decision(runHook(GUARD_HOOK, { tool_name: "Bash", tool_input: { command: "cat ~/.config/dev-loops/merge-approvals/.key" }, cwd: f.root }, env)), "deny");
  const context = JSON.parse(runHook(POST_HOOK, askPayload(question()), env).stdout).hookSpecificOutput.additionalContext;
  assert.ok(context.includes(ASK_APPROVAL_KEY_RECOVERY));
});

// Cluster 10, 11: the question matcher accepts only the template
test("parseApprovalQuestion accepts the template forms and rejects every other text", () => {
  const withPatch = `Approve merge of a/b PR #5 at head ${HEAD} with patch-id ${PATCH}?`;
  const headOnly = `Approve merge of a/b PR #5 at head ${HEAD}?`;
  assert.deepEqual(parseApprovalQuestion(withPatch), { repo: "a/b", pr: 5, headSha: HEAD, patchId: PATCH });
  assert.deepEqual(parseApprovalQuestion(headOnly), { repo: "a/b", pr: 5, headSha: HEAD, patchId: null });
  for (const text of [
    `Hold the merge of a/b PR #5 at head ${HEAD} until CI reruns?`,
    `Do not approve merge of a/b PR #5 at head ${HEAD}?`,
    `Approve merge of a/b PR 5 at head ${HEAD}?`,
    `Approve merge of a/b PR #5 at head ${HEAD}? Also delete the branch.`,
    `Approve merge of a/b PR #0 at head ${HEAD}?`,
    `Approve merge of a/b PR #9007199254740993 at head ${HEAD}?`,
    `Approve merge of ../b PR #5 at head ${HEAD}?`,
    `Approve merge of a/.. PR #5 at head ${HEAD}?`,
    "",
  ]) {
    assert.equal(parseApprovalQuestion(text), null, text);
    assert.equal(extractYesApproval(askPayload(text)), null, text);
  }
});

// ac:6: an unknown AskUserQuestion payload shape fails closed
test("an unknown AskUserQuestion payload shape records nothing and the hook exits 0", () => {
  const q = question();
  const good = askPayload(q);
  assert.notEqual(extractYesApproval(good), null);
  const shapes = [
    undefined, null, "yes", [],
    { ...good, tool_input: undefined },
    { ...good, tool_input: { questions: { 0: good.tool_input.questions[0] } } },
    { ...good, tool_input: { questions: "x" } },
    { ...good, tool_response: undefined },
    { ...good, tool_response: "Yes" },
    { ...good, tool_response: { answers: null } },
    { ...good, tool_response: { answers: [q, "Yes"] } },
    { ...good, tool_response: { answers: [{ question: q, answer: "Yes" }] } },
    { ...good, tool_response: { answer: "Yes" } },
    { ...good, tool_response: { answers: { [q]: ["Yes"] } } },
    { ...good, tool_response: { answers: { [q]: { label: "Yes" } } } },
    { ...good, tool_response: { answers: { [`${q} `]: "Yes" } } },
  ];
  for (const payload of shapes) assert.equal(extractYesApproval(payload), null, JSON.stringify(payload)?.slice(0, 80));
  const f = fixture();
  for (const payload of shapes) {
    const r = runHook(POST_HOOK, payload ?? {}, f.env);
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(fs.existsSync(f.dir), false, "no record or key is written");
  assert.equal(fs.existsSync(f.out), false, "no comment is posted");
});

// Cluster 13: the record signing functions are named in the guard scan, the module file name is not
test("the guard denies a Bash command naming the record signing functions and allows this module's tests", () => {
  const f = fixture();
  for (const command of [
    "node script.mjs --call writeApprovalRecord",
    "grep -n createKey packages",
    "grep -n loadKey packages",
  ]) assert.equal(decision(runHook(GUARD_HOOK, { tool_name: "Bash", tool_input: { command }, cwd: f.root }, f.env)), "deny", command);
  assert.equal(decision(runHook(GUARD_HOOK, { tool_name: "Bash", tool_input: { command: "bun test test/github/ask-merge-approval.test.mjs" }, cwd: f.root }, f.env)), "allow");
  assert.equal(decision(runHook(GUARD_HOOK, { tool_name: "Edit", tool_input: { file_path: path.join(f.root, "x.mjs"), new_string: "writeApprovalRecord()" }, cwd: f.root }, f.env)), "allow", "a file body is not an address");
});

// Cluster 3: every reader of the approval line applies the record check
test("the standing-authorization ready gate refuses a marked approve-merge comment with no record", async () => {
  const f = fixture();
  const read = (comments) => async (_cmd, args) => {
    const apiPath = args.find((a) => typeof a === "string" && a.startsWith("repos/")) ?? "";
    if (/^repos\/[^/]+\/[^/]+$/.test(apiPath)) return { code: 0, stdout: JSON.stringify({ owner: { login: "owner" } }), stderr: "" };
    return { code: 0, stdout: JSON.stringify([apiPath.includes("/reviews") ? [] : comments]), stderr: "" };
  };
  const adrTripwire = { triggers: [{ type: "standing-authorizations-change" }] };
  const verify = (body) => verifyPolicyChangeApproval({ repo: REPO, pr: 7, headSha: HEAD, adrTripwire }, { env: f.env, runChild: read([{ user: { login: "owner", type: "User" }, body }]) });
  const forged = await verify(buildApprovalComment({ id: "f".repeat(64), headSha: HEAD, patchId: PATCH }));
  assert.equal(forged.satisfied, false);
  assert.match(forged.reason, /forged or missing/);
  const { id } = ask(f.env);
  assert.equal((await verify(buildApprovalComment({ id, headSha: HEAD, patchId: PATCH }))).satisfied, true, "the same comment with its record counts");
});

test("the pre-merge gate check refuses a marked approve-merge comment with no record", () => {
  const f = fixture();
  const evidence = (body) => ({
    repo: REPO, pr: 7, currentHeadSha: HEAD,
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "clean", headSha: HEAD, sizeOutcome: "escalate", sizeTouchesT1: false },
    comments: [{ login: "owner", body, type: "User", trusted: true }],
  });
  const forged = buildPreMergeGateCheck(evidence(buildApprovalComment({ id: "f".repeat(64), headSha: HEAD, patchId: PATCH })), 0, null, null, { patchId: PATCH, env: f.env });
  assert.equal(forged.ok, false);
  assert.ok(forged.failures.some((m) => m.includes("size-budget requires a human APPROVED review")), JSON.stringify(forged.failures));
  const { id } = ask(f.env);
  const real = buildPreMergeGateCheck(evidence(buildApprovalComment({ id, headSha: HEAD, patchId: PATCH })), 0, null, null, { patchId: PATCH, env: f.env });
  assert.equal(real.ok, true, JSON.stringify(real.failures));
});
