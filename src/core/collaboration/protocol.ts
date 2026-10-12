import { z } from "zod";
import { idSchema } from "../ids";
import { presentationDocumentSchema } from "../document";
import { editScopeSchema } from "../documentAuthority";
import {
  acceptedTransactionSchema,
  documentTransactionSchema,
  transactionIdSchema,
} from "../documentTransactions";
import { frameSchema } from "../element";

export const COLLAB_PROTOCOL_VERSION = 1 as const;
export const COLLAB_DOCUMENT_VERSION = 1 as const;
export const MAX_COLLAB_MESSAGE_BYTES = 32 * 1024 * 1024;
export const MAX_COLLAB_CONTROL_BYTES = 32 * 1024;
export const MAX_COLLAB_OPERATION_BYTES = 512 * 1024;
export const MAX_COLLAB_PREVIEW_BYTES = 8192;

export const interactionPreviewSchema = z
  .object({
    slideId: idSchema,
    elements: z
      .array(
        z
          .object({
            id: idSchema,
            frame: frameSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export const versionSchema = z
  .object({
    appVersion: z.string().min(1).max(100),
    protocolVersion: z.number().int().nonnegative(),
    documentVersion: z.number().int().nonnegative(),
  })
  .strict();

export const discoverySchema = z
  .object({
    sessionId: z.string().regex(/^[a-f0-9]{64}$/),
    presentationName: z.string().min(1).max(200),
    hostName: z.string().min(1).max(200),
    port: z.number().int().min(1).max(65535),
    protocolVersion: z.number().int().nonnegative(),
  })
  .strict();

export const leaseGrantSchema = z
  .object({
    token: transactionIdSchema,
    actorId: idSchema,
    scope: editScopeSchema,
    generation: z.number().int().positive(),
    expiresAt: z.number().finite(),
  })
  .strict();

const peerSchema = z
  .object({
    id: idSchema,
    displayName: z.string().min(1).max(100),
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    activeSlideId: idSchema.nullable(),
    selectionScopeId: idSchema.nullable(),
    selection: z.array(idSchema).max(100),
  })
  .strict();

export const clientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      sessionId: discoverySchema.shape.sessionId,
      versions: versionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("join"),
      displayName: z.string().min(1).max(100),
      deviceName: z.string().min(1).max(100),
      resumeToken: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      epoch: transactionIdSchema.optional(),
      lastRevision: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("transaction.submit"),
      transaction: documentTransactionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("lease.acquire"),
      requestId: transactionIdSchema,
      scopes: z.array(editScopeSchema).min(1).max(256),
    })
    .strict(),
  z
    .object({
      type: z.literal("lease.renew"),
      requestId: transactionIdSchema,
      tokens: z.array(transactionIdSchema).min(1).max(256),
    })
    .strict(),
  z
    .object({
      type: z.literal("lease.release"),
      tokens: z.array(transactionIdSchema).max(256),
    })
    .strict(),
  z
    .object({
      type: z.literal("transactions.missing"),
      fromRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("history.action"),
      requestId: transactionIdSchema,
      action: z.enum(["undo", "redo"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("history.state"),
      requestId: transactionIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("presence"),
      activeSlideId: idSchema.nullable(),
      selectionScopeId: idSchema.nullable(),
      selection: z.array(idSchema).max(100),
    })
    .strict(),
  z.object({ type: z.literal("heartbeat") }).strict(),
  z
    .object({
      type: z.literal("interaction.preview"),
      preview: interactionPreviewSchema,
    })
    .strict(),
  z.object({ type: z.literal("interaction.preview.clear") }).strict(),
]);

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("compatible"), versions: versionSchema }).strict(),
  z
    .object({ type: z.literal("incompatible"), reason: z.string().max(200) })
    .strict(),
  z.object({ type: z.literal("waiting") }).strict(),
  z.object({ type: z.literal("rejected") }).strict(),
  z
    .object({
      type: z.literal("snapshot"),
      document: presentationDocumentSchema,
      actorId: idSchema,
      resumeToken: z.string().regex(/^[a-f0-9]{64}$/),
      epoch: transactionIdSchema,
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("resume"),
      actorId: idSchema,
      resumeToken: z.string().regex(/^[a-f0-9]{64}$/),
      epoch: transactionIdSchema,
      revision: z.number().int().nonnegative(),
      transactions: z.array(acceptedTransactionSchema).max(4096),
    })
    .strict(),
  z
    .object({
      type: z.literal("transaction.accepted"),
      accepted: acceptedTransactionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("transaction.rejected"),
      transactionId: transactionIdSchema,
      reason: z.string().max(500),
    })
    .strict(),
  z
    .object({
      type: z.literal("lease.result"),
      requestId: transactionIdSchema,
      denied: z.boolean(),
      grants: z.array(leaseGrantSchema).max(256),
      ownerActorId: idSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("transactions.replay"),
      epoch: transactionIdSchema,
      fromRevision: z.number().int().nonnegative(),
      revision: z.number().int().nonnegative(),
      transactions: z.array(acceptedTransactionSchema).max(4096),
    })
    .strict(),
  z
    .object({
      type: z.literal("history.result"),
      requestId: transactionIdSchema,
      ok: z.boolean(),
      reason: z.string().max(500).optional(),
      canUndo: z.boolean(),
      canRedo: z.boolean(),
      accepted: acceptedTransactionSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("leases.changed"),
      leases: z.array(leaseGrantSchema).max(10000),
    })
    .strict(),
  z
    .object({
      type: z.literal("peers.changed"),
      peers: z.array(peerSchema).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("interaction.preview"),
      actorId: idSchema,
      preview: interactionPreviewSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("interaction.preview.clear"),
      actorId: idSchema,
    })
    .strict(),
  z.object({ type: z.literal("stopped") }).strict(),
]);

export type DiscoveryRecord = z.infer<typeof discoverySchema> & {
  address: string;
};
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type InteractionPreview = z.infer<typeof interactionPreviewSchema>;
export type CollaborationPeer = z.infer<typeof peerSchema>;

export function compatibleVersions(
  local: z.infer<typeof versionSchema>,
  remote: z.infer<typeof versionSchema>,
) {
  return (
    local.protocolVersion === remote.protocolVersion &&
    local.documentVersion === remote.documentVersion
  );
}
