import { z } from "zod";

export const DebtFindingValidationStatus = z.enum([
  "pending",
  "validated",
  "rejected",
  "stale",
]);

export const DebtFindingRemediationShape = z.enum([
  "item",
  "epic",
  "defer",
  "watch_only",
  "dismissed",
]);

export const DebtFindingLocationSummary = z.strictObject({
  filePaths: z.array(z.string().min(1)).optional(),
  primaryFilePath: z.string().min(1).optional(),
});

export const DebtFindingSchema = z.strictObject({
  id: z.string().uuid(),
  signalIds: z.array(z.string().uuid()).min(1),
  validationStatus: DebtFindingValidationStatus,
  score: z.number().min(0).max(100).optional(),
  remediationShape: DebtFindingRemediationShape,
  title: z.string().min(1).max(200),
  description: z.string().min(1).optional(),
  locationSummary: DebtFindingLocationSummary.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// ============================================================================
// Remediation item schema — a bounded, PR-sized fix ready for the execution loop
// ============================================================================
export const RemediationItemSchema = z.strictObject({
  kind: z.literal("remediation_item"),
  findingId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  score: z.number().min(0).max(100),
  primaryFilePath: z.string().min(1).optional(),
  filePaths: z.array(z.string().min(1)).min(1),
  signalIds: z.array(z.string().uuid()).min(1),
  sourceType: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// ============================================================================
// Debt epic schema — cross-cutting work that needs decomposition before execution
// ============================================================================
export const DebtEpicSchema = z.strictObject({
  kind: z.literal("debt_epic"),
  findingId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  score: z.number().min(0).max(100),
  filePaths: z.array(z.string().min(1)).min(1),
  signalIds: z.array(z.string().uuid()).min(1),
  estimatedItems: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
