// Leaf module (PRE-PR-DEVELOPER-SELF-CHECK): the constraint ids the brief emits and the record writer requires.
// The writer never imports the brief, so the shared id derivation lives here.
import { execFileSync } from "node:child_process";
import { loadDevLoopConfig, resolveGateAngles, resolveGateAnglesDynamic, resolveReviewerRole } from "@dev-loops/core/config";
import { gitEnvNoDirOverrides } from "./_repo-root-resolver.mjs";

export const ANGLE_ID_PREFIX = "angle:";
export const MAX_ANGLE_LINES = 8;
export const ANGLE_LINE_MAX = 200;

// Constraints applied while writing, never a review pass after.
export const SELF_CHECK_ITEMS = Object.freeze([
  { id: "tests", check: "While writing, add a test for each acceptance criterion and each failure path." },
  { id: "edge-cases", check: "While writing, validate inputs: handle empty, null and missing inputs, and the failure path of each parser and each external read, each with a test." },
  { id: "surface-text", check: "While writing, keep --help text, docs, contracts and the changelog in sync with the behavior." },
  { id: "description", check: "While writing, keep the PR description matching the as-built code: the exact validation command, a stable pass/fail outcome and an In scope list of every changed file." },
]);

/** One sentence of an angle prompt, capped: deterministic condensation of the prompt the gate reviewers get. */
export function condenseAnglePrompt(prompt, angle) {
  const text = typeof prompt === "string" ? prompt.replace(/\s+/gu, " ").trim() : "";
  if (!text) return `Apply the ${angle} review angle while writing.`;
  const first = text.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? text;
  return first.length > ANGLE_LINE_MAX ? `${first.slice(0, ANGLE_LINE_MAX - 3)}...` : first;
}

/** The draft_gate angles for `paths`, each with its condensed constraint line; empty when the config does not load. */
export async function resolveSelfCheckAngles(root, paths) {
  try {
    const { config } = await loadDevLoopConfig({ repoRoot: root });
    const diff = { nameStatusOutput: paths.map((p) => `M\t${p}`).join("\n") };
    const names = (await resolveGateAnglesDynamic(config, "draft", { diff })).recommendedAngles ?? resolveGateAngles(config, "draft") ?? [];
    return names.slice(0, MAX_ANGLE_LINES).map((angle) => ({ id: `${ANGLE_ID_PREFIX}${angle}`, angle, constraint: condenseAnglePrompt(resolveReviewerRole(config, angle).prompt, angle) }));
  } catch { return []; }
}

/** Every constraint id required for the changed paths of `base...HEAD` in `cwd`: the resolved angle ids plus the generic ids. */
export async function requiredSelfCheckIds(cwd, base) {
  let paths = [];
  try {
    paths = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnvNoDirOverrides() }).split("\n").filter(Boolean);
  } catch { /* no diff, generic ids only */ }
  return [...(await resolveSelfCheckAngles(cwd, paths)).map((a) => a.id), ...SELF_CHECK_ITEMS.map((i) => i.id)];
}
