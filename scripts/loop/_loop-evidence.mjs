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
import { loadDevLoopConfigStrict, resolveRefinement } from "@dev-loops/core/config";
import { resolveRepoRoot } from "./_repo-root-resolver.mjs";
export async function loadCopilotEvidence({ repo, pr, copilotInputPath }, { env = process.env, ghCommand = "gh" } = {}) {
  let snapshot;
  if (copilotInputPath !== undefined) {
    const text = await readFile(copilotInputPath, "utf8");
    snapshot = normalizeCopilotSnapshot(parseJsonText(text));
  } else {
    snapshot = await autoDetectCopilotSnapshot({ repo, pr }, { env, ghCommand });
  }
  // Resolve the interpreter refinement config so the loop-state interpretation
  // honors gates.preApproval.requireCi:false — outer-loop routes the
  // conductor on this interpretation, so a CI-less repo must not be read as
  // waiting_for_ci here. The interpretation also applies maxCopilotRounds, a
  // gate decision, so a config load error fails closed (config_load_failed).
  const { config } = await loadDevLoopConfigStrict({ repoRoot: resolveRepoRoot(process.cwd()) });
  const refinementConfig = resolveRefinement(config);
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
