// docs/decisions/0234: the issue_comment path reads head-declared keys from an
// untrusted artifact; every anomaly must yield the empty set.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { stripConfigKeyPaths } from "@dev-loops/core/config";
import { fetchHeadDeclaredKeys, parseDeclaredKeysStrict, selectHeadKeysArtifact } from "../../scripts/github/fetch-head-declared-keys.mjs";
import { parseHeadDeclaredKeys } from "../../scripts/github/head-declared-keys-schema.mjs";
import { parseDetectCheckpointEvidenceCliArgs } from "../../scripts/github/detect-checkpoint-evidence.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const art = (over = {}) => ({ id: 7, name: `head-declared-keys-${SHA}`, expired: false, created_at: "2026-11-02T00:00:00Z", workflow_run: { head_sha: SHA }, ...over });

// Fake exec: gh api <path> / unzip -p. `zipText` is what the artifact contains.
function fakeExec({ prHead = SHA, artifacts = [art()], zipText = '{"declaredKeys":["a.b"]}' } = {}) {
  return async (file, args) => {
    if (file === "unzip") return Buffer.from(zipText);
    const p = args[1];
    if (/\/pulls\/\d+$/.test(p)) return Buffer.from(JSON.stringify({ head: { sha: prHead } }));
    if (p.includes("/actions/artifacts?")) return Buffer.from(JSON.stringify({ artifacts }));
    if (p.endsWith("/zip")) return Buffer.from("zip-bytes");
    throw new Error(`unexpected ${file} ${args.join(" ")}`);
  };
}
const run = (opts) => fetchHeadDeclaredKeys({ repo: "o/r", pr: 1, headSha: SHA, exec: fakeExec(opts) });

test("a valid artifact yields its keys", async () => {
  assert.deepEqual(await run(), ["a.b"]);
});

test("missing, expired, misnamed or foreign-run artifacts yield the empty set", async () => {
  assert.deepEqual(await run({ artifacts: [] }), []);
  assert.deepEqual(await run({ artifacts: [art({ expired: true })] }), []);
  assert.deepEqual(await run({ artifacts: [art({ name: `head-declared-keys-${OTHER}` })] }), []);
  assert.deepEqual(await run({ artifacts: [art({ workflow_run: { head_sha: OTHER } })] }), []);
});

test("the PR's current head differing from the requested head yields the empty set", async () => {
  assert.deepEqual(await run({ prHead: OTHER }), []);
});

test("selectHeadKeysArtifact picks the newest matching artifact", () => {
  const newer = art({ id: 9, created_at: "2026-11-03T00:00:00Z" });
  assert.equal(selectHeadKeysArtifact([art(), newer], SHA).id, 9);
  assert.equal(selectHeadKeysArtifact(undefined, SHA), null);
});

test("selectHeadKeysArtifact ranks a missing created_at last and breaks ties on the higher id", () => {
  assert.equal(selectHeadKeysArtifact([art({ id: 20, created_at: undefined }), art({ id: 5 })], SHA).id, 5);
  assert.equal(selectHeadKeysArtifact([art({ id: 5 }), art({ id: 9 })], SHA).id, 9);
});

test("malformed --repo, --pr or --head-sha yield the empty set without calling gh", async () => {
  const exec = async () => { throw new Error("must not be called"); };
  const call = (over) => fetchHeadDeclaredKeys({ repo: "o/r", pr: 1, headSha: SHA, exec, ...over });
  for (const repo of ["mfittko", "../x/y", ""]) assert.deepEqual(await call({ repo }), [], repo);
  for (const pr of ["0", "12/../1", "abc", ""]) assert.deepEqual(await call({ pr }), [], pr);
  for (const headSha of ["a86e10f", SHA.toUpperCase(), ""]) assert.deepEqual(await call({ headSha }), [], headSha);
});

test("a malformed artifact yields the empty set", async () => {
  for (const zipText of [
    "not json",
    '{"declaredKeys":"a"}',
    '{"declaredKeys":[1]}',
    '["bad key!"]',
    '["a..b"]',
    '[""]',
    JSON.stringify(Array.from({ length: 513 }, (_, i) => `k${i}`)),
    JSON.stringify(["x".repeat(201)]),
    JSON.stringify(["x".repeat(300 * 1024)]),
  ]) {
    assert.deepEqual(await run({ zipText }), [], zipText.slice(0, 40));
  }
});

test("the detector and fetcher share one strict schema", () => {
  assert.equal(parseDeclaredKeysStrict, parseHeadDeclaredKeys);
  assert.deepEqual(parseHeadDeclaredKeys('["a","b.c"]'), ["a", "b.c"]);
  assert.deepEqual(parseHeadDeclaredKeys('["a","bad key"]'), []);
});

test("a failed keys job (empty --head-declared-keys value) parses to the empty set, not a CLI error", () => {
  const base = ["--repo", "o/r", "--pr", "1"];
  assert.deepEqual(parseDetectCheckpointEvidenceCliArgs([...base, "--head-declared-keys="]).headDeclaredKeys, []);
  assert.deepEqual(parseDetectCheckpointEvidenceCliArgs([...base, "--head-declared-keys"]).headDeclaredKeys, []);
});

test("stripConfigKeyPaths never touches Object.prototype through a __proto__ path", () => {
  stripConfigKeyPaths('{"a":1}', ".devloops", ["__proto__.x", "__proto__.toString", "a.__proto__.y"]);
  assert.equal(Object.prototype.x, undefined);
  assert.equal(typeof Object.prototype.toString, "function");
});
