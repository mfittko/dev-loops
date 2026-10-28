/**
 * Operator focus (GATE-EXEC-OPERATOR-FOCUS, ADR 0205): a typed, bounded, sanitized
 * carrier for operator context on a judge or fixer work order. The focus guides the
 * work and never changes a disposition. Absent focus adds no key and renders nothing.
 */
import { readFile } from "node:fs/promises";

export class OperatorFocusRefusal extends Error {}

const MAX_CHARS = 500;
const MAX_ITEMS = 20;

function clean(value, label) {
  if (typeof value !== "string") throw new OperatorFocusRefusal(`operator focus ${label} must be a string`);
  if (value.length > MAX_CHARS) throw new OperatorFocusRefusal(`operator focus ${label} is over ${MAX_CHARS} characters`);
  const out = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/[<>`]/g, "").replace(/ +/g, " ").trim();
  if (out === "") throw new OperatorFocusRefusal(`operator focus ${label} is empty after sanitizing`);
  return out;
}

/** Validate and sanitize a raw focus object. Returns null for an absent or empty focus. */
export function normalizeOperatorFocus(raw, { allowItems = false } = {}) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new OperatorFocusRefusal("operator focus must be a JSON object");
  const unknown = Object.keys(raw).filter((key) => key !== "round" && key !== "items");
  if (unknown.length > 0) throw new OperatorFocusRefusal(`operator focus has unknown field(s) ${unknown.join(", ")}`);
  const focus = {};
  if (raw.round !== undefined) focus.round = clean(raw.round, "round");
  if (raw.items !== undefined) {
    if (!allowItems) throw new OperatorFocusRefusal("operator focus items are accepted for the fixer only");
    if (!Array.isArray(raw.items) || raw.items.length > MAX_ITEMS) throw new OperatorFocusRefusal(`operator focus items must be an array of at most ${MAX_ITEMS} entries`);
    const seen = new Set();
    const items = raw.items.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new OperatorFocusRefusal(`operator focus items[${index}] must be an object`);
      const extra = Object.keys(item).filter((key) => key !== "fingerprint" && key !== "decision");
      if (extra.length > 0) throw new OperatorFocusRefusal(`operator focus items[${index}] has unknown field(s) ${extra.join(", ")}`);
      const fingerprint = clean(item.fingerprint, `items[${index}].fingerprint`);
      if (seen.has(fingerprint)) throw new OperatorFocusRefusal(`operator focus has a duplicate fingerprint ${fingerprint}`);
      seen.add(fingerprint);
      return { fingerprint, decision: clean(item.decision, `items[${index}].decision`) };
    });
    if (items.length > 0) focus.items = items;
  }
  return Object.keys(focus).length > 0 ? focus : null;
}

/** Read a focus JSON file. Returns null when no path is given. */
export async function readOperatorFocusFile(file, opts = {}) {
  if (!file) return null;
  const bytes = await readFile(file, "utf8").catch(() => { throw new OperatorFocusRefusal(`operator focus file is missing or unreadable: ${file}`); });
  let raw;
  try { raw = JSON.parse(bytes); } catch { throw new OperatorFocusRefusal(`operator focus file is not JSON: ${file}`); }
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
      if (!act) throw new OperatorFocusRefusal(`operator focus item ${item.fingerprint} is not in the act list`);
      // A summary that sanitizes to nothing is dropped; the bound summary never forges a heading.
      const summary = typeof act.summary === "string" ? act.summary.slice(0, MAX_CHARS) : "";
      let cleaned = "";
      try { cleaned = clean(summary, "summary"); } catch { /* empty after sanitizing: omit */ }
      return { ...item, summary: cleaned };
    }),
  };
}

/** Render the fixed "## Operator focus" section, or an empty string for an absent focus. */
export function renderOperatorFocusSection(focus) {
  if (!focus) return "";
  const lines = ["## Operator focus", "", "The operator supplied this context. A decision picks among remedies an act item offers and never changes its disposition."];
  if (focus.round) lines.push("", `Round: ${focus.round}`);
  for (const item of focus.items ?? []) lines.push("", `Act item ${item.fingerprint}${item.summary ? ` (${item.summary})` : ""}: operator decision: ${item.decision}`);
  return `${lines.join("\n")}\n\n`;
}
