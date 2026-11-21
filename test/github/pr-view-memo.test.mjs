import test from "node:test";
import assert from "node:assert/strict";
import { readPrViewOnce } from "../../scripts/github/_pr-view-memo.mjs";

const target = { repo: "owner/repo", pr: 1, fields: "baseRefOid,labels" };

test("readPrViewOnce loads once per repo, PR and field list", async () => {
  const memo = new Map();
  let loads = 0;
  const load = async () => ({ n: ++loads });
  assert.deepEqual(await readPrViewOnce(target, memo, load), { n: 1 });
  assert.deepEqual(await readPrViewOnce(target, memo, load), { n: 1 });
  assert.deepEqual(await readPrViewOnce({ ...target, fields: "headRefOid" }, memo, load), { n: 2 });
});

test("readPrViewOnce retries after a rejected load", async () => {
  const memo = new Map();
  let loads = 0;
  const load = async () => { if (++loads === 1) throw new Error("boom"); return loads; };
  await assert.rejects(readPrViewOnce(target, memo, load), /boom/);
  assert.equal(await readPrViewOnce(target, memo, load), 2);
});

test("readPrViewOnce loads on every call without a memo", async () => {
  let loads = 0;
  const load = async () => ++loads;
  await readPrViewOnce(target, undefined, load);
  await readPrViewOnce(target, undefined, load);
  assert.equal(loads, 2);
});
