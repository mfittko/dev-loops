#!/usr/bin/env node
/**
 * PreToolUse AskUserQuestion guard (MERGE-ASK-APPROVAL, ADR 0315).
 * The PostToolUse hook trusts `tool_response.answers` as the operator's answer. The AskUserQuestion
 * input schema also accepts an `answers` map the model can fill. This guard denies a call that
 * carries a non-empty `answers` map next to an approval question, in every mode, so a model-supplied
 * answer never reaches the record. The approval question is answered in the dialog only.
 * An error in this hook denies (exit 2).
 */
import { withHookMarker } from "./_bash-gate-decisions.mjs";
import { readHookInput, emitDeny, emitAllow } from "./_hook-io.mjs";
import { hasApprovalQuestion } from "./_ask-merge-approval.mjs";

try {
  const input = readHookInput();
  const answers = input?.tool_input?.answers;
  if (answers && typeof answers === "object" && Object.keys(answers).length > 0 && hasApprovalQuestion(input)) {
    emitDeny(withHookMarker("MERGE-ASK-APPROVAL", "MERGE-ASK-APPROVAL: the approval question must be answered in the dialog. This call carries a pre-filled `answers` entry, which no agent may supply. Ask the approval question again without `answers`."));
  }
} catch (error) {
  process.stderr.write(withHookMarker("HOOK_GUARD_FAILED", `MERGE-ASK-APPROVAL: the AskUserQuestion guard failed (${String(error?.message ?? error).replace(/\s+/g, " ")}), so the call is denied.`) + "\n");
  process.exit(2);
}
emitAllow();
