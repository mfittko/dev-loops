/**
 * dev-loop-behavioral-review
 *
 * Automatically triggers a brief behavioral review after every async dev-loop
 * run completes. The review checks whether the loop followed the working
 * agreement, notes where it drifted, and records any corrections needed
 * before the next loop starts.
 *
 * Activation: fires when a user-visible "Background task completed: dev-loop"
 * message arrives, which is the standard async-subagent delivery format.
 *
 * Enforcement seam: on each observed async dev-loop completion message, this extension writes a
 * durable retrospective checkpoint marker to
 * `.pi/dev-loop-retrospective-checkpoint.json` with `state: "required"`.
 * The marker persists until the retrospective is recorded (`state: "complete"`)
 * or explicitly skipped (`state: "skipped"`). The public dev-loop routing gate
 * (`evaluateRetrospectiveGate` in `@dev-loops/core`) fails closed on the
 * next start/resume when this marker shows `state: "required"`.
 *
 * Completing the retrospective:
 * After running the review below, record the outcome by writing
 * `.pi/dev-loop-retrospective-checkpoint.json` with one of:
 *   { "state": "complete", "completedAt": "<ISO timestamp>", "notes": "<summary>" }
 *   { "state": "skipped",  "skippedAt":  "<ISO timestamp>", "reason": "<reason>"  }
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Path of the durable retrospective checkpoint file, relative to the repo root.
 * Callers (skills, agents) read this file and map its contents to
 * RETROSPECTIVE_CHECKPOINT_STATE before calling evaluateRetrospectiveGate.
 */
export const RETROSPECTIVE_CHECKPOINT_FILE = ".pi/dev-loop-retrospective-checkpoint.json";

const REVIEW_PROMPT = `
Run a brief behavioral review of the dev-loop run that just completed.

Check:
- Did it follow the working agreement (test-first, honest validation, proper thread resolution, no dangerous git history rewrites)?
- Did it stay in dev mode as expected?
- What did it get right?
- Where did it drift or skip a step?
- Any corrections needed before the next loop starts?

Keep it concise and honest — this is not a formality.

After completing this review, record the outcome by writing
\`.pi/dev-loop-retrospective-checkpoint.json\` with:
  { "state": "complete", "completedAt": "<ISO timestamp>", "notes": "<one-line summary>" }
or, to explicitly skip:
  { "state": "skipped", "skippedAt": "<ISO timestamp>", "reason": "<reason>" }

Until that file is written with state "complete" or "skipped", the next
dev-loop start/resume will fail closed at the retrospective gate.
`.trim();

function isDevLoopCompletion(content: unknown): boolean {
  if (typeof content !== "string") return false;
  return (
    content.includes("Background task completed") &&
    content.includes("dev-loop")
  );
}

/**
 * Writes the retrospective checkpoint marker to the durable checkpoint file,
 * marking the state as "required" so the next dev-loop start/resume can
 * detect the outstanding requirement.
 *
 * Best-effort: file-system errors are caught and do not throw. The prompt
 * and manual write instructions in REVIEW_PROMPT remain the fallback.
 */
function writeRequiredCheckpoint(repoRoot: string): void {
  try {
    const checkpointPath = path.join(repoRoot, RETROSPECTIVE_CHECKPOINT_FILE);
    const marker = JSON.stringify(
      { state: "required", triggeredAt: new Date().toISOString() },
      null,
      2,
    );
    fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
    fs.writeFileSync(checkpointPath, marker + "\n", "utf8");
  } catch (error) {
    // Best-effort write — do not fail the extension or block the review prompt.
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[dev-loop-behavioral-review] failed to write retrospective checkpoint: ${detail}`);
  }
}

export default function devLoopBehavioralReview(pi: ExtensionAPI) {
  pi.on("agent_end", async (event, _ctx) => {
    const messages = event.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const trigger = messages[0];
    if (
      trigger?.role === "user" &&
      isDevLoopCompletion(
        Array.isArray(trigger.content)
          ? trigger.content.map((c: { text?: string }) => c.text ?? "").join("")
          : trigger.content
      )
    ) {
      // Write the durable checkpoint marker before sending the prompt so that
      // a fresh session can detect the outstanding requirement even if the
      // current session ends before the review is recorded.
      writeRequiredCheckpoint(process.cwd());
      pi.sendUserMessage(REVIEW_PROMPT);
    }
  });
}
