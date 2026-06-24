import assert from "node:assert/strict";
import test from "node:test";

import { findBlockingTitleMarkers } from "../src/loop/pr-title-markers.mjs";

test("matches bare WIP", () => {
  assert.deepEqual(findBlockingTitleMarkers("WIP"), ["WIP"]);
});

test("matches bracketed [WIP]", () => {
  assert.deepEqual(findBlockingTitleMarkers("[WIP] add feature"), ["WIP"]);
});

test("matches WIP with colon", () => {
  assert.deepEqual(findBlockingTitleMarkers("WIP: add feature"), ["WIP"]);
});

test("matches WIP followed by a word", () => {
  assert.deepEqual(findBlockingTitleMarkers("WIP foo bar"), ["WIP"]);
});

test("matches parenthesized lowercase (wip)", () => {
  assert.deepEqual(findBlockingTitleMarkers("Fix login (wip)"), ["WIP"]);
});

test("matches DRAFT as a word", () => {
  assert.deepEqual(findBlockingTitleMarkers("DRAFT: new module"), ["DRAFT"]);
});

test("matches DRAFT case-insensitively", () => {
  assert.deepEqual(findBlockingTitleMarkers("Add module [draft]"), ["DRAFT"]);
});

test("matches DO NOT MERGE phrase", () => {
  assert.deepEqual(findBlockingTitleMarkers("DO NOT MERGE - blocked on infra"), ["DO NOT MERGE"]);
});

test("matches DO NOT MERGE with flexible whitespace, case-insensitive", () => {
  assert.deepEqual(findBlockingTitleMarkers("Fix bug (do   not\tmerge)"), ["DO NOT MERGE"]);
});

test("matches the construction emoji anywhere", () => {
  assert.deepEqual(findBlockingTitleMarkers("Refactor pipeline 🚧"), ["🚧"]);
});

test("matches construction emoji at start", () => {
  assert.deepEqual(findBlockingTitleMarkers("🚧 still building"), ["🚧"]);
});

test("clean title returns empty array", () => {
  assert.deepEqual(findBlockingTitleMarkers("Add user authentication flow"), []);
});

test("does not match swipe (false positive guard)", () => {
  assert.deepEqual(findBlockingTitleMarkers("Improve swipe gesture handling"), []);
});

test("does not match wiped (false positive guard)", () => {
  assert.deepEqual(findBlockingTitleMarkers("Cache is wiped on logout"), []);
});

test("does not match drafting (false positive guard)", () => {
  assert.deepEqual(findBlockingTitleMarkers("Improve drafting workflow"), []);
});

test("does not match redraft (false positive guard)", () => {
  assert.deepEqual(findBlockingTitleMarkers("Redraft the proposal copy"), []);
});

test("does not match DOI NOT MERGE-like noise (negative phrase guard)", () => {
  assert.deepEqual(findBlockingTitleMarkers("DOI NOT MERGEABLE registry"), []);
});

test("empty string returns empty array", () => {
  assert.deepEqual(findBlockingTitleMarkers(""), []);
});

test("null returns empty array", () => {
  assert.deepEqual(findBlockingTitleMarkers(null), []);
});

test("undefined returns empty array", () => {
  assert.deepEqual(findBlockingTitleMarkers(undefined), []);
});

test("non-string returns empty array", () => {
  assert.deepEqual(findBlockingTitleMarkers(42), []);
  assert.deepEqual(findBlockingTitleMarkers({ title: "WIP" }), []);
});

test("multiple distinct markers are returned in stable order", () => {
  assert.deepEqual(
    findBlockingTitleMarkers("DO NOT MERGE [WIP] 🚧"),
    ["WIP", "DO NOT MERGE", "🚧"],
  );
});

test("repeated markers are de-duped", () => {
  assert.deepEqual(findBlockingTitleMarkers("WIP wip [WIP]"), ["WIP"]);
});

test("DRAFT and WIP together both surface", () => {
  assert.deepEqual(findBlockingTitleMarkers("WIP draft work"), ["WIP", "DRAFT"]);
});
