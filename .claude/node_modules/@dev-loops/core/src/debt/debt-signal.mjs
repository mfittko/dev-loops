import { z } from "zod";

export const DebtSignalSourceType = z.enum([
  "pr_review_deep_persona",
  "repo_audit",
  "flaky_test",
  "ci_failure",
  "manual_review",
  "dependency_alert",
  "review_churn",
  "incident_followup",
  "workflow_pain",
]);

export const DebtSignalSeverity = z.enum([
  "info",
  "low",
  "medium",
  "high",
  "critical",
]);

export const DebtSignalLocation = z.strictObject({
  filePath: z.string().min(1).optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  commitSha: z.string().regex(/^[a-f0-9]{7,40}$/).optional(),
  url: z.string().url().optional(),
});

export const DebtSignalRepository = z.strictObject({
  owner: z.string().min(1),
  name: z.string().min(1),
});

export const DebtSignalSchema = z.strictObject({
  id: z.string().uuid(),
  sourceType: DebtSignalSourceType,
  signalKind: z.string().min(1).max(100),
  location: DebtSignalLocation,
  severityHint: DebtSignalSeverity,
  timestamp: z.string().datetime(),
  rawPayload: z.record(z.string(), z.unknown()).optional(),
  repository: DebtSignalRepository.optional(),
  confidence: z.number().min(0).max(1).default(1),
});
