import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DOCS_GRILL_FINDING_KINDS,
  DOCS_GRILL_DISPOSITIONS,
  classifyDocsGrillFinding,
} from '../../scripts/loop/docs-grill-contract.mjs';

test('finding kinds and dispositions are the bounded sets', () => {
  assert.deepEqual([...DOCS_GRILL_FINDING_KINDS], ['drift', 'stale_reference', 'cosmetic']);
  assert.deepEqual([...DOCS_GRILL_DISPOSITIONS], [
    'record_finding',
    'fix_in_place',
    'route_followup',
    'ignore_cosmetic',
  ]);
});

test('real code-vs-doc drift is recorded as a finding', () => {
  const r = classifyDocsGrillFinding({ kind: 'drift', docOnly: false });
  assert.equal(r.ok, true);
  assert.equal(r.disposition, 'record_finding');
});

test('a stale reference with no doc-only flag is recorded as a finding', () => {
  const r = classifyDocsGrillFinding({ kind: 'stale_reference' });
  assert.equal(r.disposition, 'record_finding');
});

test('doc-only drift small enough for this branch is fixed in place', () => {
  const r = classifyDocsGrillFinding({ kind: 'drift', docOnly: true, fixableHere: true });
  assert.equal(r.disposition, 'fix_in_place');
});

test('doc-only drift too large for this branch routes a follow-up', () => {
  const r = classifyDocsGrillFinding({ kind: 'drift', docOnly: true, fixableHere: false });
  assert.equal(r.disposition, 'route_followup');
});

test('a cosmetic nit does not block or trigger a fix', () => {
  const r = classifyDocsGrillFinding({ kind: 'cosmetic', docOnly: true });
  assert.equal(r.disposition, 'ignore_cosmetic');
});

test('an unknown finding kind fails closed with a structured invalid result', () => {
  const r = classifyDocsGrillFinding({ kind: 'whatever' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'invalid_finding');
  assert.deepEqual(r.invalid, ['kind']);
});

test('a null argument returns a structured invalid result rather than throwing', () => {
  const r = classifyDocsGrillFinding(null);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'invalid_finding');
});
