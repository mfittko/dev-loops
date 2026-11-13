/**
 * Operator focus (GATE-EXEC-OPERATOR-FOCUS, ADR 0205): a typed, bounded, sanitized
 * carrier for operator context on a reviewer, judge or fixer work order (fan-out, judge and fixer emitters). The focus guides the
 * work and never changes a disposition. The `residue` field is accepted by consolidate-fanin.mjs only
 * (GATE-EXEC-ROUTED-RESIDUE-INPUT, ADR 0243). Absent focus adds no key and renders nothing.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SEVERITY_ORDER, VALID_SEVERITIES, normalizeSeverity } from "@dev-loops/core/loop/gate-fanin";

export class OperatorFocusRefusal extends Error {}

const MAX_CHARS = 500;
const MAX_ITEMS = 20;

function clean(value, label) {
  if (typeof value !== "string") throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus ${label} must be a string`);
  if (value.length > MAX_CHARS) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus ${label} is over ${MAX_CHARS} characters`);
  const out = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/[<>`]/g, "").replace(/ +/g, " ").trim();
  if (out === "") throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus ${label} is empty after sanitizing`);
  return out;
}

function residueSeverity(value, index) {
  if (!VALID_SEVERITIES.has(normalizeSeverity(value))) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus residue[${index}].severity "${value}" is not one of ${SEVERITY_ORDER.join("|")}`);
  return value;
}

/** Validate and sanitize a raw focus object. Returns null for an absent or empty focus. */
export function normalizeOperatorFocus(raw, { allowItems = false, allowResidue = false } = {}) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new OperatorFocusRefusal("GATE-EXEC-OPERATOR-FOCUS: operator focus must be a JSON object");
  const unknown = Object.keys(raw).filter((key) => key !== "round" && key !== "items" && key !== "residue");
  if (unknown.length > 0) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus has unknown field(s) ${unknown.join(", ")}`);
  const focus = {};
  if (raw.round !== undefined) focus.round = clean(raw.round, "round");
  if (raw.items !== undefined) {
    if (!allowItems) throw new OperatorFocusRefusal("GATE-EXEC-OPERATOR-FOCUS: operator focus items are accepted for the fixer only");
    if (!Array.isArray(raw.items) || raw.items.length > MAX_ITEMS) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus items must be an array of at most ${MAX_ITEMS} entries`);
    const seen = new Set();
    const items = raw.items.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus items[${index}] must be an object`);
      const extra = Object.keys(item).filter((key) => key !== "fingerprint" && key !== "decision");
      if (extra.length > 0) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus items[${index}] has unknown field(s) ${extra.join(", ")}`);
      const fingerprint = clean(item.fingerprint, `items[${index}].fingerprint`);
      if (seen.has(fingerprint)) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus has a duplicate fingerprint ${fingerprint}`);
      seen.add(fingerprint);
      return { fingerprint, decision: clean(item.decision, `items[${index}].decision`) };
    });
    if (items.length > 0) focus.items = items;
  }
  if (raw.residue !== undefined) {
    if (!allowResidue) throw new OperatorFocusRefusal("GATE-EXEC-OPERATOR-FOCUS: operator focus residue is accepted for fan-in only");
    if (!Array.isArray(raw.residue) || raw.residue.length > MAX_ITEMS) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus residue must be an array of at most ${MAX_ITEMS} entries`);
    const residue = raw.residue.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus residue[${index}] must be an object`);
      const extra = Object.keys(entry).filter((key) => !["summary", "severity", "file", "line"].includes(key));
      if (extra.length > 0) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus residue[${index}] has unknown field(s) ${extra.join(", ")}`);
      if (entry.line !== undefined && !(Number.isInteger(entry.line) && entry.line > 0)) throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus residue[${index}].line must be a positive integer`);
      return {
        summary: clean(entry.summary, `residue[${index}].summary`),
        ...(entry.severity !== undefined ? { severity: residueSeverity(clean(entry.severity, `residue[${index}].severity`), index) } : {}),
        ...(entry.file !== undefined ? { file: clean(entry.file, `residue[${index}].file`) } : {}),
        ...(entry.line !== undefined ? { line: entry.line } : {}),
      };
    });
    if (residue.length > 0) focus.residue = residue;
  }
  return Object.keys(focus).length > 0 ? focus : null;
}

/** Read a focus JSON file. Returns null when no path is given. */
export async function readOperatorFocusFile(file, opts = {}) {
  if (!file) return null;
  const bytes = await readFile(file, "utf8").catch(() => { throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus file is missing or unreadable: ${file}`); });
  let raw;
  try { raw = JSON.parse(bytes); } catch { throw new OperatorFocusRefusal(`GATE-EXEC-OPERATOR-FOCUS: operator focus file is not JSON: ${file}`); }
  return normalizeOperatorFocus(raw, opts);
}

/** Bind each item to an act item by fingerprint and record its summary. An unknown fingerprint refuses. */
export function bindOperatorFocusItems(focus, actList) {
  if (!focus?.items) return focus;
  const byFingerprint = new Map(actList.map((act) => [act.fingerprint, act]));
  return {
    ...focus,
    items: focus.items.map((item) => {
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
  const lines = ["## Operator focus", "", "The operator supplied this context. A decision picks among remedies an act item offers and never changes its disposition."];
  if (focus.round) lines.push("", `Round: ${focus.round}`);
  for (const item of focus.items ?? []) {
    lines.push("", `Act item ${item.fingerprint}: operator decision: ${item.decision}`);
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
