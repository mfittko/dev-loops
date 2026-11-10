import assert from "node:assert/strict";
import { test } from "bun:test";

import { postUntrustedSkipNote, untrustedSkipNoteMarker } from "../../scripts/github/_untrusted-skip-note.mjs";

const HEAD = "a".repeat(40);
const skipped = [{ threadId: "T1", authors: ["stranger", "other`x"], isResolved: false, remedy: "r" }];

function harness() {
  const posts = [];
  const runChild = async (_cmd, args) => {
    posts.push(args);
    return { code: 0, stdout: "{}", stderr: "" };
  };
  return { posts, gh: { env: {}, ghCommand: "gh", runChild } };
}
const base = (over) => ({ repo: "acme/widgets", pr: 7, headSha: HEAD, skipped, issueComments: [], login: "gate-bot", ...over });
const noteBy = (login, headSha = HEAD) => ({ user: { login }, body: `${untrustedSkipNoteMarker(headSha)}\nx` });

test("posts one note with logins and remedy, never comment text", async () => {
  const { posts, gh } = harness();
  assert.equal(await postUntrustedSkipNote(base(), gh), true);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].slice(0, 2), ["api", "repos/acme/widgets/issues/7/comments"]);
  const body = posts[0][3].replace(/^body=/, "");
  assert.ok(body.startsWith(untrustedSkipNoteMarker(HEAD)));
  assert.match(body, /`stranger`/);
  assert.match(body, /`otherx`/);
  assert.match(body, /Remedy: a maintainer/);
  assert.doesNotMatch(body, /#\d/);
});

test("no second post at the same head when the viewer's note exists", async () => {
  const { posts, gh } = harness();
  assert.equal(await postUntrustedSkipNote(base({ issueComments: [noteBy("gate-bot")] }), gh), false);
  assert.equal(posts.length, 0);
});

test("a forged marker by another user does not suppress the note", async () => {
  const { posts, gh } = harness();
  assert.equal(await postUntrustedSkipNote(base({ issueComments: [noteBy("stranger")] }), gh), true);
  assert.equal(posts.length, 1);
});

test("a new head posts again", async () => {
  const { posts, gh } = harness();
  const next = "b".repeat(40);
  assert.equal(await postUntrustedSkipNote(base({ headSha: next, issueComments: [noteBy("gate-bot")] }), gh), true);
  assert.equal(posts.length, 1);
});

test("nothing skipped posts nothing", async () => {
  const { posts, gh } = harness();
  assert.equal(await postUntrustedSkipNote(base({ skipped: [] }), gh), false);
  assert.equal(posts.length, 0);
});
