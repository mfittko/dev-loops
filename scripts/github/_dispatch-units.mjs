// Pure dispatch-unit helpers shared by the context writer (packing), the
// fan-out emitter (cap-split and scope naming) and the findings-log writer
// (recorded dispatch membership). Kept in one import-cycle-free module: the
// emitter imports both writers, so the writers cannot import the emitter.
import { REVIEWER_UNIT_MAX_ANGLES } from "@dev-loops/core/loop/reviewer-unit-bound";

/**
 * Collapse any run of non-alphanumeric characters to a single hyphen and trim
 * leading/trailing hyphens, so an arbitrary unit name becomes a VALID_SCOPE_RE
 * segment. Pure.
 * @param {string} value
 * @returns {string}
 */
export function sanitizeScopeSegment(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

/**
 * The shared scope-segment derivation for a unit name: strip a leading
 * `group:` auto-chunk marker — otherwise the marker's `:` would sanitize to
 * its own `group-` segment and double up into `group-group-<angles>` — then
 * sanitize with sanitizeScopeSegment. The strip applies whatever the unit's
 * origin: a configured group's name is not guaranteed marker-free either
 * (e.g. a split sub-unit's base name can itself be an auto-chunk name), so
 * this never special-cases config vs auto-chunk. If the stripped result
 * sanitizes to an EMPTY string (a unit literally named `group:` or
 * `group:!!`, whose only content is the marker and/or characters
 * sanitizeScopeSegment strips), fall back to sanitizing the UNSTRIPPED name —
 * this recovers a non-empty segment for a marker-only name like `group:`, but
 * an empty or entirely-non-alphanumeric name (`""`, `undefined` coerced to
 * `""`, or e.g. `"!!"`) still sanitizes to `""` either way, so the segment is
 * NOT guaranteed non-empty. An empty segment collapses `<prefix>group-` to a
 * scope VALID_SCOPE_RE rejects — the emitter's VALID_SCOPE_RE check then
 * refuses the plan fail-closed rather than dispatching under a malformed
 * scope. Shared by dispatchUnitScope (deriving a unit's dispatch scope) and
 * splitSubUnitName (disambiguating a split sub-unit's name against configured
 * group names on exactly the string the scope uses). Pure.
 * @param {string} name a resolved unit's name (may carry the `group:` marker)
 * @returns {string}
 */
export function unitScopeSegment(name) {
  const rawName = name ?? "";
  const stripped = rawName.startsWith("group:") ? rawName.slice("group:".length) : rawName;
  const sanitizedStripped = sanitizeScopeSegment(stripped);
  return sanitizedStripped.length > 0 ? sanitizedStripped : sanitizeScopeSegment(rawName);
}

/**
 * Generate a split sub-unit's scope-distinguishing name: `${baseName}-part${n}`,
 * disambiguated against `configuredGroupNames` on their unitScopeSegment form —
 * the SAME helper dispatchUnitScope applies when deriving a multi-angle unit's
 * scope (strip a leading `group:` auto-chunk marker, then sanitize), so this
 * checks exactly the string the scope uses. Comparing raw names is not enough: a
 * separately-configured "backend_part1" group sanitizes to the SAME
 * "group-backend-part1" scope as a generated "backend-part1" sub-unit even
 * though the raw strings differ, so the collision must be caught here too —
 * while the candidate's unitScopeSegment form is itself a configured group's
 * unitScopeSegment form, append a further suffix until it is not. The
 * emitter's seenScopes guard remains the final backstop for any residual
 * collision this cannot see. Deterministic, pure.
 * @param {string} baseName configured group name being split
 * @param {number} n 1-based split index
 * @param {Set<string>} configuredGroupNames configured gates.fanout.groups names
 * @returns {string}
 */
export function splitSubUnitName(baseName, n, configuredGroupNames) {
  const configuredSegments = new Set(Array.from(configuredGroupNames, (name) => unitScopeSegment(name)));
  let candidate = `${baseName}-part${n}`;
  let bump = 0;
  while (configuredSegments.has(unitScopeSegment(candidate))) {
    bump += 1;
    candidate = `${baseName}-part${n}-x${bump}`;
  }
  return candidate;
}

/**
 * The single normalization for a unit's angle list: keep non-empty string
 * angles, trimmed. Used by both the angle-less refusal pre-check and
 * expandDispatchUnits so the fail-closed guard and the dispatch classification
 * can never disagree on a unit's angle set. Pure.
 * @param {{ angles?: unknown }} unit
 * @returns {string[]}
 */
export function normalizeUnitAngles(unit) {
  return Array.isArray(unit?.angles) ? unit.angles.filter((a) => typeof a === "string" && a.trim().length > 0).map((a) => a.trim()) : [];
}

/**
 * Expand resolveFanoutGroups units into the dispatch units the emitter actually
 * seeds reviewers for: EVERY multi-angle unit — a CONFIGURED `gates.fanout.groups`
 * group or an auto-chunked leftover `group:...` bundle, resolveFanoutGroups
 * draws no distinction between the two for dispatch purposes (ADR 0048's
 * grouped-dispatch-default) — shares ONE reviewer, capped at
 * `REVIEWER_UNIT_MAX_ANGLES` via an ordered cap-split. Only a genuine
 * single-angle unit dispatches as a singleton. The merge guard
 * (`fanoutReviewerPairingError` in `@dev-loops/core/loop/gate-fanin`) is the
 * fail-closed authority: it re-derives this round's base units independently
 * and honors a shared identity only within one recorded dispatch unit. Angle
 * order is preserved, nothing dropped/duplicated/merged. Every emitted unit
 * carries a `group`: the resolved unit's own name (configured or auto-chunk)
 * for a multi-angle unit (whole or split sub-unit), null for a genuine
 * singleton — this is provenance, distinct from `name` (which scopes the
 * reviewer and, for a split sub-unit, is disambiguated via splitSubUnitName).
 * `configuredGroupNames` is used only for that disambiguation (together with
 * this round's own unit names), never to classify a unit as shared vs.
 * singleton. Pure.
 * @param {{ name: string, angles: string[] }[]} units resolveFanoutGroups output
 * @param {Set<string>} configuredGroupNames configured gates.fanout.groups names
 * @returns {{ name: string, angles: string[], group: string|null }[]}
 */
export function expandDispatchUnits(units, configuredGroupNames) {
  const unitList = Array.isArray(units) ? units : [];
  // Disambiguate a split sub-unit's name against every configured group name
  // AND every OTHER unit resolved this round (a configured group's name and an
  // auto-chunk bundle's stable name both key a real emitted scope this round,
  // so both are live collision candidates — not just the configured table).
  const collisionNames = new Set(configuredGroupNames);
  for (const unit of unitList) {
    if (typeof unit?.name === "string" && unit.name.length > 0) collisionNames.add(unit.name);
  }
  const out = [];
  for (const unit of unitList) {
    const angles = normalizeUnitAngles(unit);
    if (angles.length > 1) {
      // A unit within the cap keeps its exact name. A unit LARGER than the cap
      // deterministically splits into ordered ≤cap sub-units, each with a
      // distinct, collision-disambiguated `<name>-part<n>` name. Every sub-unit
      // records the RESOLVED unit's own name as `group`.
      if (angles.length <= REVIEWER_UNIT_MAX_ANGLES) {
        out.push({ name: unit.name, angles, group: unit.name });
      } else {
        for (let i = 0; i < angles.length; i += REVIEWER_UNIT_MAX_ANGLES) {
          const chunk = angles.slice(i, i + REVIEWER_UNIT_MAX_ANGLES);
          const n = i / REVIEWER_UNIT_MAX_ANGLES + 1;
          out.push({ name: splitSubUnitName(unit.name, n, collisionNames), angles: chunk, group: unit.name });
        }
      }
    } else {
      for (const angle of angles) out.push({ name: angle, angles: [angle], group: null });
    }
  }
  return out;
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Pack whole base units (expandDispatchUnits output) into at most `maxUnits`
 * units of at most `REVIEWER_UNIT_MAX_ANGLES` angles: first-fit decreasing by
 * angle count, ties broken by unit name. A base unit is never split. A merged
 * unit's name joins its member unit names in sorted order with `+`, and its
 * angles follow that member order; the emitter derives the provenance `group`
 * from that name. Returns null when no packing fits. Deterministic, pure.
 * @param {{ name: string, angles: string[] }[]} baseUnits
 * @param {number} maxUnits
 * @returns {{ name: string, angles: string[] }[]|null}
 */
export function packDispatchUnits(baseUnits, maxUnits) {
  const order = baseUnits
    .map((unit) => ({ name: unit.name, angles: normalizeUnitAngles(unit) }))
    .sort((a, b) => b.angles.length - a.angles.length || byName(a, b));
  const bins = [];
  for (const unit of order) {
    if (unit.angles.length > REVIEWER_UNIT_MAX_ANGLES) return null;
    const bin = bins.find((candidate) => candidate.size + unit.angles.length <= REVIEWER_UNIT_MAX_ANGLES);
    if (bin) {
      bin.members.push(unit);
      bin.size += unit.angles.length;
    } else if (bins.length < maxUnits) {
      bins.push({ members: [unit], size: unit.angles.length });
    } else {
      return null;
    }
  }
  return bins.map(({ members }) => {
    const sorted = [...members].sort(byName);
    return { name: sorted.map((member) => member.name).join("+"), angles: sorted.flatMap((member) => member.angles) };
  });
}
