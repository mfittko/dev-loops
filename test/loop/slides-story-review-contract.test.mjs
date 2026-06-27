import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STORY_REVIEW_OUTCOMES,
  validateSlidesStoryReviewInput,
  validateSlidesStoryReviewResult,
} from '../../scripts/loop/slides-story-review-contract.mjs';

test('STORY_REVIEW_OUTCOMES is the bounded satisfied/iterate set', () => {
  assert.deepEqual([...STORY_REVIEW_OUTCOMES], ['story_review_satisfied', 'needs_iteration']);
});

test('validateSlidesStoryReviewInput skips non-deck work instead of triggering the loop', () => {
  const result = validateSlidesStoryReviewInput({
    workType: 'cli',
    storyReviewRequested: false,
  });

  assert.deepEqual(result, {
    ok: true,
    status: 'skip_non_slides',
    reason: 'non_slides_or_not_requested',
    missing: [],
  });
});

test('validateSlidesStoryReviewInput fails closed when required review inputs are missing', () => {
  const result = validateSlidesStoryReviewInput({
    workType: 'slides',
    storyReviewRequested: true,
    acceptanceCriteria: [],
    storytellingBrief: '',
    deckBundle: {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked_missing_required_inputs');
  assert.deepEqual(result.missing, [
    'acceptanceCriteria',
    'storytellingBrief',
    'deckBundle.deckSourcePath',
  ]);
});

test('validateSlidesStoryReviewInput rejects incomplete optional slide screenshots', () => {
  const result = validateSlidesStoryReviewInput({
    workType: 'slides',
    storyReviewRequested: true,
    acceptanceCriteria: ['public audience can follow the arc'],
    storytellingBrief: 'Check hook, one message per slide, and the close.',
    deckBundle: {
      deckSourcePath: 'docs/presentations/applied-dev-loops-presentation.md',
      slideScreenshots: [
        {
          slideId: 'hero',
        },
      ],
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked_incomplete_deck_bundle');
  assert.deepEqual(result.missing, ['deckBundle.slideScreenshots[0].screenshotPath']);
});

test('validateSlidesStoryReviewInput accepts a complete deck bundle (screenshots optional)', () => {
  const result = validateSlidesStoryReviewInput({
    workType: 'slides',
    storyReviewRequested: true,
    acceptanceCriteria: ['public audience can follow the arc'],
    storytellingBrief: 'Check hook, one message per slide, and the close.',
    deckBundle: {
      deckSourcePath: 'docs/presentations/applied-dev-loops-presentation.md',
    },
  });

  assert.deepEqual(result, {
    ok: true,
    status: 'ready_for_story_review',
    reason: 'deck_bundle_complete',
    missing: [],
  });
});

test('validateSlidesStoryReviewInput accepts a deck bundle with captured slide screenshots', () => {
  const result = validateSlidesStoryReviewInput({
    workType: 'slides',
    storyReviewRequested: true,
    acceptanceCriteria: ['public audience can follow the arc'],
    storytellingBrief: 'Check hook, one message per slide, and the close.',
    deckBundle: {
      deckSourcePath: 'docs/presentations/applied-dev-loops-presentation.md',
      slideScreenshots: [
        {
          slideId: 'hero',
          screenshotPath: 'test-results/ui-smoke/applied-deck/named-states/hero/screenshot.png',
        },
      ],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready_for_story_review');
});

test('validateSlidesStoryReviewResult accepts a satisfied result with no findings', () => {
  const result = validateSlidesStoryReviewResult({
    outcome: 'story_review_satisfied',
    summary: 'Arc lands; close is memorable; no jargon walls remain.',
    findings: [],
  });

  assert.deepEqual(result, {
    ok: true,
    status: 'valid_result_shape',
    reason: 'result_shape_valid',
    invalid: [],
  });
});

test('validateSlidesStoryReviewResult accepts a needs_iteration result with grounded findings', () => {
  const result = validateSlidesStoryReviewResult({
    outcome: 'needs_iteration',
    summary: 'Hook does not make a stranger care; slide 3 carries two messages.',
    findings: [
      {
        severity: 'high',
        slideId: 'hero',
        problem: 'Opens on internal enum names; a public reader has no reason to care.',
        correctiveAction: 'Reword the title to a claim and translate the enum to plain language.',
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'valid_result_shape');
});

test('validateSlidesStoryReviewResult fails closed on an invalid outcome and missing summary', () => {
  const result = validateSlidesStoryReviewResult({
    outcome: 'looks_good',
    findings: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid_result_shape');
  assert.deepEqual(result.invalid, ['outcome', 'summary']);
});

test('validateSlidesStoryReviewResult requires non-empty findings when needs_iteration', () => {
  const result = validateSlidesStoryReviewResult({
    outcome: 'needs_iteration',
    summary: 'Narrative still off.',
    findings: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid_result_shape');
  assert.deepEqual(result.invalid, ['findings']);
});

test('validateSlidesStoryReviewResult rejects incomplete findings', () => {
  const result = validateSlidesStoryReviewResult({
    outcome: 'needs_iteration',
    summary: 'Slide 3 carries two messages.',
    findings: [
      {
        severity: 'urgent',
        slideId: '',
        problem: 'Two takeaways compete on one slide.',
        correctiveAction: '',
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid_result_shape');
  assert.deepEqual(result.invalid, [
    'findings[0].severity',
    'findings[0].slideId',
    'findings[0].correctiveAction',
  ]);
});

test('validators fail closed (not throw) on null / non-object arguments', () => {
  for (const bad of [null, undefined, 'x', 42]) {
    const inp = validateSlidesStoryReviewInput(bad);
    assert.equal(inp.ok, true);
    assert.equal(inp.status, 'skip_non_slides'); // non-object → not a slides story-review request
    const res = validateSlidesStoryReviewResult(bad);
    assert.equal(res.ok, false);
    assert.equal(res.status, 'invalid_result_shape');
  }
});

test('null array elements are reported, not thrown (screenshots + findings)', () => {
  const inp = validateSlidesStoryReviewInput({
    workType: 'slides',
    storyReviewRequested: true,
    acceptanceCriteria: ['AC'],
    storytellingBrief: 'brief',
    deckBundle: { deckSourcePath: 'docs/x.md', slideScreenshots: [null] },
  });
  assert.equal(inp.ok, false);
  assert.equal(inp.status, 'blocked_incomplete_deck_bundle');
  assert.ok(inp.missing.some((m) => m.includes('slideScreenshots[0]')));

  const res = validateSlidesStoryReviewResult({
    outcome: 'needs_iteration',
    summary: 'has a null finding',
    findings: [null],
  });
  assert.equal(res.ok, false);
  assert.ok(res.invalid.some((m) => m.startsWith('findings[0]')));
});
