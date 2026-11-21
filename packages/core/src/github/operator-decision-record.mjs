/**
 * Operator decision record (OPERATOR-DECISION-RECORDER): the pure comment builder, header parser and
 * answer-file validator behind `dev-loops decision record`. Slice 1 writes the record-only kinds
 * (`accept`, `exempt`, `defer`); no gate reads them as evidence. Pure; no I/O.
 */
import { createHash } from "node:crypto";

export const RECORD_ONLY_KINDS = Object.freeze(["accept", "exempt", "defer"]);
// Kinds the design names but a later slice writes; the recorder refuses them until then.
export const LATER_SLICE_KINDS = Object.freeze(["approve-merge", "adr-allow", "copilot-disposition"]);

const HEAD_RE = /^[0-9a-f]{40}$/u;
const HEADER_RE = /^<!-- dev-loops:operator-decision kind=([a-z-]+) target=(pr|issue)-(\d+) head=([0-9a-f]{40}|none) answer-sha256=([0-9a-f]{64}) -->$/u;
export const HEADER_MARKER = "dev-loops:operator-decision";
const REASON_LINES = Object.freeze({
  accept: "Operator decision: accept (recorded from the operator's answer in the session).",
  exempt: "Operator decision: exempt (record only; no gate reads it).",
  defer: "Operator decision: defer (record only; the judge disposition is unchanged).",
});

/** Throws for an unknown kind or a kind a later slice writes. */
export function assertSupportedKind(kind) {
  if (RECORD_ONLY_KINDS.includes(kind)) return kind;
  if (LATER_SLICE_KINDS.includes(kind)) throw new Error(`--kind ${kind} is not yet supported by the decision recorder (it writes accept, exempt and defer)`);
  throw new Error(`--kind must be one of ${[...RECORD_ONLY_KINDS, ...LATER_SLICE_KINDS].join(", ")}; got ${JSON.stringify(kind)}`);
}

/** Parse the operator answer file: JSON with non-empty string `question`, `option` and `answer`. Throws on any other shape. */
export function parseAnswerFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("the operator answer file is not valid JSON; it must hold {question, option, answer}");
  }
  for (const key of ["question", "option", "answer"]) {
    if (typeof data?.[key] !== "string" || data[key].trim() === "") throw new Error(`the operator answer file needs a non-empty string "${key}"`);
  }
  if (/[\r\n]/u.test(data.option)) throw new Error('the operator answer file "option" must be one line');
  return { question: data.question, option: data.option, answer: data.answer };
}

/** SHA-256 of the full answer-file bytes (a Buffer; a string hashes as UTF-8). */
export const answerSha256 = (answerBytes) => createHash("sha256").update(answerBytes).digest("hex");

const quote = (text) => text.split(/\r\n|\r|\n/u).map((line) => `> ${line}`).join("\n");

/** The decision comment. `head` is a 40-hex SHA for a PR target and null for an issue target. */
export function buildDecisionComment({ kind, targetType, number, head, answerBytes, answer, body }) {
  const header = `<!-- dev-loops:operator-decision kind=${kind} target=${targetType}-${number} head=${head ?? "none"} answer-sha256=${answerSha256(answerBytes)} -->`;
  return [
    REASON_LINES[kind],
    header,
    "",
    "Question:",
    quote(answer.question),
    "",
    `Chosen option: ${answer.option}`,
    "Answer:",
    quote(answer.answer),
    "",
    body.trim(),
  ].join("\n");
}

/** Header fields of a decision comment (the header is line 2), or null when it carries none. */
export function parseDecisionHeader(comment) {
  const m = HEADER_RE.exec(comment.split(/\r?\n/u)[1] ?? "");
  return m ? { kind: m[1], targetType: m[2], number: Number(m[3]), head: m[4] === "none" ? null : m[4], answerSha256: m[5] } : null;
}

export const isFullHead = (value) => typeof value === "string" && HEAD_RE.test(value);
