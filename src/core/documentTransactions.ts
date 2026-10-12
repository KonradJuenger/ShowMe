import { z } from "zod";
import { idSchema } from "./ids";
import { documentOperationSchema } from "./documentOperations";

export const transactionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const documentTransactionSchema = z
  .object({
    transactionId: transactionIdSchema,
    documentId: idSchema,
    epoch: transactionIdSchema,
    baseRevision: z.number().int().nonnegative(),
    leaseTokens: z.array(transactionIdSchema).max(256),
    operations: z.array(documentOperationSchema).min(1).max(256),
    historyGroupId: transactionIdSchema.optional(),
  })
  .strict();

export type DocumentTransaction = z.infer<
  typeof documentTransactionSchema
>;

export const acceptedTransactionSchema = z
  .object({
    transactionId: transactionIdSchema,
    documentId: idSchema,
    epoch: transactionIdSchema,
    actorId: idSchema,
    revision: z.number().int().positive(),
    operations: z.array(documentOperationSchema).min(1).max(256),
    inverseOperations: z.array(documentOperationSchema).min(1).max(256),
    historyGroupId: transactionIdSchema.optional(),
  })
  .strict();

export type AcceptedTransaction = z.infer<
  typeof acceptedTransactionSchema
>;

export function transactionFingerprint(
  transaction: DocumentTransaction,
) {
  return JSON.stringify({
    documentId: transaction.documentId,
    epoch: transaction.epoch,
    operations: transaction.operations,
    historyGroupId: transaction.historyGroupId ?? null,
  });
}
