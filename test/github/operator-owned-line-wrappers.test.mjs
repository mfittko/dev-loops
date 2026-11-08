import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli as runCommentIssue, parseCommentIssueCliArgs } from "../../scripts/github/comment-issue.mjs";
import { runCli as runEditComment, parseEditCommentCliArgs } from "../../scripts/github/edit-comment.mjs";
import { OPERATOR_OWNED_LINES } from "../../packages/core/src/github/operator-owned-lines.mjs";
import { captureStream, makeGhStub } from "../_helpers.mjs";

const SHA = "a".repeat(40);
const operatorMarker = `<!-- dev-loops:copilot-body-disposition review=9 head=${SHA} operator -->`;
const SAMPLES = {
  "approve-merge": `approve merge ${SHA}`,
  "approve-release": "approve release v1.2.3",
  "adr-tripwire-allow": "adr-tripwire:allow hand written reason",
  "copilot-body-disposition-operator": operatorMarker,
};
const POSTS = [
  { name: "comment-issue", run: runCommentIssue, args: ["--repo", "o/n", "--issue", "7"], ok: { stdout: "https://github.com/o/n/issues/7#issuecomment-1\n" } },
  { name: "edit-comment", run: runEditComment, args: ["--repo", "o/n", "--comment-id", "9"], ok: { stdout: JSON.stringify({ html_url: "https://github.com/o/n/issues/7#issuecomment-9" }) } },
];

async function invoke(post, extra, ok) {
  const { run, calls } = makeGhStub(ok ? [post.ok] : []);
  const stderr = captureStream();
  // env carries no Claude hook context: the refusal is wrapper-level (Pi parity).
  const code = await post.run([...post.args, ...extra], { run, stderr, stdout: captureStream(), env: { PATH: process.env.PATH } });
  return { code, calls, stderr: stderr.get() };
}

test("both wrappers parse --standing-authorization, default false", () => {
  assert.equal(parseCommentIssueCliArgs(["--repo", "o/n", "--issue", "7", "--body", "x"]).standingAuthorization, false);
  assert.equal(parseCommentIssueCliArgs(["--repo", "o/n", "--issue", "7", "--body", "x", "--standing-authorization"]).standingAuthorization, true);
  assert.equal(parseEditCommentCliArgs(["--repo", "o/n", "--comment-id", "9", "--body", "x", "--standing-authorization"]).standingAuthorization, true);
});

test("every entry is refused with --body and --body-file, no gh call, and --allowed-refs does not bypass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oowl-"));
  try {
    for (const post of POSTS) {
      for (const entry of OPERATOR_OWNED_LINES) {
        const body = `${SAMPLES[entry.id]}\nsee #1670`;
        const file = join(dir, "b.md");
        await writeFile(file, body);
        for (const input of [["--body", body], ["--body-file", file], ["--body", body, "--allowed-refs", "1670"]]) {
          const r = await invoke(post, input, false);
          assert.equal(r.code, 1, `${post.name} ${entry.id}`);
          assert.equal(r.calls.length, 0);
          assert.match(JSON.parse(r.stderr).error, /^OPERATOR-OWNED-LINE: /);
          assert.ok(JSON.parse(r.stderr).error.includes(entry.label));
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--standing-authorization posts only the operator marker; the other three stay refused", async () => {
  for (const post of POSTS) {
    for (const entry of OPERATOR_OWNED_LINES) {
      const r = await invoke(post, ["--body", SAMPLES[entry.id], "--standing-authorization"], entry.standingAuthorization);
      assert.equal(r.code, entry.standingAuthorization ? 0 : 1, `${post.name} ${entry.id}`);
      assert.equal(r.calls.length, entry.standingAuthorization ? 1 : 0);
    }
  }
});

test("mentions no reader accepts still post without the flag", async () => {
  const bodies = [
    `<!-- dev-loops:copilot-body-disposition review=9 head=${SHA} fix=${"b".repeat(40)} -->`,
    `\`\`\`\n${operatorMarker}\n\`\`\``,
    `inline \`${operatorMarker}\``,
    `> ${operatorMarker}`,
    "use `approve release v1.2.3` as the phrase",
    "the operator must type approve merge <sha>",
  ];
  for (const post of POSTS) {
    for (const body of bodies) {
      const r = await invoke(post, ["--body", body], true);
      assert.equal(r.code, 0, `${post.name} ${body}`);
    }
  }
});
