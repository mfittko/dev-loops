import { readFile } from "node:fs/promises";
import { parseJsonText } from "../_core-helpers.mjs";
import { autoDetectSnapshot as autoDetectCopilotSnapshot } from "./detect-copilot-loop-state.mjs";
import { autoDetectReviewerSnapshot } from "./detect-reviewer-loop-state.mjs";
import {
  interpretLoopState,
  normalizeSnapshot as normalizeCopilotSnapshot,
} from "@dev-loops/core/loop/copilot-loop-state";
import {
  interpretReviewerLoopState,
  normalizeReviewerSnapshot,
} from "@dev-loops/core/loop/reviewer-loop-state";
export async function loadCopilotEvidence({ repo, pr, copilotInputPath }, { env = process.env, ghCommand = "gh" } = {}) {
  let snapshot;
  if (copilotInputPath !== undefined) {
    const text = await readFile(copilotInputPath, "utf8");
    snapshot = normalizeCopilotSnapshot(parseJsonText(text));
  } else {
    snapshot = await autoDetectCopilotSnapshot({ repo, pr }, { env, ghCommand });
  }
  return { snapshot, interpretation: interpretLoopState(snapshot) };
}
export async function loadReviewerEvidence({ repo, pr, reviewerLogin, reviewerInputPath }, { env = process.env, ghCommand = "gh" } = {}) {
  let snapshot;
  if (reviewerInputPath !== undefined) {
    const text = await readFile(reviewerInputPath, "utf8");
    snapshot = normalizeReviewerSnapshot(parseJsonText(text));
  } else {
    snapshot = await autoDetectReviewerSnapshot({ repo, pr, reviewerLogin }, { env, ghCommand });
  }
  return { snapshot, interpretation: interpretReviewerLoopState(snapshot) };
}
