import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveRuntimeHarness } from "@dev-loops/core/loop/run-context";

export function semanticHarnessRefusal(context, env = process.env) {
  if (resolveRuntimeHarness(env) !== "codex" && context?.harness !== "codex") return null;
  return { refusal: "semantic_harness_unqualified", reason: "Codex semantic execution is unqualified: no supported pre-process validation boundary; use an enforced Claude or Pi harness" };
}

/** Read only the round's shared pointer. Consumer hashes bind bytes; head binds meaning. */
export async function readValidationEvidence({ context, headSha, cwd, requireBinding = true }) {
  const pointer = context?.scope?.validationResultsPath;
  const validationResultsPath = typeof pointer === "string" && pointer ? path.resolve(cwd, pointer) : null;
  const incomplete = (reason) => ({ refusal: "validation_incomplete", validationResultsPath, reason });
  if (!validationResultsPath) return incomplete("gate context has no scope.validationResultsPath");
  let bytes, artifact;
  try { bytes = await readFile(validationResultsPath); artifact = JSON.parse(bytes.toString("utf8")); }
  catch (error) { return { ...incomplete("validation record is absent, unreadable, or invalid JSON"), absent: error.code === "ENOENT" }; }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const canonical = (filePath) => { try { return realpathSync(filePath); } catch { return filePath; } };
  const binding = (Array.isArray(context?.requiredReads) ? context.requiredReads : []).find((read) => read?.kind === "validation" && typeof read.path === "string" && canonical(path.resolve(cwd, read.path)) === canonical(validationResultsPath));
  if (requireBinding && (!binding || binding.sha256 !== sha256 || binding.bytes !== bytes.length)) return incomplete("validation record does not match the context's hash-bound validation read");
  if (!headSha || artifact?.headSha !== headSha) return incomplete(`validation record head ${artifact?.headSha ?? "missing"} differs from requested head ${headSha ?? "missing"}`);
  if (artifact.status === "incomplete") return incomplete(artifact.reason || "validation evidence is incomplete");
  if (!Array.isArray(artifact.suites) || artifact.suites.some((suite) => !Number.isInteger(suite?.exitCode)) || typeof artifact.allPassed !== "boolean" || (artifact.status !== undefined && !["complete", "failed"].includes(artifact.status))) return incomplete("validation record has no usable status, allPassed, or suites");
  const failed = artifact.status === "failed" || artifact.allPassed === false || artifact.suites.some((suite) => suite.exitCode !== 0);
  return { artifact, read: { kind: "validation", path: validationResultsPath, sha256, bytes: bytes.length, required: false }, validationResultsPath,
    ...(failed ? { refusal: "validation_failed", reason: artifact.reason || "validation suites failed", suites: artifact.suites.filter((suite) => suite.exitCode !== 0).map(({ name, outputPath }) => ({ name, outputPath })) } : {}) };
}
