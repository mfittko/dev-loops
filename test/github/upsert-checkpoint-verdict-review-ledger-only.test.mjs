import assert from "node:assert/strict";
import { test } from "bun:test";
import { parseUpsertCheckpointVerdictCliArgs } from "../../scripts/github/upsert-checkpoint-verdict.mjs";

const HEAD = "a".repeat(40);
const base = ["--execution-mode", "fanout_fanin","--repo", "owner/repo", "--pr", "7", "--head-sha", HEAD, "--findings-ledger", "/tmp/ledger.json"];

test("#3199: --gate review accepts --findings-ledger as the only findings input", () => {
  const options = parseUpsertCheckpointVerdictCliArgs([...base, "--gate", "review"]);
  assert.equal(options.findingsLedger, "/tmp/ledger.json");
});

test("#3199: draft_gate and pre_approval_gate still require a findings input", () => {
  for (const gate of ["draft_gate", "pre_approval_gate"]) {
    assert.throws(() => parseUpsertCheckpointVerdictCliArgs([...base, "--gate", gate, "--next-action", "x"]), /requires --repo/);
  }
});
