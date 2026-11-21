// Leaf module (PRE-PR-DEVELOPER-SELF-CHECK): the constraint ids the brief emits and the record writer requires.
// The writer never imports the brief, so the shared id derivation lives here.
import { execFileSync } from "node:child_process";
import { loadDevLoopConfig, loadDevLoopConfigStrict, resolveGateAngles, resolveGateAnglesDynamic, resolveReviewerRole } from "@dev-loops/core/config";
import { PRE_PR_SELF_CHECK_MISSING } from "./_pre-pr-review-record.mjs";
import { gitEnvNoDirOverrides } from "./_repo-root-resolver.mjs";

export const ANGLE_ID_PREFIX = "angle:";
export const MAX_ANGLE_LINES = 8;
export const ANGLE_LINE_MAX = 200;
const GIT_DIFF_TIMEOUT_MS = 30_000;

// The developer's last writing step before hand-back, not a separate review pass.
export const FINAL_STEP_CHECKLIST_IDS = Object.freeze(["P2", "CS1", "CS2"]);

// `strict` (the record path) turns a config load error into pre_pr_self_check_missing; the brief stays best-effort.
const configFailed = (error) => Object.assign(new Error(`${PRE_PR_SELF_CHECK_MISSING}: cannot derive the required self-check ids from the dev-loops config: ${error.message} (PRE-PR-DEVELOPER-SELF-CHECK)`), { code: PRE_PR_SELF_CHECK_MISSING });

/** The `developer-checklist` lines of every draft_gate angle, in config order, as { id, angle, check, finalStep? }; empty when the config does not load (strict: throws). A duplicate id across angles is a config error (strict: throws pre_pr_self_check_missing; best-effort: empty). */
export async function resolveChecklistItems(root, { strict = false } = {}) {
  try {
    const { config } = await (strict ? loadDevLoopConfigStrict : loadDevLoopConfig)({ repoRoot: root });
    const items = (config.gates?.draft?.angles ?? []).flatMap((entry) => (entry["developer-checklist"] ?? []).map((line) => {
      const split = line.indexOf(": ");
      const id = line.slice(0, split);
      return { id, angle: entry.name, check: line.slice(split + 2), ...(FINAL_STEP_CHECKLIST_IDS.includes(id) ? { finalStep: true } : {}) };
    }));
    const dup = items.find((item, i) => items.findIndex((other) => other.id === item.id) !== i);
    if (dup) throw new Error(`duplicate developer-checklist id ${dup.id} (angle ${dup.angle})`);
    return items;
  } catch (error) { if (strict) throw configFailed(error); return []; }
}

/** One sentence of an angle prompt, capped: deterministic condensation of the prompt the gate reviewers get. */
export function condenseAnglePrompt(prompt, angle) {
  const text = typeof prompt === "string" ? prompt.replace(/\s+/gu, " ").trim() : "";
  if (!text) return `Apply the ${angle} review angle while writing.`;
  const first = text.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? text;
  return first.length > ANGLE_LINE_MAX ? `${first.slice(0, ANGLE_LINE_MAX - 3)}...` : first;
}

/** The draft_gate angles for `paths`, each with its condensed constraint line; empty when the config does not load (strict: throws). */
export async function resolveSelfCheckAngles(root, paths, { strict = false } = {}) {
  try {
    const { config } = await (strict ? loadDevLoopConfigStrict : loadDevLoopConfig)({ repoRoot: root });
    const diff = { nameStatusOutput: paths.map((p) => `M\t${p}`).join("\n") };
    const names = (await resolveGateAnglesDynamic(config, "draft", { diff })).recommendedAngles ?? resolveGateAngles(config, "draft") ?? [];
    return names.slice(0, MAX_ANGLE_LINES).map((angle) => ({ id: `${ANGLE_ID_PREFIX}${angle}`, angle, constraint: condenseAnglePrompt(resolveReviewerRole(config, angle).prompt, angle) }));
  } catch (error) { if (strict) throw configFailed(error); return []; }
}

/** Every constraint id required for the changed paths of `base...<head>` (default HEAD) in `cwd`: the resolved angle ids plus the config checklist ids; throws pre_pr_self_check_missing when the git diff fails, the config does not load or yields no id. */
export async function requiredSelfCheckIds(cwd, base, head = "HEAD") {
  let paths;
  try {
    paths = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnvNoDirOverrides(), timeout: GIT_DIFF_TIMEOUT_MS }).split("\n").filter(Boolean);
  } catch (error) { throw configFailed(new Error(`git diff ${base}...${head} failed: ${error.message}`)); }
  const ids = [...(await resolveSelfCheckAngles(cwd, paths, { strict: true })).map((a) => a.id), ...(await resolveChecklistItems(cwd, { strict: true })).map((i) => i.id)];
  if (!ids.length) throw configFailed(new Error("the config resolves no self-check ids"));
  return ids;
}
