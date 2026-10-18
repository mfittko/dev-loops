import { GATE_FULL_LABEL, GATE_LIGHT_LABEL, GATE_REDUCED_LABEL } from "./config.mjs";

const TRACKS = new Set(["light", "reduced", "full"]);
const RECORD_KEYS = new Set(["schemaVersion", "headSha", "track", "signals"]);
const SIGNAL_KEYS = new Set(["signal", "reason"]);
const LOWERING_LABEL = { light: GATE_LIGHT_LABEL, reduced: GATE_REDUCED_LABEL };

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const hasOnlyKeys = (obj, allowed) => Object.keys(obj).every((k) => allowed.has(k));

/**
 * Strict, pure validation of a judge track record.
 * @param {unknown} record
 * @returns {{ ok: true, record: object } | { ok: false, reason: string }}
 */
export function validateJudgeTrackRecord(record) {
  if (!isPlainObject(record)) return { ok: false, reason: "record_not_object" };
  if (!hasOnlyKeys(record, RECORD_KEYS)) return { ok: false, reason: "unknown_key" };
  if (record.schemaVersion !== 1) return { ok: false, reason: "bad_schema_version" };
  if (typeof record.headSha !== "string" || !/^[0-9a-f]{40}$/i.test(record.headSha)) {
    return { ok: false, reason: "bad_head_sha" };
  }
  if (!TRACKS.has(record.track)) return { ok: false, reason: "unknown_track" };
  if (!Array.isArray(record.signals) || record.signals.length === 0) {
    return { ok: false, reason: "signals_empty" };
  }
  for (const s of record.signals) {
    if (!isPlainObject(s) || !hasOnlyKeys(s, SIGNAL_KEYS) || !nonEmptyString(s.signal) || !nonEmptyString(s.reason)) {
      return { ok: false, reason: "bad_signal" };
    }
  }
  return { ok: true, record };
}

/**
 * Effective judge track. A lowering track counts only for a valid record on
 * the current head whose track matches exactly one lowering label. Every other
 * input fails closed to "full".
 * @param {{ record?: unknown, labels?: string[], headSha?: string }} input
 * @returns {{ track: "light"|"reduced"|"full", reason: string }}
 */
export function resolveJudgeTrack({ record, labels, headSha } = {}) {
  if (record == null) return { track: "full", reason: "judge_record_absent" };
  const checked = validateJudgeTrackRecord(record);
  if (!checked.ok) return { track: "full", reason: "judge_record_invalid" };
  if (checked.record.track === "full") return { track: "full", reason: "judge_full" };
  if (typeof headSha !== "string" || headSha.toLowerCase() !== checked.record.headSha.toLowerCase()) {
    return { track: "full", reason: "judge_head_mismatch" };
  }
  const normalized = (Array.isArray(labels) ? labels : []).map((l) => String(l).trim().toLowerCase());
  if (normalized.includes(GATE_FULL_LABEL)) return { track: "full", reason: "judge_gate_full_label" };
  const lowering = normalized
    .filter((l) => l === GATE_LIGHT_LABEL || l === GATE_REDUCED_LABEL);
  if (lowering.length !== 1 || lowering[0] !== LOWERING_LABEL[checked.record.track]) {
    return { track: "full", reason: "judge_label_unmatched" };
  }
  return { track: checked.record.track, reason: `judge_${checked.record.track}` };
}
