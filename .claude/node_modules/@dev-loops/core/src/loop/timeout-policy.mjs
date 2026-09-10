export const DEV_LOOP_TIMEOUT_CLASSIFICATION = Object.freeze({
  PERSISTENT_INTERNAL_WAIT: "persistent_internal_wait",
  EXTERNAL_HEALTHY_WAIT: "external_healthy_wait",
  PROBE_STATUS: "probe_status",
});

export const PERSISTENT_INTERNAL_WAIT_TIMEOUT_POLICY = Object.freeze({
  classification: DEV_LOOP_TIMEOUT_CLASSIFICATION.PERSISTENT_INTERNAL_WAIT,
  minimumTimeoutMs: 3_600_000,
  defaultTimeoutMs: 3_600_000,
});

export const EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY = Object.freeze({
  classification: DEV_LOOP_TIMEOUT_CLASSIFICATION.EXTERNAL_HEALTHY_WAIT,
  minimumTimeoutMs: 1_800_000,
  defaultTimeoutMs: 1_800_000,
});

function formatTimeoutDuration(timeoutMs) {
  if (timeoutMs === 3_600_000) {
    return "1 hour";
  }

  if (timeoutMs === 1_800_000) {
    return "30 minutes";
  }

  if (timeoutMs === 86_400_000) {
    return "24 hours";
  }

  return `${timeoutMs} ms`;
}

function enforceTimeoutPolicy(policy, { timeoutMs = policy.defaultTimeoutMs, explicitProbe = false, contextLabel }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error(`${contextLabel} timeout must be a non-negative integer`);
  }

  if (explicitProbe) {
    return 0;
  }

  if (timeoutMs === 0) {
    throw new Error(`${contextLabel} uses the persistent unattended timeout contract; use an explicit probe/status path instead of timeout 0.`);
  }

  if (timeoutMs < policy.minimumTimeoutMs) {
    throw new Error(`${contextLabel} requires at least ${policy.minimumTimeoutMs} ms (${formatTimeoutDuration(policy.minimumTimeoutMs)}) for persistent unattended waits; received ${timeoutMs}.`);
  }

  return timeoutMs;
}

export function enforcePersistentInternalWaitTimeout(options = {}) {
  return enforceTimeoutPolicy(
    PERSISTENT_INTERNAL_WAIT_TIMEOUT_POLICY,
    {
      contextLabel: "Persistent internal wait",
      ...options,
    },
  );
}

export function enforceExternalHealthyWaitTimeout(options = {}) {
  return enforceTimeoutPolicy(
    EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY,
    {
      contextLabel: "External healthy wait",
      ...options,
    },
  );
}
