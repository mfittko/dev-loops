import { z } from "zod";

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
