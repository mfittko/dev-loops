#!/usr/bin/env node
/**
 * PostToolUse AskUserQuestion hook (MERGE-ASK-APPROVAL, ADR 0315).
 *
 * A yes answer to the approval question ("Approve merge of <repo> PR #<n> at head <sha> with
 * patch-id <id>?", options exactly Yes and No) is the operator's per-merge approval. The harness,
 * not an agent, writes the signed record and posts the marked `approve merge` comment. Never
 * blocks: always exits 0, and tells the model the outcome through `additionalContext`.
 * `DEVLOOPS_GH_COMMAND` replaces `gh` so tests run a stub.
 */
import { execFileSync } from "node:child_process";
import { readHookInput } from "./_hook-io.mjs";
import { extractYesApproval, hasApprovalQuestion, writeApprovalRecord, buildApprovalComment, ASK_APPROVAL_RECOVERY, ASK_APPROVAL_KEY_RECOVERY } from "./_ask-merge-approval.mjs";

const tell = (additionalContext) => process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } })}\n`);

const input = readHookInput();
const approval = extractYesApproval(input);
if (approval) {
  try {
    // The real process env, so the hook resolves the same directory as the merge verifier (the test override never applies here).
    const { id } = writeApprovalRecord({ approval, session: input?.session_id ?? null }, process.env);
    const body = buildApprovalComment({ id, headSha: approval.headSha, patchId: approval.patchId });
    execFileSync(process.env.DEVLOOPS_GH_COMMAND || "gh", ["pr", "comment", String(approval.pr), "--repo", approval.repo, "--body", body], { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    tell(`MERGE-ASK-APPROVAL: recorded the yes answer and posted the approve-merge line for ${approval.repo}#${approval.pr} at head ${approval.headSha}.`);
  } catch (error) {
    tell(`MERGE-ASK-APPROVAL: could not record or post the approval (${error?.message ?? error}). ${error?.keyProblem ? ASK_APPROVAL_KEY_RECOVERY : ASK_APPROVAL_RECOVERY}`);
  }
} else if (hasApprovalQuestion(input)) {
  tell(`MERGE-ASK-APPROVAL: no approval recorded. The answer was not exactly "Yes" to an approval question whose options are exactly Yes and No (single select). ${ASK_APPROVAL_RECOVERY}`);
}
process.exitCode = 0;
