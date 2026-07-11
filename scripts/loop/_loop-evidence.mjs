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
import { loadDevLoopConfig, resolveRefinement } from "@dev-loops/core/config";
export async function loadCopilotEvidence({ repo, pr, copilotInputPath }, { env = process.env, ghCommand = "gh" } = {}) {
  let snapshot;
  if (copilotInputPath !== undefined) {
    const text = await readFile(copilotInputPath, "utf8");
    snapshot = normalizeCopilotSnapshot(parseJsonText(text));
  } else {
    snapshot = await autoDetectCopilotSnapshot({ repo, pr }, { env, ghCommand });
  }
  // Resolve the interpreter refinement config so the loop-state interpretation
  // honors gates.preApproval.requireCi:false (#1337) — outer-loop routes the
  // conductor on this interpretation, so a CI-less repo must not be read as
  // waiting_for_ci here. Fail soft to defaults if config cannot be loaded.
  let refinementConfig;
  try {
    const loaded = await loadDevLoopConfig();
    const config = Array.isArray(loaded?.errors) && loaded.errors.length > 0 ? { version: 1 } : (loaded?.config ?? { version: 1 });
    refinementConfig = resolveRefinement(config);
  } catch {
    refinementConfig = undefined;
  }
  return { snapshot, interpretation: interpretLoopState(snapshot, refinementConfig) };
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
