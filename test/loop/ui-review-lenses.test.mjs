import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UI_REVIEW_LENS_NAMES,
  UI_REVIEW_OUTCOMES,
  convergeUiReviewLenses,
  lensFindingDedupeKey,
  validateUiReviewLensResults,
} from '../../scripts/loop/ui-review-lenses.mjs';

const F = (over = {}) => ({
  namedState: 'empty-state',
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

test('dedupe key normalizes (namedState, region, category)', () => {
  assert.equal(
    lensFindingDedupeKey(F({ namedState: ' Empty-State ', region: '#Main .Card', category: 'Color-Contrast' })),
    lensFindingDedupeKey(F({ namedState: 'empty-state', region: '#main .card', category: 'color-contrast' })),
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
    a11y: [F({ namedState: 'b', category: 'x' }), F({ namedState: 'a', category: 'y' })],
  }));
  const b = convergeUiReviewLenses(lensSet({
    interaction: [F({ namedState: 'a', category: 'y' })],
    a11y: [F({ namedState: 'b', category: 'x' })],
  }));
  assert.deepEqual(a.findings.map((f) => `${f.namedState}/${f.category}`), b.findings.map((f) => `${f.namedState}/${f.category}`));
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
