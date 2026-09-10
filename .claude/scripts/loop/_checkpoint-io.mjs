import { readFile } from "node:fs/promises";
import { parseJsonText } from "../_core-helpers.mjs";
import {
  buildCheckpointFilePath,
  buildDefaultCheckpointDir,
  buildLegacyDefaultCheckpointDir,
} from "./_checkpoint-paths.mjs";
export async function readExistingCheckpoint(repo, pr, { checkpointDir, failSilently = false } = {}) {
  const normalizedRepo = typeof repo === "string" ? repo.trim().toLowerCase() : repo;
  if (checkpointDir !== undefined) {
    const filePath = buildCheckpointFilePath(checkpointDir);
    try {
      const text = await readFile(filePath, "utf8");
      return { checkpoint: parseJsonText(text), filePath };
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { checkpoint: null, filePath: null };
      }
      if (failSilently) {
        return { checkpoint: null, filePath: null };
      }
      throw new Error(`Failed to read checkpoint '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const preferredDir = buildDefaultCheckpointDir(normalizedRepo, pr);
  const preferredPath = buildCheckpointFilePath(preferredDir);
  try {
    const text = await readFile(preferredPath, "utf8");
    return { checkpoint: parseJsonText(text), filePath: preferredPath };
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      if (failSilently) {
        return { checkpoint: null, filePath: null };
      }
      throw new Error(`Failed to read checkpoint '${preferredPath}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const legacyPath = buildCheckpointFilePath(buildLegacyDefaultCheckpointDir(pr));
  try {
    const text = await readFile(legacyPath, "utf8");
    const checkpoint = parseJsonText(text);
    if (checkpoint?.repo === normalizedRepo && checkpoint?.pr === pr) {
      return { checkpoint, filePath: legacyPath };
    }
    return { checkpoint: null, filePath: null };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { checkpoint: null, filePath: null };
    }
    if (failSilently) {
      return { checkpoint: null, filePath: null };
    }
    throw new Error(`Failed to read checkpoint '${legacyPath}': ${error instanceof Error ? error.message : String(error)}`);
  }
}
