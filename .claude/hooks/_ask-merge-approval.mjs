// GENERATED from packages/core/src/github/ask-merge-approval.mjs by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate.
/**
 * Ask-dialog merge approval (MERGE-ASK-APPROVAL, ADR 0315). The Claude PostToolUse hook turns an
 * operator's yes answer to one approval question into a harness-signed record and a marked
 * `approve merge` comment. The merge wrapper accepts a marked comment only with a matching record.
 *
 * Integrity proof: an HMAC-SHA256 over the canonical record, keyed by a 32-byte random key in the
 * approval directory (mode 0600). The directory sits outside every checkout and the hook denies
 * every agent tool path to it. Only node: imports, so the hook bundle vendors this file unchanged.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APPROVAL_DIR_ENV = "DEVLOOPS_APPROVAL_DIR";
export const APPROVAL_DIR_NAME = "merge-approvals";
export const COMMENT_MARKER_PREFIX = "<!-- dev-loops:ask-approval id=";
const MARKER_RE = /<!-- dev-loops:ask-approval id=([0-9a-f]{64}) -->/u;
const RECOVERY = "Recovery: ask the operator the approval question again with the current facts: `Approve merge of <owner/name> PR #<n> at head <40-hex> with patch-id <40-hex>?`. The hook then records the yes answer and posts the line.";

export function approvalDir(env = process.env) {
  return env[APPROVAL_DIR_ENV] || path.join(os.homedir(), ".config", "dev-loops", APPROVAL_DIR_NAME);
}

/** True when `target` is the approval directory or below it (lexical, plus the resolved path of the nearest existing parent). */
export function isApprovalPath(target, env = process.env) {
  if (typeof target !== "string" || target === "") return false;
  const dir = path.resolve(approvalDir(env));
  const abs = path.resolve(target);
  return abs === dir || abs.startsWith(`${dir}${path.sep}`);
}

/** True when a Bash command names the approval directory or its override variable. */
export function commandNamesApprovalDir(command, env = process.env) {
  if (typeof command !== "string") return false;
  return command.includes(APPROVAL_DIR_NAME) || command.includes(APPROVAL_DIR_ENV) || command.includes(approvalDir(env));
}

export function approveMergeLine({ headSha, patchId }) {
  return `approve merge ${headSha} patch-id ${patchId}`;
}

/** The one question text the orchestrator asks. Names every fact the record binds. */
export function buildApprovalQuestion({ repo, pr, headSha, patchId }) {
  return `Approve merge of ${repo} PR #${pr} at head ${headSha} with patch-id ${patchId}?`;
}

/** Parse the bound facts out of a question. Null unless exactly one repo, PR, head and patch-id appear. */
export function parseApprovalQuestion(text) {
  if (typeof text !== "string") return null;
  const repo = [...text.matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) PR #(\d+)\b/gu)];
  const head = [...text.matchAll(/\bat head ([0-9a-f]{40})\b/gu)];
  const patch = [...text.matchAll(/\bpatch-id ([0-9a-f]{40})\b/gu)];
  if (repo.length !== 1 || head.length !== 1 || patch.length !== 1) return null;
  return { repo: repo[0][1], pr: Number(repo[0][2]), headSha: head[0][1], patchId: patch[0][1] };
}

/**
 * Extract a yes approval from a PostToolUse AskUserQuestion payload. Reads only `tool_response.answers`
 * (question text to the chosen label) and only the questions in `tool_input.questions`.
 * @returns {{ repo, pr, headSha, patchId, question, answer }|null}
 */
export function extractYesApproval(payload) {
  const questions = payload?.tool_input?.questions;
  const answers = payload?.tool_response?.answers;
  if (!Array.isArray(questions) || answers === null || typeof answers !== "object") return null;
  for (const q of questions) {
    const text = q?.question;
    const answer = answers[text];
    if (typeof answer !== "string" || !/^\s*yes\b/iu.test(answer)) continue;
    const facts = parseApprovalQuestion(text);
    if (facts) return { ...facts, question: text, answer };
  }
  return null;
}

function canonical(record) {
  const { repo, pr, headSha, patchId, question, answer, time, session } = record;
  return JSON.stringify({ repo, pr, headSha, patchId, question, answer, time, session });
}

function loadKey(dir, { create }) {
  const keyPath = path.join(dir, ".key");
  if (fs.existsSync(keyPath)) return Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "hex");
  if (!create) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  fs.writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
  return key;
}

const sign = (key, record) => createHmac("sha256", key).update(canonical(record)).digest("hex");

/** Write a signed record. The file name is the record id, so the comment marker names its record. */
export function writeApprovalRecord({ approval, session = null, now = new Date() }, env = process.env) {
  const dir = approvalDir(env);
  const key = loadKey(dir, { create: true });
  const record = { repo: approval.repo, pr: approval.pr, headSha: approval.headSha, patchId: approval.patchId, question: approval.question, answer: approval.answer, time: now.toISOString(), session };
  const mac = sign(key, record);
  const id = createHmac("sha256", key).update(`id:${mac}`).digest("hex");
  // Temp file plus rename: a crash never leaves a half-written record the merge reader could parse.
  const target = path.join(dir, `${id}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...record, mac }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
  return { id, record };
}

/** Comment body the hook posts: the operator line, then the marker naming the record. */
export function buildApprovalComment({ id, headSha, patchId }) {
  return `${approveMergeLine({ headSha, patchId })}\n${COMMENT_MARKER_PREFIX}${id} -->`;
}

/** The `approve merge <sha> patch-id <id>` facts and the record id of a marked comment body, else null. */
export function parseMarkedComment(body) {
  if (typeof body !== "string") return null;
  const marker = MARKER_RE.exec(body);
  if (!marker) return null;
  const line = /^[ \t>*-]*approve[ \t]+merge[ \t]+([0-9a-f]{40})[ \t]+patch-id[ \t]+([0-9a-f]{40})\b/imu.exec(body);
  return { id: marker[1], headSha: line?.[1] ?? null, patchId: line?.[2] ?? null };
}

function verifyRecord(id, { repo, pr }, env) {
  const dir = approvalDir(env);
  let record;
  let key;
  try {
    key = loadKey(dir, { create: false });
    record = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
  } catch { return null; }
  if (!key || typeof record?.mac !== "string") return null;
  const expected = Buffer.from(sign(key, record), "hex");
  const actual = Buffer.from(record.mac, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  if (record.repo !== repo || record.pr !== pr) return null;
  return record;
}

/**
 * Drop every hook-marked comment that has no valid matching record, or whose record binds another
 * head or patch-id than the comment line, or that matches neither the current head nor the current patch-id.
 * Unmarked comments pass through (the Pi comment-line path). Each refusal names its recovery.
 * @returns {{ comments: object[], refusals: string[] }}
 */
export function filterAskApprovalComments({ comments, repo, pr, currentHeadSha, currentPatchId = null, env = process.env }) {
  const kept = [];
  const refusals = [];
  for (const comment of comments) {
    const marked = parseMarkedComment(comment?.body);
    if (!marked) { kept.push(comment); continue; }
    const record = verifyRecord(marked.id, { repo, pr }, env);
    if (!record) {
      refusals.push(`ask-approval comment ${marked.id.slice(0, 12)} has no valid harness record for ${repo}#${pr} (forged or missing). ${RECOVERY}`);
    } else if (record.headSha !== marked.headSha || record.patchId !== marked.patchId) {
      refusals.push(`ask-approval comment ${marked.id.slice(0, 12)} names another head or patch-id than its record. ${RECOVERY}`);
    } else if (record.headSha !== currentHeadSha && record.patchId !== currentPatchId) {
      refusals.push(`ask-approval record ${marked.id.slice(0, 12)} is for head ${record.headSha} and patch-id ${record.patchId}, not the current head ${currentHeadSha}. ${RECOVERY}`);
    } else kept.push(comment);
  }
  return { comments: kept, refusals };
}

export const ASK_APPROVAL_RECOVERY = RECOVERY;
