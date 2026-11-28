/**
 * Operator focus (GATE-EXEC-OPERATOR-FOCUS, ADR 0205): a typed, bounded, sanitized
 * carrier for operator context on a reviewer, judge or fixer work order (fan-out, judge and fixer emitters). The focus guides the
 * work and never changes a disposition. Absent focus adds no key and renders nothing.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cleanReplyNote } from "@dev-loops/core/loop/fixer-disposition";

export class OperatorFocusRefusal extends Error {}

const MAX_CHARS = 500;
const MAX_ITEMS = 20;
const ITEM_KEYS = ["fingerprint", "threadId", "decision", "replyDisposition", "replyNote"];
const REPLY_DISPOSITIONS = ["tackled", "partially_fixed", "deferred", "rejected"];

function clean(value, label) {
  if (typeof value !== "string") throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus ${label} must be a string`);
  if (value.length > MAX_CHARS) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus ${label} is over ${MAX_CHARS} characters`);
  const out = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/[<>`]/g, "").replace(/ +/g, " ").trim();
  if (out === "") throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus ${label} is empty after sanitizing`);
  return out;
}

// A reply note is posted by the verifier, so it must pass the reply writer's own guards.
function cleanNote(value, label) {
  try { return cleanReplyNote(value, `GATE-EXEC-OPERATOR-FOCUS: operator focus ${label}`); } catch (error) { throw new OperatorFocusRefusal(error.message); }
}

/** Validate and sanitize a raw focus object. Returns null for an absent or empty focus. */
export function normalizeOperatorFocus(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new OperatorFocusRefusal("GATE-EXEC-OPERATOR-FOCUS: operator focus must be a JSON object");
  const unknown = Object.keys(raw).filter((key) => key !== "round" && key !== "items");
  if (unknown.length > 0) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus has unknown field(s) ${unknown.join(", ")}`);
  const focus = {};
  if (raw.round !== undefined) focus.round = clean(raw.round, "round");
  if (raw.items !== undefined) {
    if (!Array.isArray(raw.items) || raw.items.length > MAX_ITEMS) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus items must be an array of at most ${MAX_ITEMS} entries`);
    const seen = new Set();
    const items = raw.items.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus items[${index}] must be an object`);
      const extra = Object.keys(item).filter((key) => !ITEM_KEYS.includes(key));
      if (extra.length > 0) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus items[${index}] has unknown field(s) ${extra.join(", ")}`);
      if ((item.fingerprint === undefined) === (item.threadId === undefined)) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus items[${index}] needs exactly one of fingerprint and threadId`);
      const out = item.fingerprint !== undefined
        ? { fingerprint: clean(item.fingerprint, `items[${index}].fingerprint`) }
        : { threadId: clean(item.threadId, `items[${index}].threadId`) };
      const key = out.fingerprint ?? out.threadId;
      if (seen.has(key)) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus has a duplicate item ${key}`);
      seen.add(key);
      if (item.decision !== undefined) {
        if (out.threadId) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus items[${index}] is bound by threadId and carries no decision`);
        out.decision = clean(item.decision, `items[${index}].decision`);
      }
      if (item.replyDisposition !== undefined) {
        if (!REPLY_DISPOSITIONS.includes(item.replyDisposition)) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus items[${index}].replyDisposition must be one of ${REPLY_DISPOSITIONS.join(", ")}`);
        out.replyDisposition = item.replyDisposition;
      }
      if (item.replyNote !== undefined) out.replyNote = cleanNote(item.replyNote, `items[${index}].replyNote`);
      if (out.decision === undefined && out.replyDisposition === undefined) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus items[${index}] needs a decision or a replyDisposition`);
      if (out.replyNote !== undefined && out.replyDisposition === undefined) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus items[${index}] has a replyNote and no replyDisposition`);
      if (out.replyDisposition !== undefined && out.replyDisposition !== "tackled" && out.replyNote === undefined) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus items[${index}] replyDisposition ${out.replyDisposition} needs a replyNote`);
      return out;
    });
    if (items.length > 0) focus.items = items;
  }
  return Object.keys(focus).length > 0 ? focus : null;
}

/** Read a focus JSON file. Returns null when no path is given. */
export async function readOperatorFocusFile(file) {
  if (!file) return null;
  const bytes = await readFile(file, "utf8").catch(() => { throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus file is missing or unreadable: ${file}`); });
  let raw;
  try { raw = JSON.parse(bytes); } catch { throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus file is not JSON: ${file}`); }
  return normalizeOperatorFocus(raw);
}

/** Fingerprints of act items the operator deferred: a fingerprint item whose decision starts with defer, deferred or deferring, or whose replyDisposition is deferred. */
export const deferredFingerprints = (focus) => new Set((focus?.items ?? []).filter((item) => item.fingerprint !== undefined && (/^defer(?:red|ring)?\b/i.test(item.decision ?? "") || item.replyDisposition === "deferred")).map((item) => item.fingerprint));

/**
 * Bind each item to its source. A fingerprint item binds to an act item and records its summary; a threadId item
 * binds to a thread of the threads source. An item of the other kind, or one the source lacks, refuses.
 */
export function bindOperatorFocusItems(focus, actList, threadIds) {
  if (!focus?.items) return focus;
  const byFingerprint = new Map((actList ?? []).map((act) => [act.fingerprint, act]));
  const threads = new Set(threadIds ?? []);
  return {
    ...focus,
    items: focus.items.map((item) => {
      if (item.threadId !== undefined) {
        if (!threads.has(item.threadId)) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus item ${item.threadId} is not a thread of the --threads-file source`);
        return item;
      }
      const act = byFingerprint.get(item.fingerprint);
      if (!act) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus item ${item.fingerprint} is not in the act list`);
      // A summary that sanitizes to nothing is dropped; the bound summary never forges a heading.
      const summary = typeof act.summary === "string" ? act.summary.slice(0, MAX_CHARS) : "";
      let cleaned = "";
      try { cleaned = clean(summary, "summary"); } catch { /* empty after sanitizing: omit */ }
      return cleaned ? { ...item, summary: cleaned } : { ...item };
    }),
  };
}

/** Render the fixed "## Operator focus" section, or an empty string for an absent focus. */
export function renderOperatorFocusSection(focus) {
  if (!focus) return "";
  const lines = ["## Operator focus", "", "The operator supplied this context. A decision picks among remedies an act item offers and never changes its disposition. A reply disposition of deferred or rejected means make no code change for that thread, and partially_fixed means leave undone what the note names."];
  if (focus.round) lines.push("", `Round: ${focus.round}`);
  for (const item of focus.items ?? []) {
    const label = item.threadId ? `Thread ${item.threadId}` : `Act item ${item.fingerprint}`;
    lines.push("");
    if (item.decision) lines.push(`${label}: operator decision: ${item.decision}`);
    if (item.replyDisposition) lines.push(`${label}: operator reply disposition: ${item.replyDisposition}${item.replyNote ? `; reply note: ${item.replyNote}` : ""}`);
    // Reviewer-authored text never sits on the operator decision line; it is a quoted value on its own line.
    if (item.summary) lines.push(`Act-list text for ${item.fingerprint} (reviewer-authored, not an operator decision): ${JSON.stringify(item.summary)}`);
  }
  return `${lines.join("\n")}\n\n`;
}

/**
 * Exact-content digest of a normalized, bound focus. The shared work-order canonicalizer drops
 * strings that look like absolute paths, so the digest alone cannot tell `/a: x` from `/b: x`.
 * Returns an `operatorFocusDigest` entry to spread into the work order, or nothing for no focus.
 */
export function operatorFocusDigestEntry(focus) {
  return focus ? { operatorFocusDigest: createHash("sha256").update(JSON.stringify(focus)).digest("hex") } : {};
}
