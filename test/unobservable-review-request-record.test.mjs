import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  readRequestNotObservable,
  recordTimedOutProbe,
  recordUnobservableRequest,
} from "../scripts/loop/_unobservable-review-request-record.mjs";

const pr = { repo: "o/r", pr: 1 };

test("two unobservable requests plus two timed-out probes on the same head reach the threshold", async () => {
  const checkpointDir = await mkdtemp(path.join(os.tmpdir(), "unobservable-record-"));
  const read = () => readRequestNotObservable({ ...pr, headSha: "a" }, { checkpointDir });
  assert.equal(await recordTimedOutProbe(pr, { checkpointDir }), null);
  await recordUnobservableRequest({ ...pr, headSha: "a" }, { checkpointDir });
  await recordTimedOutProbe(pr, { checkpointDir });
  assert.equal(await read(), false);
  await recordUnobservableRequest({ ...pr, headSha: "a" }, { checkpointDir });
  assert.equal(await read(), false);
  await recordTimedOutProbe(pr, { checkpointDir });
  assert.equal(await read(), true);
});

test("a new head resets the count and the record never applies to another head", async () => {
  const checkpointDir = await mkdtemp(path.join(os.tmpdir(), "unobservable-record-"));
  for (let i = 0; i < 2; i += 1) {
    await recordUnobservableRequest({ ...pr, headSha: "a" }, { checkpointDir });
    await recordTimedOutProbe(pr, { checkpointDir });
  }
  assert.equal(await readRequestNotObservable({ ...pr, headSha: "b" }, { checkpointDir }), false);
  const fresh = await recordUnobservableRequest({ ...pr, headSha: "b" }, { checkpointDir });
  assert.deepEqual([fresh.unobservableRequests, fresh.timedOutProbes], [1, 0]);
  assert.equal(await readRequestNotObservable({ ...pr, headSha: "a" }, { checkpointDir }), false);
});
