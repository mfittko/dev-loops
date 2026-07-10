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

const F = (over = {}) => ({
  stateName: 'empty-state',
  region: '#main .card',
  category: 'color-contrast',
  severity: 'medium',
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
  }));
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].lenses, ['a11y', 'visual']);
});

test('precedence: the worse severity wins when two lenses report the same defect', () => {
  const { findings } = convergeUiReviewLenses(lensSet({
    a11y: [F({ severity: 'high' })],
    visual: [F({ severity: 'low' })],
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
  assert.deepEqual(findings[0].lenses, ['a11y', 'visual']);
});

test('distinct defects on the same state are kept, ordered worst-first then by region/category', () => {
  const { findings } = convergeUiReviewLenses(lensSet({
    a11y: [F({ region: '#b', category: 'z', severity: 'low' })],
    visual: [F({ region: '#a', category: 'x', severity: 'high' })],
  }));
  assert.equal(findings.length, 2);
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[1].severity, 'low');
});

test('output ordering is deterministic regardless of input lens/finding order', () => {
  const a = convergeUiReviewLenses(lensSet({
    a11y: [F({ stateName: 'b', category: 'x' }), F({ stateName: 'a', category: 'y' })],
  }));
  const b = convergeUiReviewLenses(lensSet({
    interaction: [F({ stateName: 'a', category: 'y' })],
    a11y: [F({ stateName: 'b', category: 'x' })],
  }));
  assert.deepEqual(a.findings.map((f) => `${f.stateName}/${f.category}`), b.findings.map((f) => `${f.stateName}/${f.category}`));
});

test('outcome: no must-fix findings ⇒ satisfied', () => {
  const { outcome } = convergeUiReviewLenses(lensSet({ visual: [F({ severity: 'low' })] }));
  assert.equal(outcome, UI_REVIEW_OUTCOMES.SATISFIED);
});

test('outcome: a must-fix/high finding ⇒ not satisfied (continue fix loop)', () => {
  assert.equal(convergeUiReviewLenses(lensSet({ interaction: [F({ severity: 'must-fix' })] })).outcome, UI_REVIEW_OUTCOMES.CONTINUE);
  assert.equal(convergeUiReviewLenses(lensSet({ a11y: [F({ severity: 'high' })] })).outcome, UI_REVIEW_OUTCOMES.CONTINUE);
});

test('outcome: a fail-closed (blocking) signal ⇒ blocked, taking precedence over continue', () => {
  const { outcome } = convergeUiReviewLenses(lensSet({
    interaction: [F({ severity: 'must-fix' })],
    visual: [F({ region: '#conflict', category: 'design', severity: 'high', blocking: true })],
  }));
  assert.equal(outcome, UI_REVIEW_OUTCOMES.BLOCKED);
});

test('an empty (all-lenses-clean) set is satisfied', () => {
  const { findings, outcome } = convergeUiReviewLenses(lensSet());
  assert.deepEqual(findings, []);
  assert.equal(outcome, UI_REVIEW_OUTCOMES.SATISFIED);
});

test('validator rejects a missing lens fail-closed', () => {
  const result = validateUiReviewLensResults([
    { lens: 'a11y', findings: [] },
    { lens: 'layout-geometry', findings: [] },
    { lens: 'visual', findings: [] },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked_missing_lens');
  assert.ok(result.missing.includes('lens:interaction'));
});

test('validator rejects a malformed finding fail-closed', () => {
  const result = validateUiReviewLensResults(lensSet({ a11y: [F({ severity: 'catastrophic' })] }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lens_finding_malformed');
  assert.ok(result.missing.some((m) => m.endsWith('.severity')));
});

test('validator rejects an unknown or duplicate lens', () => {
  assert.equal(validateUiReviewLensResults([...lensSet(), { lens: 'novel', findings: [] }]).ok, false);
  assert.equal(validateUiReviewLensResults([...lensSet(), { lens: 'a11y', findings: [] }]).ok, false);
});

test('validator accepts a complete, well-formed set', () => {
  assert.equal(validateUiReviewLensResults(lensSet({ a11y: [F()] })).ok, true);
});

test('converge fails closed (throws) on a partial lens-result set rather than converging it', () => {
  assert.throws(() => convergeUiReviewLenses([{ lens: 'a11y', findings: [] }]), /refusing to converge/);
});

test('a blocking signal survives the merge onto the single representative', () => {
  // Same (stateName, region, category) triple across two lenses: one blocking, one not.
  const { findings, outcome } = convergeUiReviewLenses(lensSet({
    a11y: [F({ severity: 'high', blocking: false })],
    visual: [F({ severity: 'high', blocking: true })],
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].blocking, true);
  assert.equal(outcome, UI_REVIEW_OUTCOMES.BLOCKED);
});

test('the worse severity wins even when the milder duplicate is processed first', () => {
  // a11y (processed first) reports low; visual (processed later) reports high.
  const { findings } = convergeUiReviewLenses(lensSet({
    a11y: [F({ severity: 'low' })],
    visual: [F({ severity: 'high' })],
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
});

test('validator rejects a non-array lens-result set fail-closed', () => {
  const result = validateUiReviewLensResults(null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lens_results_not_array');
  assert.deepEqual(result.missing, ['lensResults']);
});

test('validator rejects a finding missing region fail-closed', () => {
  const result = validateUiReviewLensResults(lensSet({ a11y: [F({ region: '' })] }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lens_finding_malformed');
  assert.ok(result.missing.some((m) => m.endsWith('.region')));
});

test('validator rejects a non-boolean blocking field fail-closed', () => {
  const result = validateUiReviewLensResults(lensSet({ a11y: [F({ blocking: 'yes' })] }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lens_finding_malformed');
  assert.ok(result.missing.some((m) => m.endsWith('.blocking')));
});

test('route entrypoint groups the flat template findings by lens and converges them', () => {
  // The vision template emits ONE flat findings array, each finding tagged with its lens.
  const { findings, outcome } = convergeUiReviewRouteFindings([
    { lens: 'a11y', ...F({ severity: 'high' }) },
    { lens: 'visual', ...F({ severity: 'low' }) },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
  assert.deepEqual(findings[0].lenses, ['a11y', 'visual']);
  assert.equal(outcome, UI_REVIEW_OUTCOMES.CONTINUE);
});

test('route entrypoint fails closed on an unknown-lens finding rather than dropping it', () => {
  assert.throws(() => convergeUiReviewRouteFindings([{ lens: 'novel', ...F() }]), /refusing to converge/);
});
