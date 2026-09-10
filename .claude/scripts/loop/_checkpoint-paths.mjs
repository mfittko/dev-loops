import path from "node:path";
function splitRepo(repo) {
  if (typeof repo !== "string") {
    throw new Error("repo must be a string");
  }
  const normalized = repo.trim().toLowerCase();
  const parts = normalized.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`repo must be owner/name, received ${repo}`);
  }
  return { owner: parts[0], name: parts[1], normalized };
}
export function buildDefaultCheckpointDir(repo, pr) {
  const { owner, name } = splitRepo(repo);
  return path.join("tmp", "copilot-loop", owner, name, `pr-${pr}`);
}
export function buildLegacyDefaultCheckpointDir(pr) {
  return path.join("tmp", "copilot-loop", `pr-${pr}`);
}
export function buildCheckpointFilePath(checkpointDir) {
  return path.join(checkpointDir, "outer-loop-state.json");
}
