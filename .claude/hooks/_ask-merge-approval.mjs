// GENERATED from packages/core/src/github/ask-merge-approval.mjs by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate.
/**
 * Ask-dialog merge approval (MERGE-ASK-APPROVAL, ADR 0315). The Claude PostToolUse hook turns an
 * operator's yes answer to one approval question into a harness-signed record and a marked
 * `approve merge` comment. Once this machine holds the hook key, the merge wrapper accepts an
 * approve-merge comment only with a matching record. Without the key (Pi, other harnesses) the
 * plain comment path is unchanged.
 *
 * Integrity proof: an HMAC-SHA256 over the canonical record, keyed by a 32-byte random key in the
 * approval directory (key mode 0600, directory mode 0700, both owned by this user, no symlinks).
 * The directory sits outside every checkout. The PreToolUse guard hook denies the tool calls it
 * can judge (named paths, case-folded and realpath-resolved) and the shipped settings add
 * permission and sandbox read denies. A process that bypasses the hooks can still read the key.
 * Only node: imports, so the hook bundle vendors this file unchanged.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APPROVAL_DIR_ENV = "DEVLOOPS_APPROVAL_DIR";
// The directory override applies only when this flag is "1": an agent-set variable cannot redirect the verifier.
export const APPROVAL_TEST_FLAG_ENV = "DEVLOOPS_APPROVAL_TEST_MODE";
export const APPROVAL_DIR_NAME = "merge-approvals";
export const COMMENT_MARKER_PREFIX = "<!-- dev-loops:ask-approval id=";
const MARKER_RE = /<!-- dev-loops:ask-approval id=([0-9a-f]{64}) -->/u;
const APPROVE_LINE_RE = /^[ \t>*-]*approve[ \t]+merge\b/gimu;
const RECOVERY = "Recovery: ask the operator the approval question again with the current facts and the options Yes and No: `Approve merge of <owner/name> PR #<n> at head <40-hex> with patch-id <40-hex>?`. The hook then records the yes answer and posts the line.";

export function approvalDir(env = process.env) {
  if (env[APPROVAL_TEST_FLAG_ENV] === "1" && env[APPROVAL_DIR_ENV]) return env[APPROVAL_DIR_ENV];
  return path.join(os.homedir(), ".config", "dev-loops", APPROVAL_DIR_NAME);
}

/** Resolve symlinks of the nearest existing ancestor, then append the missing tail. */
function realResolve(target) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...tail.reverse()); } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

const fold = (p) => p.toLowerCase();

/** True when `target` is the approval directory or below it (lexical or realpath-resolved, case-folded). */
export function isApprovalPath(target, env = process.env) {
  if (typeof target !== "string" || target === "") return false;
  const dirs = [path.resolve(approvalDir(env)), realResolve(approvalDir(env))].map(fold);
  return [path.resolve(target), realResolve(target)].map(fold).some((abs) => dirs.some((dir) => abs === dir || abs.startsWith(`${dir}${path.sep}`)));
}

/** True when a command or argument string names the approval directory or its override variables (case-folded). */
export function commandNamesApprovalDir(command, env = process.env) {
  if (typeof command !== "string") return false;
  const text = fold(command);
  return [APPROVAL_DIR_NAME, APPROVAL_DIR_ENV, APPROVAL_TEST_FLAG_ENV, approvalDir(env)].some((n) => text.includes(fold(n)));
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

/** True when the payload carries an approval question, whatever the answer. */
export function hasApprovalQuestion(payload) {
  const questions = payload?.tool_input?.questions;
  return Array.isArray(questions) && questions.some((q) => parseApprovalQuestion(q?.question) !== null);
}

const isYesNoSingleSelect = (q) => {
  const labels = Array.isArray(q?.options) ? q.options.map((o) => o?.label).sort() : [];
  return q?.multiSelect !== true && labels.length === 2 && labels[0] === "No" && labels[1] === "Yes";
};

/**
 * Extract a yes approval from a PostToolUse AskUserQuestion payload. Reads only `tool_response.answers`
 * (question text to the chosen label) and only the questions in `tool_input.questions` whose options
 * are exactly Yes and No, single select, with the answer exactly `Yes`.
 * @returns {{ repo, pr, headSha, patchId, question, answer }|null}
 */
export function extractYesApproval(payload) {
  const questions = payload?.tool_input?.questions;
  const answers = payload?.tool_response?.answers;
  if (!Array.isArray(questions) || answers === null || typeof answers !== "object") return null;
  for (const q of questions) {
    const text = q?.question;
    if (!isYesNoSingleSelect(q) || answers[text] !== "Yes") continue;
    const facts = parseApprovalQuestion(text);
    if (facts) return { ...facts, question: text, answer: "Yes" };
  }
  return null;
}

function canonical(record) {
  const { repo, pr, headSha, patchId, question, answer, time, session } = record;
  return JSON.stringify({ repo, pr, headSha, patchId, question, answer, time, session });
}

const ownedByMe = (st) => typeof process.getuid !== "function" || st.uid === process.getuid();

/** Refuse a directory that is a symlink, not 0700, or not owned by this user. */
function assertSafeDir(dir) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o777) !== 0o700 || !ownedByMe(st)) throw new Error("approval directory is not a private directory owned by this user");
}

/** Read a 32-byte key file; refuse a symlink, a wrong size, a loose mode or a foreign owner. */
function readKey(keyPath) {
  const st = fs.lstatSync(keyPath);
  if (st.isSymbolicLink() || !st.isFile() || (st.mode & 0o077) !== 0 || !ownedByMe(st)) throw new Error("approval key file is not a private regular file owned by this user");
  const key = fs.readFileSync(keyPath);
  if (key.length !== 32) throw new Error("approval key is not exactly 32 bytes");
  return key;
}

/** True when this machine has the hook key (a file or link exists at the key path). */
export function approvalKeyPresent(env = process.env) {
  try { fs.lstatSync(path.join(approvalDir(env), ".key")); return true; } catch { return false; }
}

function loadKey(dir, { create }) {
  const keyPath = path.join(dir, ".key");
  if (create) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    if (!st.isSymbolicLink() && (st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
  }
  assertSafeDir(dir);
  if (create) {
    try {
      const key = randomBytes(32);
      fs.writeFileSync(keyPath, key, { flag: "wx", mode: 0o600 });
      return key;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  return readKey(keyPath);
}

const sign = (key, record) => createHmac("sha256", key).update(canonical(record)).digest("hex");
const idOf = (key, mac) => createHmac("sha256", key).update(`id:${mac}`).digest("hex");

/** Write a signed record. The file name is the record id, so the comment marker names its record. */
export function writeApprovalRecord({ approval, session = null, now = new Date() }, env = process.env) {
  const dir = approvalDir(env);
  const key = loadKey(dir, { create: true });
  const record = { repo: approval.repo, pr: approval.pr, headSha: approval.headSha, patchId: approval.patchId, question: approval.question, answer: approval.answer, time: now.toISOString(), session };
  const mac = sign(key, record);
  const id = idOf(key, mac);
  // Temp file plus rename: a crash never leaves a half-written record the merge reader could parse. `wx` refuses a planted file or link.
  const target = path.join(dir, `${id}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...record, mac }, null, 2), { flag: "wx", mode: 0o600 });
  fs.renameSync(tmp, target);
  return { id, record };
}

/** Comment body the hook posts: the operator line, then the marker naming the record. */
export function buildApprovalComment({ id, headSha, patchId }) {
  return `${approveMergeLine({ headSha, patchId })}\n${COMMENT_MARKER_PREFIX}${id} -->`;
}

const countApproveLines = (body) => (typeof body === "string" ? (body.match(APPROVE_LINE_RE)?.length ?? 0) : 0);

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
    const file = path.join(dir, `${id}.json`);
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    record = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return null; }
  if (typeof record?.mac !== "string") return null;
  const expected = Buffer.from(sign(key, record), "hex");
  const actual = Buffer.from(record.mac, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  // The record id is derived from the MAC: a record copied under another name is not valid.
  if (idOf(key, record.mac) !== id) return null;
  if (record.repo !== repo || record.pr !== pr) return null;
  return record;
}

/**
 * Drop every approve-merge comment that has no valid matching record. A hook-marked comment needs
 * its record. When this machine holds the hook key, an unmarked approve-merge comment (typed by hand)
 * is dropped too. A marked body with more than one approve-merge line, a record that binds another
 * head or patch-id than the comment line, and a record that matches neither the current head nor the
 * current patch-id are dropped. Without the key, unmarked comments pass through (Pi path).
 * Each refusal names its recovery.
 * @returns {{ comments: object[], refusals: string[] }}
 */
export function filterAskApprovalComments({ comments, repo, pr, currentHeadSha, currentPatchId = null, env = process.env }) {
  const kept = [];
  const refusals = [];
  const keyed = approvalKeyPresent(env);
  const refuse = (reason) => refusals.push(`MERGE-ASK-APPROVAL: ${reason} ${RECOVERY}`);
  for (const comment of comments) {
    const marked = parseMarkedComment(comment?.body);
    if (!marked) {
      if (keyed && countApproveLines(comment?.body) > 0) {
        refuse("an approve-merge comment has no hook marker, and this machine requires the harness record for every approve-merge comment.");
      } else kept.push(comment);
      continue;
    }
    const record = verifyRecord(marked.id, { repo, pr }, env);
    if (countApproveLines(comment.body) > 1) {
      refuse(`ask-approval comment ${marked.id.slice(0, 12)} carries more than one approve-merge line.`);
    } else if (!record) {
      refuse(`ask-approval comment ${marked.id.slice(0, 12)} has no valid harness record for ${repo}#${pr} (forged or missing).`);
    } else if (record.headSha !== marked.headSha || record.patchId !== marked.patchId) {
      refuse(`ask-approval comment ${marked.id.slice(0, 12)} names another head or patch-id than its record.`);
    } else if (record.headSha !== currentHeadSha && record.patchId !== currentPatchId) {
      refuse(`ask-approval record ${marked.id.slice(0, 12)} is for head ${record.headSha} and patch-id ${record.patchId}, not the current head ${currentHeadSha}.`);
    } else kept.push(comment);
  }
  return { comments: kept, refusals };
}

export const ASK_APPROVAL_RECOVERY = RECOVERY;
