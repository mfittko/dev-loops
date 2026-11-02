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

test("gh api paths are built from the validated slug; query, fragment, encoded and padded repos yield the empty set", async () => {
  for (const repo of ["mfittko/dev-loops", "o/r", "o.r/a_b-c"]) {
    const paths = [];
    const exec = fakeExec();
    const keys = await fetchHeadDeclaredKeys({ repo, pr: 1, headSha: SHA, exec: async (f, a) => { if (f === "gh") paths.push(a[1]); return exec(f, a); } });
    assert.deepEqual(keys, ["a.b"], repo);
    assert.ok(paths.every((p) => p.startsWith(`repos/${repo}/`)), repo);
  }
  const never = async () => { throw new Error("must not be called"); };
  for (const repo of ["o/r?x=1", " o/r", "o/r#x", "o/r%2F"]) {
    assert.deepEqual(await fetchHeadDeclaredKeys({ repo, pr: 1, headSha: SHA, exec: never }), [], repo);
  }
});

test("an exec error on the zip download or on unzip yields the empty set", async () => {
  const base = fakeExec();
  const throwing = (match) => async (file, args) => {
    if (match(file, args)) throw new Error("exec failed");
    return base(file, args);
  };
  const call = (exec) => fetchHeadDeclaredKeys({ repo: "o/r", pr: 1, headSha: SHA, exec });
  assert.deepEqual(await call(throwing((f, a) => f === "gh" && a[1].endsWith("/zip"))), []);
  assert.deepEqual(await call(throwing((f) => f === "unzip")), []);
});

test("a malformed artifact yields the empty set", async () => {
  for (const zipText of [
    "not json",
    '{"declaredKeys":"a"}',
    '{"declaredKeys":[1]}',
    '{"declaredKeys":["bad key!"]}',
    '{"declaredKeys":["a..b"]}',
    '{"declaredKeys":[""]}',
    JSON.stringify({ declaredKeys: ["x".repeat(101)] }),
    JSON.stringify({ declaredKeys: ["x".repeat(300 * 1024)] }),
  ]) {
    assert.deepEqual(await run({ zipText }), [], zipText.slice(0, 40));
  }
});

test("the detector and fetcher share one strict schema", () => {
  assert.equal(parseDeclaredKeysStrict, parseHeadDeclaredKeys);
  assert.deepEqual(parseHeadDeclaredKeys('{"declaredKeys":["a","b.c"]}'), ["a", "b.c"]);
  assert.deepEqual(parseHeadDeclaredKeys('{"declaredKeys":["a","bad key"]}'), ["a"]);
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

test("stripConfigKeyPaths does not delete an aliased setting through a shared YAML object", () => {
  const raw = "gates:\n  draft: &d\n    angles: [a]\n    x: 1\nrefinement: *d\n";
  const out = JSON.parse(stripConfigKeyPaths(raw, ".devloops", ["refinement.angles"]));
  assert.deepEqual(out.gates.draft.angles, ["a"]);
  assert.equal(out.refinement.angles, undefined);
  assert.equal(out.refinement.x, 1);
});
