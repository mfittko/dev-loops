import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UI_REVIEW_LENS_NAMES,
  UI_REVIEW_OUTCOMES,
  convergeUiReviewLenses,
  convergeUiReviewRouteFindings,
  lensFindingDedupeKey,
  validateUiReviewLensResults,
} from '../../scripts/loop/ui-review-lenses.mjs';

const AC = ['first acceptance criterion'];

/** Converge/validate options with a valid single-criterion AC list by default. */
const opts = (over = {}) => ({ acceptanceCriteria: AC, ...over });

const F = (over = {}) => ({
  stateName: 'empty-state',
  region: '#main .card',
  category: 'color-contrast',
  severity: 'medium',
  blocking: false,
  acceptanceCriterionRef: 'AC1',
  ...over,
});

/** A complete 4-lens set with each lens carrying the given findings. */
function lensSet({ a11y = [], 'layout-geometry': geometry = [], visual = [], interaction = [] } = {}) {
  return [
    { lens: 'a11y', findings: a11y },
    { lens: 'layout-geometry', findings: geometry },
    { lens: 'visual', findings: visual },
    { lens: 'interaction', findings: interaction },
  ];
}

test('the four canonical lenses are named and stable', () => {
  assert.deepEqual(UI_REVIEW_LENS_NAMES, ['a11y', 'layout-geometry', 'visual', 'interaction']);
});

test('dedupe key normalizes (stateName, region, category)', () => {
  assert.equal(
    lensFindingDedupeKey(F({ stateName: ' Empty-State ', region: '#Main .Card', category: 'Color-Contrast' })),
    lensFindingDedupeKey(F({ stateName: 'empty-state', region: '#main .card', category: 'color-contrast' })),
  );
});

test('converge dedups cross-lens duplicates into one representative with merged provenance', () => {
  const { findings } = convergeUiReviewLenses(lensSet({
    a11y: [F({ severity: 'medium' })],
    visual: [F({ severity: 'medium' })],
  }), opts());
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].lenses, ['a11y', 'visual']);
});

test('precedence: the worse severity wins when two lenses report the same defect', () => {
  const { findings } = convergeUiReviewLenses(lensSet({
    a11y: [F({ severity: 'high' })],
    visual: [F({ severity: 'low' })],
  }), opts());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
  assert.deepEqual(findings[0].lenses, ['a11y', 'visual']);
});

test('distinct defects on the same state are kept, ordered worst-first then by region/category', () => {
  const { findings } = convergeUiReviewLenses(lensSet({
    a11y: [F({ region: '#b', category: 'z', severity: 'low' })],
    visual: [F({ region: '#a', category: 'x', severity: 'high' })],
  }), opts());
  assert.equal(findings.length, 2);
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[1].severity, 'low');
});

test('output ordering is deterministic regardless of input lens/finding order', () => {
  const a = convergeUiReviewLenses(lensSet({
    a11y: [F({ stateName: 'b', category: 'x' }), F({ stateName: 'a', category: 'y' })],
  }), opts());
  const b = convergeUiReviewLenses(lensSet({
    interaction: [F({ stateName: 'a', category: 'y' })],
    a11y: [F({ stateName: 'b', category: 'x' })],
  }), opts());
  assert.deepEqual(a.findings.map((f) => `${f.stateName}/${f.category}`), b.findings.map((f) => `${f.stateName}/${f.category}`));
});

test('outcome: no must-fix findings AND every AC covered ⇒ satisfied', () => {
  const { outcome } = convergeUiReviewLenses(lensSet({ visual: [F({ severity: 'low' })] }), opts());
  assert.equal(outcome, UI_REVIEW_OUTCOMES.SATISFIED);
});

test('outcome: a must-fix/high finding ⇒ not satisfied (continue fix loop)', () => {
  assert.equal(convergeUiReviewLenses(lensSet({ interaction: [F({ severity: 'must-fix' })] }), opts()).outcome, UI_REVIEW_OUTCOMES.CONTINUE);
  assert.equal(convergeUiReviewLenses(lensSet({ a11y: [F({ severity: 'high' })] }), opts()).outcome, UI_REVIEW_OUTCOMES.CONTINUE);
});

test('outcome: a fail-closed (blocking) signal ⇒ blocked, taking precedence over continue', () => {
  const { outcome } = convergeUiReviewLenses(lensSet({
    interaction: [F({ severity: 'must-fix' })],
    visual: [F({ region: '#conflict', category: 'design', severity: 'high', blocking: true })],
  }), opts());
  assert.equal(outcome, UI_REVIEW_OUTCOMES.BLOCKED);
});

test('an all-clean set with no coverage checks is NOT satisfied (coverage gap ⇒ continue)', () => {
  const { findings, outcome, coverage } = convergeUiReviewLenses(lensSet(), opts());
  assert.deepEqual(findings, []);
  assert.equal(outcome, UI_REVIEW_OUTCOMES.CONTINUE);
  assert.deepEqual(coverage.uncovered, ['AC1']);
  assert.equal(coverage.satisfiedBarMet, false);
});

test('an all-clean set becomes satisfied once every AC is covered by an affirmative check', () => {
  const { findings, outcome, coverage } = convergeUiReviewLenses(lensSet(), opts({
    checkedCriteria: [{ acceptanceCriterionRef: 'AC1', stateName: 'empty-state' }],
  }));
  assert.deepEqual(findings, []);
  assert.equal(outcome, UI_REVIEW_OUTCOMES.SATISFIED);
  assert.deepEqual(coverage.covered, ['AC1']);
  assert.equal(coverage.satisfiedBarMet, true);
});

test('validator rejects a missing lens fail-closed', () => {
  const result = validateUiReviewLensResults([
    { lens: 'a11y', findings: [] },
    { lens: 'layout-geometry', findings: [] },
    { lens: 'visual', findings: [] },
  ], AC);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked_missing_lens');
  assert.ok(result.missing.includes('lens:interaction'));
});

test('validator rejects a malformed finding fail-closed', () => {
  const result = validateUiReviewLensResults(lensSet({ a11y: [F({ severity: 'catastrophic' })] }), AC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lens_finding_malformed');
  assert.ok(result.missing.some((m) => m.endsWith('.severity')));
});

test('validator rejects an unknown or duplicate lens', () => {
  assert.equal(validateUiReviewLensResults([...lensSet(), { lens: 'novel', findings: [] }], AC).ok, false);
  assert.equal(validateUiReviewLensResults([...lensSet(), { lens: 'a11y', findings: [] }], AC).ok, false);
});

test('validator accepts a complete, well-formed set', () => {
  assert.equal(validateUiReviewLensResults(lensSet({ a11y: [F()] }), AC).ok, true);
});

test('converge fails closed (throws) on a partial lens-result set rather than converging it', () => {
  assert.throws(() => convergeUiReviewLenses([{ lens: 'a11y', findings: [] }], opts()), /refusing to converge/);
});

test('a blocking signal survives the merge onto the single representative', () => {
  // Same (stateName, region, category) triple across two lenses: one blocking, one not.
  const { findings, outcome } = convergeUiReviewLenses(lensSet({
    a11y: [F({ severity: 'high', blocking: false })],
    visual: [F({ severity: 'high', blocking: true })],
  }), opts());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].blocking, true);
  assert.equal(outcome, UI_REVIEW_OUTCOMES.BLOCKED);
});

test('the worse severity wins even when the milder duplicate is processed first', () => {
  // a11y (processed first) reports low; visual (processed later) reports high.
  const { findings } = convergeUiReviewLenses(lensSet({
    a11y: [F({ severity: 'low' })],
    visual: [F({ severity: 'high' })],
  }), opts());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
});

test('validator rejects a non-array lens-result set fail-closed', () => {
  const result = validateUiReviewLensResults(null, AC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lens_results_not_array');
  assert.deepEqual(result.missing, ['lensResults']);
});

test('validator rejects a finding missing region fail-closed', () => {
  const result = validateUiReviewLensResults(lensSet({ a11y: [F({ region: '' })] }), AC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lens_finding_malformed');
  assert.ok(result.missing.some((m) => m.endsWith('.region')));
});

test('validator rejects a non-boolean blocking field fail-closed', () => {
  const result = validateUiReviewLensResults(lensSet({ a11y: [F({ blocking: 'yes' })] }), AC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lens_finding_malformed');
  assert.ok(result.missing.some((m) => m.endsWith('.blocking')));
});

test('validator rejects a finding that OMITS blocking fail-closed', () => {
  // `blocking` is required — a finding missing it must not read as non-blocking.
  const { blocking, ...noBlocking } = F();
  const result = validateUiReviewLensResults(lensSet({ a11y: [noBlocking] }), AC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lens_finding_malformed');
  assert.ok(result.missing.some((m) => m.endsWith('.blocking')));
});

test('validator requires a non-empty acceptance-criteria list fail-closed', () => {
  for (const badAc of [undefined, null, [], ['   '], 'not-an-array', [1, 2]]) {
    const result = validateUiReviewLensResults(lensSet({ a11y: [F()] }), badAc);
    assert.equal(result.ok, false, `acceptanceCriteria=${JSON.stringify(badAc)} must be rejected`);
    assert.equal(result.status, 'blocked_missing_acceptance_criteria');
    assert.deepEqual(result.missing, ['acceptanceCriteria']);
  }
});

test('validator rejects a finding missing acceptanceCriterionRef fail-closed', () => {
  const { acceptanceCriterionRef, ...noRef } = F();
  const result = validateUiReviewLensResults(lensSet({ a11y: [noRef] }), AC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lens_finding_malformed');
  assert.ok(result.missing.some((m) => m.endsWith('.acceptanceCriterionRef')));
});

test('validator rejects a finding whose acceptanceCriterionRef does not map to a known AC', () => {
  // AC list has one criterion (AC1); AC2/AC0/foo are unmappable ⇒ fail-closed, never silently satisfied.
  for (const badRef of ['AC2', 'AC0', 'foo', 'AC', '']) {
    const result = validateUiReviewLensResults(lensSet({ a11y: [F({ acceptanceCriterionRef: badRef })] }), AC);
    assert.equal(result.ok, false, `acceptanceCriterionRef=${badRef} must be rejected`);
    assert.equal(result.reason, 'lens_finding_malformed');
    assert.ok(result.missing.some((m) => m.endsWith('.acceptanceCriterionRef')));
  }
});

test('route entrypoint groups the flat template findings by lens and converges them', () => {
  // The vision template emits ONE flat findings array, each finding tagged with its lens.
  const { findings, outcome } = convergeUiReviewRouteFindings([
    { lens: 'a11y', ...F({ severity: 'high' }) },
    { lens: 'visual', ...F({ severity: 'low' }) },
  ], opts());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
  assert.deepEqual(findings[0].lenses, ['a11y', 'visual']);
  assert.equal(outcome, UI_REVIEW_OUTCOMES.CONTINUE);
});

test('route entrypoint fails closed on an unknown-lens finding rather than dropping it', () => {
  assert.throws(() => convergeUiReviewRouteFindings([{ lens: 'novel', ...F() }], opts()), /refusing to converge/);
});

test('validator rejects a prototype-chain severity (toString/constructor) fail-closed', () => {
  for (const poison of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    const result = validateUiReviewLensResults(lensSet({ a11y: [F({ severity: poison })] }), AC);
    assert.equal(result.ok, false, `severity=${poison} must be rejected`);
    assert.equal(result.reason, 'lens_finding_malformed');
    assert.ok(result.missing.some((m) => m.endsWith('.severity')));
  }
});

test('converge fails closed on a prototype-chain severity rather than silently downgrading it', () => {
  // `in` would let severity:"toString" pass, then SEVERITY_RANK["toString"] is a
  // prototype fn ⇒ NaN comparisons ⇒ isMustFixFinding false ⇒ wrongly satisfied.
  assert.throws(
    () => convergeUiReviewRouteFindings([{ lens: 'a11y', ...F({ severity: 'toString' }) }], opts()),
    /refusing to converge/,
  );
  assert.throws(
    () => convergeUiReviewRouteFindings([{ lens: 'a11y', ...F({ severity: 'constructor' }) }], opts()),
    /refusing to converge/,
  );
});

test('route entrypoint fails closed on a non-array input', () => {
  assert.throws(() => convergeUiReviewRouteFindings(null, opts()), /expected a findings array/);
});

test('validator rejects a lens whose findings field is not an array', () => {
  const result = validateUiReviewLensResults([
    { lens: 'a11y', findings: 'x' },
    { lens: 'layout-geometry', findings: [] },
    { lens: 'visual', findings: [] },
    { lens: 'interaction', findings: [] },
  ], AC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lens_finding_malformed');
  assert.ok(result.missing.some((m) => m.endsWith('findings')));
});

test('validator rejects a non-object finding (null) fail-closed', () => {
  const result = validateUiReviewLensResults(lensSet({ a11y: [null] }), AC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lens_finding_malformed');
  assert.ok(result.missing.some((m) => m.endsWith('findings[0]')));
});

test('validator rejects a lens entry with an empty/undefined lens name', () => {
  for (const badName of ['', undefined]) {
    const result = validateUiReviewLensResults([
      { lens: badName, findings: [] },
      { lens: 'layout-geometry', findings: [] },
      { lens: 'visual', findings: [] },
      { lens: 'interaction', findings: [] },
    ], AC);
    assert.equal(result.ok, false, `lens=${String(badName)} must be rejected`);
    assert.ok(result.missing.some((m) => m.endsWith('.lens')));
  }
});

test('converge carries suggestedFix through to the representative finding', () => {
  const { findings } = convergeUiReviewLenses(lensSet({
    a11y: [F({ severity: 'high', suggestedFix: 'add an accessible name' })],
  }), opts());
  assert.equal(findings[0].suggestedFix, 'add an accessible name');
});

test('the worse-severity representative keeps its own suggestedFix across a merge', () => {
  const { findings } = convergeUiReviewLenses(lensSet({
    a11y: [F({ severity: 'low', suggestedFix: 'mild fix' })],
    visual: [F({ severity: 'high', suggestedFix: 'the real fix' })],
  }), opts());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[0].suggestedFix, 'the real fix');
});

test('validator rejects a finding whose stateName/region/category contains the dedupe separator', () => {
  const NUL = String.fromCharCode(0); // the U+0000 dedupe-key separator, kept out of the source as raw bytes
  for (const field of ['stateName', 'region', 'category']) {
    const result = validateUiReviewLensResults(lensSet({ a11y: [F({ [field]: `a${NUL}b` })] }), AC);
    assert.equal(result.ok, false, `${field} containing the separator must be rejected`);
    assert.equal(result.reason, 'lens_finding_malformed');
    assert.ok(result.missing.some((m) => m.endsWith(`.${field}`)));
  }
});

test('a severity-tie representative is deterministic regardless of input lens order', () => {
  const a11yFinding = F({ severity: 'medium', problem: 'a11y problem', suggestedFix: 'a11y fix' });
  const visualFinding = F({ severity: 'medium', problem: 'visual problem', suggestedFix: 'visual fix' });
  const set = lensSet({ a11y: [a11yFinding], visual: [visualFinding] });
  const forward = convergeUiReviewLenses(set, opts());
  const reverse = convergeUiReviewLenses([...set].reverse(), opts());
  assert.equal(forward.findings.length, 1);
  assert.equal(reverse.findings.length, 1);
  // The earlier canonical lens (a11y) supplies the descriptive fields, both orders.
  assert.equal(forward.findings[0].problem, 'a11y problem');
  assert.deepEqual(forward.findings[0], reverse.findings[0]);
});

// --- Per-criterion coverage gate (Stage 6) ---

test('every converged finding carries the acceptanceCriterionRef it was tagged with', () => {
  const { findings } = convergeUiReviewLenses(lensSet({ a11y: [F({ acceptanceCriterionRef: 'AC1' })] }), opts());
  assert.equal(findings[0].acceptanceCriterionRef, 'AC1');
});

test('acceptanceCriterionRef survives a cross-lens merge — the winning lens\'s ref is kept', () => {
  const twoAc = ['first criterion', 'second criterion'];
  // Same (stateName, region, category) triple across two lenses; a11y is the
  // worse-severity winner, so ITS ref (AC1) propagates to the merged representative.
  const bySeverity = convergeUiReviewLenses(lensSet({
    a11y: [F({ severity: 'high', acceptanceCriterionRef: 'AC1' })],
    visual: [F({ severity: 'low', acceptanceCriterionRef: 'AC2' })],
  }), opts({ acceptanceCriteria: twoAc }));
  assert.equal(bySeverity.findings.length, 1);
  assert.equal(bySeverity.findings[0].acceptanceCriterionRef, 'AC1');

  // On a severity tie the earlier canonical lens (a11y) wins ⇒ its ref survives,
  // independent of input lens order.
  const byTie = convergeUiReviewLenses(lensSet({
    visual: [F({ severity: 'medium', acceptanceCriterionRef: 'AC2' })],
    a11y: [F({ severity: 'medium', acceptanceCriterionRef: 'AC1' })],
  }), opts({ acceptanceCriteria: twoAc }));
  assert.equal(byTie.findings.length, 1);
  assert.equal(byTie.findings[0].acceptanceCriterionRef, 'AC1');
});

test('a merged defect is credited to its primary (winning) criterion; the loser AC reads uncovered', () => {
  const twoAc = ['first criterion', 'second criterion'];
  // Same triple, two lenses, different ACs: a11y (AC1) wins the severity tie over
  // visual (AC2). Coverage credits only AC1; AC2 surfaces as an uncovered gap and
  // downgrades to continue — intentional fail-closed behavior (dedupe excludes the ref).
  const { findings, outcome, coverage } = convergeUiReviewLenses(lensSet({
    a11y: [F({ severity: 'low', acceptanceCriterionRef: 'AC1' })],
    visual: [F({ severity: 'low', acceptanceCriterionRef: 'AC2' })],
  }), opts({ acceptanceCriteria: twoAc }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].acceptanceCriterionRef, 'AC1');
  assert.deepEqual(coverage.covered, ['AC1']);
  assert.deepEqual(coverage.uncovered, ['AC2']);
  assert.equal(coverage.satisfiedBarMet, false);
  assert.equal(outcome, UI_REVIEW_OUTCOMES.CONTINUE);
});

test('coverage audit reports per-AC covered/uncovered and which findings map to each', () => {
  const twoAc = ['first criterion', 'second criterion'];
  const { coverage } = convergeUiReviewLenses(lensSet({
    a11y: [F({ acceptanceCriterionRef: 'AC1', severity: 'low' })],
  }), opts({ acceptanceCriteria: twoAc }));
  assert.deepEqual(coverage.covered, ['AC1']);
  assert.deepEqual(coverage.uncovered, ['AC2']);
  assert.equal(coverage.satisfiedBarMet, false);
  const ac1 = coverage.perCriterion.find((c) => c.ref === 'AC1');
  assert.equal(ac1.criterion, 'first criterion');
  assert.equal(ac1.findingCount, 1);
  assert.equal(ac1.covered, true);
  const ac2 = coverage.perCriterion.find((c) => c.ref === 'AC2');
  assert.equal(ac2.covered, false);
});

test('coverage-met by findings over every AC (no must-fix) ⇒ satisfied', () => {
  const twoAc = ['first criterion', 'second criterion'];
  const { outcome, coverage } = convergeUiReviewLenses(lensSet({
    a11y: [F({ acceptanceCriterionRef: 'AC1', region: '#a', category: 'x', severity: 'low' })],
    visual: [F({ acceptanceCriterionRef: 'AC2', region: '#b', category: 'y', severity: 'low' })],
  }), opts({ acceptanceCriteria: twoAc }));
  assert.equal(coverage.satisfiedBarMet, true);
  assert.equal(outcome, UI_REVIEW_OUTCOMES.SATISFIED);
});

test('coverage-gap (an AC covered by neither a finding nor a check) ⇒ NOT satisfied (continue)', () => {
  const twoAc = ['first criterion', 'second criterion'];
  const { outcome, coverage } = convergeUiReviewLenses(lensSet({
    a11y: [F({ acceptanceCriterionRef: 'AC1', severity: 'low' })],
  }), opts({ acceptanceCriteria: twoAc }));
  assert.equal(outcome, UI_REVIEW_OUTCOMES.CONTINUE);
  assert.deepEqual(coverage.uncovered, ['AC2']);
});

test('coverage by a PASS: findings on some ACs + affirmative checks on the rest ⇒ satisfied', () => {
  const twoAc = ['first criterion', 'second criterion'];
  const { outcome, coverage } = convergeUiReviewLenses(lensSet({
    a11y: [F({ acceptanceCriterionRef: 'AC1', severity: 'low' })],
  }), opts({
    acceptanceCriteria: twoAc,
    checkedCriteria: [{ acceptanceCriterionRef: 'AC2', stateName: 'empty-state' }],
  }));
  assert.equal(coverage.satisfiedBarMet, true);
  assert.equal(outcome, UI_REVIEW_OUTCOMES.SATISFIED);
});

test('a must-fix finding still continues even when coverage is fully met', () => {
  const { outcome, coverage } = convergeUiReviewLenses(lensSet({
    a11y: [F({ acceptanceCriterionRef: 'AC1', severity: 'must-fix' })],
  }), opts());
  assert.equal(coverage.satisfiedBarMet, true);
  assert.equal(outcome, UI_REVIEW_OUTCOMES.CONTINUE);
});

test('converge fails closed on a malformed checked-criteria mark rather than silently satisfying', () => {
  // Missing stateName, unmappable ref, and non-object marks each fail closed.
  for (const badChecked of [
    [{ acceptanceCriterionRef: 'AC1' }],
    [{ acceptanceCriterionRef: 'AC9', stateName: 'empty-state' }],
    [{ stateName: 'empty-state' }],
    [null],
    'not-an-array',
  ]) {
    assert.throws(
      () => convergeUiReviewLenses(lensSet(), opts({ checkedCriteria: badChecked })),
      /malformed checked-criteria/,
      `checkedCriteria=${JSON.stringify(badChecked)} must fail closed`,
    );
  }
});

test('converge fails closed when the acceptance-criteria list is missing', () => {
  assert.throws(() => convergeUiReviewLenses(lensSet({ a11y: [F()] })), /refusing to converge/);
  assert.throws(() => convergeUiReviewRouteFindings([{ lens: 'a11y', ...F() }]), /refusing to converge/);
});
