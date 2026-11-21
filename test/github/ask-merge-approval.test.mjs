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
  filterAskApprovalComments, parseMarkedComment, ASK_APPROVAL_RECOVERY,
} from "@dev-loops/core/github/ask-merge-approval";
import { verifyFreshHumanApproval } from "@dev-loops/core/loop/merge-approval";

const REPO = "example/fixture";
const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const PATCH = "c".repeat(40);
const OTHER_PATCH = "d".repeat(40);
const POST_HOOK = path.resolve(".claude/hooks/post-tool-use-ask-approval.mjs");
const GUARD_HOOK = path.resolve(".claude/hooks/pre-tool-use-approval-guard.mjs");
const BASH_HOOK = path.resolve(".claude/hooks/pre-tool-use-bash-gate.mjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-ask-approval-"));
  const dir = path.join(root, "approvals");
  const stub = path.join(root, "gh-stub.sh");
  const out = path.join(root, "gh-args.txt");
  fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\n`, { mode: 0o755 });
  return { root, dir, stub, out, env: { ...process.env, DEVLOOPS_APPROVAL_DIR: dir, DEVLOOPS_GH_COMMAND: stub } };
}

const question = (over = {}) => buildApprovalQuestion({ repo: REPO, pr: 7, headSha: HEAD, patchId: PATCH, ...over });
const askPayload = (text, answer = "Yes") => ({ tool_name: "AskUserQuestion", session_id: "s1", tool_input: { questions: [{ question: text }] }, tool_response: { answers: { [text]: answer } } });
const runHook = (script, input, env, extra = {}) => spawnSync("node", [script], { input: JSON.stringify(input), encoding: "utf8", env, ...extra });
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
