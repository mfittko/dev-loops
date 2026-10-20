import assert from "node:assert/strict";
import { test } from "bun:test";
import { parseValidationRecord, validationRecordPath } from "../src/loop/validation-record.mjs";

const SHA = "a".repeat(40);
const ID = { repo: "owner/repo", headSha: SHA };
const record = () => ({
  repo: "owner/repo", headSha: SHA, producer: "local", profile: "targeted", toolchain: "bun@1.4.1",
  requestedSuites: ["test:docs"], suites: [{ name: "test:docs", command: "bun run test:docs", exitCode: 0, outputPath: "tmp/x.log" }],
  prTitle: "feat: x", generatedAt: "2026-10-20T10:00:00.000Z", allPassed: true,
});

test("path layout", () => {
  assert.equal(validationRecordPath(ID), `tmp/validation-records/owner/repo/${SHA}.json`);
  assert.equal(validationRecordPath({ ...ID, headSha: "b".repeat(64), tmpRoot: "x/" }), `x/validation-records/owner/repo/${"b".repeat(64)}.json`);
});

test("path refuses unsafe repo, short or uppercase sha, empty tmp root", () => {
  for (const repo of ["owner", "a/b/c", "../repo", "owner/..", "owner/.x", "ow ner/repo", "/repo", "", undefined]) {
    assert.throws(() => validationRecordPath({ ...ID, repo }), /repo/, String(repo));
  }
  for (const headSha of ["abc1234", "A".repeat(40), "a".repeat(41), "../".repeat(14), undefined]) {
    assert.throws(() => validationRecordPath({ ...ID, headSha }), /headSha/, String(headSha));
  }
  assert.throws(() => validationRecordPath({ ...ID, tmpRoot: " " }), /tmpRoot/);
  for (const tmpRoot of ["/abs", "..", "a/../b", "../x", "a\\..\\b", "C:/x"]) {
    assert.throws(() => validationRecordPath({ ...ID, tmpRoot }), /tmpRoot/, tmpRoot);
  }
});

test("suites must match requestedSuites and the profile must match them", () => {
  const refused = (value) => parseValidationRecord(value, ID);
  const renamed = record();
  renamed.suites[0].name = "other";
  assert.match(refused(renamed).reason, /requestedSuites/);
  const extra = record();
  extra.suites.push({ ...extra.suites[0] });
  assert.match(refused(extra).reason, /requestedSuites/);
  const dup = record();
  dup.requestedSuites = ["test:docs", "test:docs"];
  assert.equal(refused(dup).ok, false);
  assert.match(refused({ ...record(), profile: "full-repository" }).reason, /verify/);
  const verifyTargeted = record();
  verifyTargeted.requestedSuites = ["verify"];
  verifyTargeted.suites[0].name = "verify";
  assert.match(refused(verifyTargeted).reason, /verify/);
  const full = { ...verifyTargeted, profile: "full-repository" };
  assert.equal(refused(full).ok, true);
});

test("a 64-hex sha record is accepted and odd exitCode or depState types are refused", () => {
  const sha = "c".repeat(64);
  assert.equal(parseValidationRecord({ ...record(), headSha: sha }, { ...ID, headSha: sha }).ok, true);
  const nan = record();
  nan.suites[0].exitCode = Number.NaN;
  assert.equal(parseValidationRecord(nan, ID).ok, false);
  assert.equal(parseValidationRecord({ ...record(), depState: ["x"] }, ID).ok, false);
});

test("a valid record is accepted, with and without depState", () => {
  assert.equal(parseValidationRecord(record(), ID).ok, true);
  assert.equal(parseValidationRecord({ ...record(), depState: { status: "synced", detail: "d" } }, ID).ok, true);
  const failed = record();
  failed.suites[0].exitCode = 2;
  failed.allPassed = false;
  assert.equal(parseValidationRecord(failed, ID).ok, true);
});

test("refusals", () => {
  const refused = (value, expected = ID) => parseValidationRecord(value, expected);
  for (const value of [null, [], "x", 1, undefined]) assert.equal(refused(value).ok, false);
  assert.match(refused(record(), { ...ID, headSha: "b".repeat(40) }).reason, /head/);
  assert.match(refused(record(), { ...ID, repo: "other/repo" }).reason, /repo/);
  assert.equal(refused({ ...record(), suites: [] }).ok, false);
  assert.match(refused({ ...record(), allPassed: false }).reason, /allPassed/);
  assert.match(refused({ ...record(), allPassed: "true" }).reason, /allPassed/);
  assert.equal(refused({ ...record(), depState: [] }).ok, false);
  assert.equal(refused({ ...record(), generatedAt: "not a date" }).ok, false);
  assert.equal(refused({ ...record(), generatedAt: "2026-10-20T12:00:00.000Z" }).ok, true);
  for (const generatedAt of ["1", "Oct 20 2026", "2026-10-20", ""]) assert.equal(refused({ ...record(), generatedAt }).ok, false, generatedAt);
  assert.equal(refused({ ...record(), producer: "ci" }).ok, false);
  assert.equal(refused({ ...record(), profile: "partial" }).ok, false);
  assert.equal(refused({ ...record(), requestedSuites: [] }).ok, false);
  const badSuite = record();
  badSuite.suites[0].exitCode = "0";
  assert.equal(refused(badSuite).ok, false);
  const fractional = record();
  fractional.suites[0].exitCode = 0.5;
  assert.equal(refused(fractional).ok, false);
});

test("each missing field is refused", () => {
  for (const field of Object.keys(record())) {
    const value = record();
    delete value[field];
    assert.equal(parseValidationRecord(value, ID).ok, false, field);
  }
  for (const field of ["name", "command", "exitCode", "outputPath"]) {
    const value = record();
    delete value.suites[0][field];
    assert.equal(parseValidationRecord(value, ID).ok, false, `suite ${field}`);
  }
});

test("duplicate suite results cannot stand in for a missing requested suite", () => {
  const value = record();
  value.requestedSuites = ["test:docs", "test:core"];
  value.suites = [value.suites[0], { ...value.suites[0] }];
  assert.match(parseValidationRecord(value, ID).reason, /requestedSuites/);
});
