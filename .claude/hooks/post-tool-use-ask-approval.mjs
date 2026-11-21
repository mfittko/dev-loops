#!/usr/bin/env node
/**
 * PostToolUse AskUserQuestion hook (MERGE-ASK-APPROVAL, ADR 0315).
 *
 * A yes answer to the approval question ("Approve merge of <repo> PR #<n> at head <sha> with
 * patch-id <id>?") is the operator's per-merge approval. The harness, not an agent, writes the
 * signed record and posts the marked `approve merge` comment. Never blocks: always exits 0.
 * `DEVLOOPS_GH_COMMAND` replaces `gh` so tests run a stub.
 */
import { execFileSync } from "node:child_process";
import { readHookInput } from "./_hook-io.mjs";
import { extractYesApproval, writeApprovalRecord, buildApprovalComment } from "./_ask-merge-approval.mjs";

const input = readHookInput();
const approval = extractYesApproval(input);
if (approval) {
  try {
    const { id } = writeApprovalRecord({ approval, session: input?.session_id ?? null });
    const body = buildApprovalComment({ id, headSha: approval.headSha, patchId: approval.patchId });
    execFileSync(process.env.DEVLOOPS_GH_COMMAND || "gh", ["pr", "comment", String(approval.pr), "--repo", approval.repo, "--body", body], { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    process.stderr.write(`[dev-loops] ask-approval: recorded and posted the approval for ${approval.repo}#${approval.pr}.\n`);
  } catch (error) {
    process.stderr.write(`[dev-loops] ask-approval: could not record or post the approval (${error?.message ?? error}). Recovery: ask the approval question again.\n`);
  }
}
process.exitCode = 0;
