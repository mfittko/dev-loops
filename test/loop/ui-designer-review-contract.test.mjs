import test from 'node:test';
import assert from 'node:assert/strict';

import { mapAxeImpactToFindingSeverity, validateUiDesignerReviewInput } from '../../scripts/loop/ui-designer-review-contract.mjs';

test('validateUiDesignerReviewInput skips non-UI work instead of triggering the designer loop', () => {
  const result = validateUiDesignerReviewInput({
    workType: 'cli',
    uiReviewRequested: false,
  });

  assert.deepEqual(result, {
    ok: true,
    status: 'skip_non_ui',
    reason: 'non_ui_or_not_requested',
    missing: [],
  });
});

test('validateUiDesignerReviewInput fails closed when required review inputs are missing', () => {
  const result = validateUiDesignerReviewInput({
    workType: 'ui',
    uiReviewRequested: true,
    acceptanceCriteria: [],
    reviewBrief: '',
    artifactBundle: {
      sliceId: 'inspect-run-viewer',
      namedStates: [],
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked_missing_required_inputs');
  assert.deepEqual(result.missing, [
    'acceptanceCriteria',
    'reviewBrief',
    'artifactBundle.namedStates',
  ]);
});

test('validateUiDesignerReviewInput rejects incomplete named-state artifacts', () => {
  const result = validateUiDesignerReviewInput({
    workType: 'ui',
    uiReviewRequested: true,
    acceptanceCriteria: ['named dashboard state renders'],
    reviewBrief: 'Check layout and visual hierarchy.',
    artifactBundle: {
      sliceId: 'inspect-run-viewer',
      namedStates: [
        {
          stateName: 'Current PR dashboard',
          screenshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/screenshot.png',
          snapshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/snapshot.json',
          axePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/axe.json',
          consolePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/console.json',
        },
      ],
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked_incomplete_artifact_bundle');
  assert.deepEqual(result.missing, ['artifactBundle.namedStates[0].statePath']);
});

test('validateUiDesignerReviewInput accepts the artifact bundle from the reusable harness path', () => {
  const result = validateUiDesignerReviewInput({
    workType: 'ui',
    uiReviewRequested: true,
    acceptanceCriteria: ['named dashboard state renders'],
    reviewBrief: 'Check layout and visual hierarchy.',
    artifactBundle: {
      sliceId: 'inspect-run-viewer',
      reportPath: 'playwright-report/ui-smoke/inspect-run-viewer/index.html',
      namedStates: [
        {
          stateName: 'Current PR dashboard',
          screenshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/screenshot.png',
          statePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/state.json',
          snapshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/snapshot.json',
          axePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/axe.json',
          consolePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/console.json',
        },
      ],
    },
  });

  assert.deepEqual(result, {
    ok: true,
    status: 'ready_for_designer_review',
    reason: 'artifact_bundle_complete',
    missing: [],
  });
});

test('validateUiDesignerReviewInput routes opted-in UI slices to vision review', () => {
  const result = validateUiDesignerReviewInput({
    workType: 'ui',
    uiReviewRequested: true,
    uiReviewMode: 'vision',
    acceptanceCriteria: ['named dashboard state renders'],
    reviewBrief: 'Check layout and visual hierarchy.',
    artifactBundle: {
      sliceId: 'inspect-run-viewer',
      reportPath: 'playwright-report/ui-smoke/inspect-run-viewer/index.html',
      namedStates: [
        {
          stateName: 'Current PR dashboard',
          screenshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/screenshot.png',
          statePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/state.json',
          snapshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/snapshot.json',
          axePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/axe.json',
          consolePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/console.json',
        },
      ],
    },
  });

  assert.deepEqual(result, {
    ok: true,
    status: 'ready_for_vision_review',
    reason: 'artifact_bundle_complete',
    missing: [],
  });
});

test('validateUiDesignerReviewInput fails closed when vision review lacks screenshot.png artifacts', () => {
  const result = validateUiDesignerReviewInput({
    workType: 'ui',
    uiReviewRequested: true,
    uiReviewMode: 'vision',
    acceptanceCriteria: ['named dashboard state renders'],
    reviewBrief: 'Check layout and visual hierarchy.',
    artifactBundle: {
      sliceId: 'inspect-run-viewer',
      namedStates: [
        {
          stateName: 'Current PR dashboard',
          screenshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/preview.jpg',
          statePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/state.json',
          snapshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/snapshot.json',
          axePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/axe.json',
          consolePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/console.json',
        },
      ],
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked_incomplete_artifact_bundle');
  assert.deepEqual(result.missing, ['artifactBundle.namedStates[0].screenshotPath']);
});

test('validateUiDesignerReviewInput fails closed for unsupported review modes', () => {
  const result = validateUiDesignerReviewInput({
    workType: 'ui',
    uiReviewRequested: true,
    uiReviewMode: 'manual',
  });

  assert.deepEqual(result, {
    ok: false,
    status: 'blocked_unsupported_review_mode',
    reason: 'unsupported_review_mode',
    missing: ['uiReviewMode'],
  });
});

test('validateUiDesignerReviewInput fails closed when vision review lacks state.json artifacts', () => {
  const result = validateUiDesignerReviewInput({
    workType: 'ui',
    uiReviewRequested: true,
    uiReviewMode: 'vision',
    acceptanceCriteria: ['named dashboard state renders'],
    reviewBrief: 'Check layout and visual hierarchy.',
    artifactBundle: {
      sliceId: 'inspect-run-viewer',
      namedStates: [
        {
          stateName: 'Current PR dashboard',
          screenshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/screenshot.png',
          statePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/meta.txt',
          snapshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/snapshot.json',
          axePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/axe.json',
          consolePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/console.json',
        },
      ],
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked_incomplete_artifact_bundle');
  assert.deepEqual(result.missing, ['artifactBundle.namedStates[0].statePath']);
});

test('validateUiDesignerReviewInput fails closed when a named state is missing snapshot.json', () => {
  const result = validateUiDesignerReviewInput({
    workType: 'ui',
    uiReviewRequested: true,
    acceptanceCriteria: ['named dashboard state renders'],
    reviewBrief: 'Check layout and visual hierarchy.',
    artifactBundle: {
      sliceId: 'inspect-run-viewer',
      namedStates: [
        {
          stateName: 'Current PR dashboard',
          screenshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/screenshot.png',
          statePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/state.json',
          axePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/axe.json',
          consolePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/console.json',
        },
      ],
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked_incomplete_artifact_bundle');
  assert.deepEqual(result.missing, ['artifactBundle.namedStates[0].snapshotPath']);
});

test('validateUiDesignerReviewInput fails closed when vision review has a malformed snapshot path', () => {
  const result = validateUiDesignerReviewInput({
    workType: 'ui',
    uiReviewRequested: true,
    uiReviewMode: 'vision',
    acceptanceCriteria: ['named dashboard state renders'],
    reviewBrief: 'Check layout and visual hierarchy.',
    artifactBundle: {
      sliceId: 'inspect-run-viewer',
      namedStates: [
        {
          stateName: 'Current PR dashboard',
          screenshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/screenshot.png',
          statePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/state.json',
          snapshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/a11y.txt',
          axePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/axe.json',
          consolePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/console.json',
        },
      ],
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked_incomplete_artifact_bundle');
  assert.deepEqual(result.missing, ['artifactBundle.namedStates[0].snapshotPath']);
});

test('validateUiDesignerReviewInput fails closed when a named state is missing axe.json', () => {
  const result = validateUiDesignerReviewInput({
    workType: 'ui',
    uiReviewRequested: true,
    acceptanceCriteria: ['named dashboard state renders'],
    reviewBrief: 'Check layout and visual hierarchy.',
    artifactBundle: {
      sliceId: 'inspect-run-viewer',
      namedStates: [
        {
          stateName: 'Current PR dashboard',
          screenshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/screenshot.png',
          statePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/state.json',
          snapshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/snapshot.json',
          consolePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/console.json',
        },
      ],
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked_incomplete_artifact_bundle');
  assert.deepEqual(result.missing, ['artifactBundle.namedStates[0].axePath']);
});

test('validateUiDesignerReviewInput fails closed when vision review has a malformed axe path', () => {
  const result = validateUiDesignerReviewInput({
    workType: 'ui',
    uiReviewRequested: true,
    uiReviewMode: 'vision',
    acceptanceCriteria: ['named dashboard state renders'],
    reviewBrief: 'Check layout and visual hierarchy.',
    artifactBundle: {
      sliceId: 'inspect-run-viewer',
      namedStates: [
        {
          stateName: 'Current PR dashboard',
          screenshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/screenshot.png',
          statePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/state.json',
          snapshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/snapshot.json',
          axePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/axe.txt',
          consolePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/console.json',
        },
      ],
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked_incomplete_artifact_bundle');
  assert.deepEqual(result.missing, ['artifactBundle.namedStates[0].axePath']);
});

test('validateUiDesignerReviewInput fails closed when a named state is missing console.json', () => {
  const result = validateUiDesignerReviewInput({
    workType: 'ui',
    uiReviewRequested: true,
    acceptanceCriteria: ['named dashboard state renders'],
    reviewBrief: 'Check layout and visual hierarchy.',
    artifactBundle: {
      sliceId: 'inspect-run-viewer',
      namedStates: [
        {
          stateName: 'Current PR dashboard',
          screenshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/screenshot.png',
          statePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/state.json',
          snapshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/snapshot.json',
          axePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/axe.json',
        },
      ],
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked_incomplete_artifact_bundle');
  assert.deepEqual(result.missing, ['artifactBundle.namedStates[0].consolePath']);
});

test('validateUiDesignerReviewInput fails closed when vision review has a malformed console path', () => {
  const result = validateUiDesignerReviewInput({
    workType: 'ui',
    uiReviewRequested: true,
    uiReviewMode: 'vision',
    acceptanceCriteria: ['named dashboard state renders'],
    reviewBrief: 'Check layout and visual hierarchy.',
    artifactBundle: {
      sliceId: 'inspect-run-viewer',
      namedStates: [
        {
          stateName: 'Current PR dashboard',
          screenshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/screenshot.png',
          statePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/state.json',
          snapshotPath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/snapshot.json',
          axePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/axe.json',
          consolePath: 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard/console.txt',
        },
      ],
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked_incomplete_artifact_bundle');
  assert.deepEqual(result.missing, ['artifactBundle.namedStates[0].consolePath']);
});

test('validateUiDesignerReviewInput fails closed when two named states collide to the same slug', () => {
  const dir = 'test-results/ui-smoke/inspect-run-viewer/named-states/current-pr-dashboard-default-none';
  const collidingState = {
    stateName: 'Current PR dashboard',
    screenshotPath: `${dir}/screenshot.png`,
    statePath: `${dir}/state.json`,
    snapshotPath: `${dir}/snapshot.json`,
    axePath: `${dir}/axe.json`,
    consolePath: `${dir}/console.json`,
  };
  const result = validateUiDesignerReviewInput({
    workType: 'ui',
    uiReviewRequested: true,
    acceptanceCriteria: ['named dashboard state renders'],
    reviewBrief: 'Check layout and visual hierarchy.',
    artifactBundle: {
      sliceId: 'inspect-run-viewer',
      namedStates: [collidingState, { ...collidingState, stateName: 'Current PR dashboard (again)' }],
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked_duplicate_state_slug');
  assert.equal(result.reason, 'duplicate_state_slug');
  assert.deepEqual(result.missing, ['artifactBundle.namedStates[1].statePath']);
});

test('mapAxeImpactToFindingSeverity maps axe impact ranks to finding severities', () => {
  assert.equal(mapAxeImpactToFindingSeverity('critical'), 'high');
  assert.equal(mapAxeImpactToFindingSeverity('serious'), 'high');
  assert.equal(mapAxeImpactToFindingSeverity('moderate'), 'medium');
  assert.equal(mapAxeImpactToFindingSeverity('minor'), 'low');
  assert.equal(mapAxeImpactToFindingSeverity('SERIOUS'), 'high');
  assert.equal(mapAxeImpactToFindingSeverity('  moderate  '), 'medium');
});

test('mapAxeImpactToFindingSeverity defaults unranked/unknown impact to medium', () => {
  assert.equal(mapAxeImpactToFindingSeverity(null), 'medium');
  assert.equal(mapAxeImpactToFindingSeverity(undefined), 'medium');
  assert.equal(mapAxeImpactToFindingSeverity(''), 'medium');
  assert.equal(mapAxeImpactToFindingSeverity('bogus'), 'medium');
});
