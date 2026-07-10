// axe-core impact → review finding severity. Computable a11y facts (contrast,
// missing names/roles, etc.) come from axe.json evidence, not model judgment;
// this pins how an axe impact rank becomes a finding severity. A null/unknown
// impact (e.g. an `incomplete` result axe could not rank) maps to `medium` on
// purpose — conservative, so an unranked issue is not silently minimized.
const AXE_IMPACT_TO_FINDING_SEVERITY = {
  critical: 'high',
  serious: 'high',
  moderate: 'medium',
  minor: 'low',
};

export function mapAxeImpactToFindingSeverity(impact) {
  const key = typeof impact === 'string' ? impact.trim().toLowerCase() : '';
  return AXE_IMPACT_TO_FINDING_SEVERITY[key] ?? 'medium';
}

export function validateUiDesignerReviewInput(input = {}) {
  if (input.workType !== 'ui' || input.uiReviewRequested !== true) {
    return {
      ok: true,
      status: 'skip_non_ui',
      reason: 'non_ui_or_not_requested',
      missing: [],
    };
  }
  const uiReviewMode = typeof input.uiReviewMode === 'string' ? input.uiReviewMode.trim() : '';
  const reviewMode = uiReviewMode.length === 0 ? 'designer' : uiReviewMode;
  if (reviewMode !== 'designer' && reviewMode !== 'vision') {
    return {
      ok: false,
      status: 'blocked_unsupported_review_mode',
      reason: 'unsupported_review_mode',
      missing: ['uiReviewMode'],
    };
  }
  const missing = [];
  const acceptanceCriteria = Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.filter((entry) => typeof entry === 'string' && entry.trim().length > 0) : [];
  if (acceptanceCriteria.length === 0) {
    missing.push('acceptanceCriteria');
  }
  if (typeof input.reviewBrief !== 'string' || input.reviewBrief.trim().length === 0) {
    missing.push('reviewBrief');
  }
  const artifactBundle = input.artifactBundle ?? {};
  if (typeof artifactBundle.sliceId !== 'string' || artifactBundle.sliceId.trim().length === 0) {
    missing.push('artifactBundle.sliceId');
  }
  const namedStates = Array.isArray(artifactBundle.namedStates) ? artifactBundle.namedStates : [];
  if (namedStates.length === 0) {
    missing.push('artifactBundle.namedStates');
  }
  if (missing.length > 0) {
    return {
      ok: false,
      status: 'blocked_missing_required_inputs',
      reason: 'required_inputs_missing',
      missing,
    };
  }
  const incompleteArtifacts = [];
  namedStates.forEach((state, index) => {
    if (typeof state.stateName !== 'string' || state.stateName.trim().length === 0) {
      incompleteArtifacts.push(`artifactBundle.namedStates[${index}].stateName`);
    }
    if (typeof state.screenshotPath !== 'string' || state.screenshotPath.trim().length === 0) {
      incompleteArtifacts.push(`artifactBundle.namedStates[${index}].screenshotPath`);
    }
    if (typeof state.statePath !== 'string' || state.statePath.trim().length === 0) {
      incompleteArtifacts.push(`artifactBundle.namedStates[${index}].statePath`);
    }
    if (typeof state.snapshotPath !== 'string' || state.snapshotPath.trim().length === 0) {
      incompleteArtifacts.push(`artifactBundle.namedStates[${index}].snapshotPath`);
    }
    if (typeof state.axePath !== 'string' || state.axePath.trim().length === 0) {
      incompleteArtifacts.push(`artifactBundle.namedStates[${index}].axePath`);
    }
    if (typeof state.consolePath !== 'string' || state.consolePath.trim().length === 0) {
      incompleteArtifacts.push(`artifactBundle.namedStates[${index}].consolePath`);
    }
    if (reviewMode === 'vision' && typeof state.screenshotPath === 'string' && state.screenshotPath.trim().length > 0 && !state.screenshotPath.trim().endsWith('screenshot.png')) {
      incompleteArtifacts.push(`artifactBundle.namedStates[${index}].screenshotPath`);
    }
    if (reviewMode === 'vision' && typeof state.statePath === 'string' && state.statePath.trim().length > 0 && !state.statePath.trim().endsWith('state.json')) {
      incompleteArtifacts.push(`artifactBundle.namedStates[${index}].statePath`);
    }
    if (reviewMode === 'vision' && typeof state.snapshotPath === 'string' && state.snapshotPath.trim().length > 0 && !state.snapshotPath.trim().endsWith('snapshot.json')) {
      incompleteArtifacts.push(`artifactBundle.namedStates[${index}].snapshotPath`);
    }
    if (reviewMode === 'vision' && typeof state.axePath === 'string' && state.axePath.trim().length > 0 && !state.axePath.trim().endsWith('axe.json')) {
      incompleteArtifacts.push(`artifactBundle.namedStates[${index}].axePath`);
    }
    if (reviewMode === 'vision' && typeof state.consolePath === 'string' && state.consolePath.trim().length > 0 && !state.consolePath.trim().endsWith('console.json')) {
      incompleteArtifacts.push(`artifactBundle.namedStates[${index}].consolePath`);
    }
  });
  if (incompleteArtifacts.length > 0) {
    return {
      ok: false,
      status: 'blocked_incomplete_artifact_bundle',
      reason: 'artifact_bundle_incomplete',
      missing: incompleteArtifacts,
    };
  }
  return {
    ok: true,
    status: reviewMode === 'vision' ? 'ready_for_vision_review' : 'ready_for_designer_review',
    reason: 'artifact_bundle_complete',
    missing: [],
  };
}
