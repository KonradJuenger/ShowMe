import { randomUUID } from "node:crypto";
import { parseRuntimeDocument } from "../../src/core/documentRuntime";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hashSchema } from "../../src/core/assets";
import { idSchema } from "../../src/core/ids";
import {
  presentationDocumentSchema,
  type PresentationDocument,
} from "../../src/core/document";
import { applyValidatedDocumentOperations } from "../../src/core/documentOperations";
import {
  acceptedTransactionSchema,
  type AcceptedTransaction,
} from "../../src/core/documentTransactions";
import { atomicWrite, exists } from "./io";

export const RECOVERY_VERSION = 1 as const;

const metadataSchema = z
  .object({
    version: z.literal(RECOVERY_VERSION),
    documentId: idSchema,
    baseFileRevision: hashSchema.nullable(),
    epoch: z.string().min(1),
    savedRevision: z.number().int().nonnegative(),
  })
  .strict();
const checkpointSchema = z
  .object({
    version: z.literal(RECOVERY_VERSION),
    epoch: z.string().min(1),
    revision: z.number().int().nonnegative(),
    document: presentationDocumentSchema,
  })
  .strict();

export interface RecoveryHandle {
  filePath: string | null;
  fileRevision: string | null;
  recoveryPath: string;
  documentId: string;
  epoch: string;
  revision: number;
  savedRevision: number;
}

interface WriterState {
  identity: string;
  revision: number;
  bytes: number;
  records: number;
  poisoned: boolean;
}

export class RecoveryJournal {
  private lanes = new Map<string, Promise<unknown>>();
  private maintenance = new Map<string, Promise<void>>();
  private serialize<T>(folder: string, work: () => Promise<T>): Promise<T> {
    const prior = this.lanes.get(folder) ?? Promise.resolve();
    const result = prior.catch(() => {}).then(work);
    this.lanes.set(folder, result);
    void result
      .finally(() => {
        if (this.lanes.get(folder) === result) this.lanes.delete(folder);
      })
      .catch(() => {});
    return result;
  }
  async settleMaintenance(folder?: string) {
    if (folder) await this.maintenance.get(folder);
    else await Promise.all([...this.maintenance.values()]);
  }
  private writers = new Map<string, WriterState>();
  private identity(handle: RecoveryHandle) {
    return JSON.stringify([
      handle.documentId,
      handle.fileRevision,
      handle.epoch,
      handle.savedRevision,
    ]);
  }
  async discard(folder: string) {
    this.writers.delete(folder);
    await this.settleMaintenance(folder);
    await this.serialize(folder, () =>
      fs.rm(folder, { recursive: true, force: true }),
    );
  }

  async checkpoint(handle: RecoveryHandle, document: PresentationDocument) {
    this.writers.delete(handle.recoveryPath);
    await this.settleMaintenance(handle.recoveryPath);
    return this.serialize(handle.recoveryPath, () =>
      this.writeCheckpoint(handle, document),
    );
  }
  private async writeCheckpoint(
    handle: RecoveryHandle,
    document: PresentationDocument,
  ) {
    this.writers.delete(handle.recoveryPath);
    await fs.mkdir(handle.recoveryPath, { recursive: true });
    await atomicWrite(
      path.join(handle.recoveryPath, "metadata.json"),
      JSON.stringify(
        {
          version: RECOVERY_VERSION,
          documentId: handle.documentId,
          baseFileRevision: handle.fileRevision,
          epoch: handle.epoch,
          savedRevision: handle.savedRevision,
        },
        null,
        2,
      ) + "\n",
    );
    await atomicWrite(
      path.join(handle.recoveryPath, "checkpoint.json"),
      JSON.stringify(
        {
          version: RECOVERY_VERSION,
          epoch: handle.epoch,
          revision: handle.revision,
          document,
        },
        null,
        2,
      ) + "\n",
    );
    await atomicWrite(path.join(handle.recoveryPath, "transactions.jsonl"), "");
    this.writers.set(handle.recoveryPath, {
      identity: this.identity(handle),
      revision: handle.revision,
      bytes: 0,
      records: 0,
      poisoned: false,
    });
  }

  async append(
    handle: RecoveryHandle,
    accepted: AcceptedTransaction,
    base: PresentationDocument,
    candidate?: PresentationDocument,
  ) {
    return this.serialize(handle.recoveryPath, () =>
      this.appendRecord(handle, accepted, base, candidate),
    );
  }
  private async appendRecord(
    handle: RecoveryHandle,
    accepted: AcceptedTransaction,
    base: PresentationDocument,
    candidate?: PresentationDocument,
  ) {
    const journalPath = path.join(handle.recoveryPath, "transactions.jsonl");
    let state = this.writers.get(handle.recoveryPath);
    if (state?.poisoned)
      throw new Error(
        "Recovery writer integrity is unknown; reopen before continuing",
      );
    if (!(await exists(path.join(handle.recoveryPath, "metadata.json")))) {
      await this.writeCheckpoint(handle, base);
      state = this.writers.get(handle.recoveryPath)!;
    }
    // Constant-size stat detects external/interrupted tails. Normal appends never
    // read or replay the durable prefix. Recovery establishes trusted writer state.
    const size = (await fs.stat(journalPath)).size;
    if (
      !state ||
      state.identity !== this.identity(handle) ||
      state.bytes !== size
    ) {
      const recovered = await this.read(handle, base);
      if (
        recovered.epoch !== handle.epoch ||
        recovered.savedRevision !== handle.savedRevision ||
        recovered.revision !== handle.revision
      )
        throw new Error(
          "Recovery revision differs from the accepted authority; reopen before continuing",
        );
      const journal = await fs.readFile(journalPath, "utf8");
      let prefix = journal;
      if (journal && !journal.endsWith("\n")) {
        const tailStart = journal.lastIndexOf("\n") + 1;
        try {
          JSON.parse(journal.slice(tailStart));
          prefix += "\n";
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          prefix = journal.slice(0, tailStart);
        }
        const repair = await fs.open(journalPath, "r+");
        try {
          await repair.truncate(Buffer.byteLength(prefix));
          if (prefix.length > journal.length)
            await repair.write(Buffer.from("\n"), 0, 1, size);
          await repair.sync();
        } catch (error) {
          this.writers.set(handle.recoveryPath, {
            identity: this.identity(handle),
            revision: handle.revision,
            bytes: size,
            records: 0,
            poisoned: true,
          });
          throw error;
        } finally {
          await repair.close();
        }
      }
      state = {
        identity: this.identity(handle),
        revision: recovered.revision,
        bytes: Buffer.byteLength(prefix),
        records: prefix.split("\n").filter(Boolean).length,
        poisoned: false,
      };
      this.writers.set(handle.recoveryPath, state);
    }
    if (
      state.revision !== handle.revision ||
      accepted.revision !== handle.revision + 1 ||
      accepted.epoch !== handle.epoch ||
      accepted.documentId !== handle.documentId
    )
      throw new Error("Recovery transaction mismatch");
    const record = Buffer.from(JSON.stringify(accepted) + "\n");
    const file = await fs.open(journalPath, "r+");
    try {
      let offset = 0;
      while (offset < record.length) {
        const { bytesWritten } = await file.write(
          record,
          offset,
          record.length - offset,
          state.bytes + offset,
        );
        if (!bytesWritten) throw new Error("Recovery write made no progress");
        offset += bytesWritten;
      }
      await file.sync();
    } catch (error) {
      try {
        await file.truncate(state.bytes);
        await file.sync();
      } catch {
        state.poisoned = true;
      }
      throw error;
    } finally {
      // A successful sync has already committed the record. Closing the handle
      // cannot turn that durable acceptance into a rejected transaction.
      await file
        .close()
        .catch((error) => console.error("Recovery handle close failed", error));
    }
    state.bytes += record.length;
    state.records++;
    state.revision = accepted.revision;
    if (
      candidate &&
      !this.maintenance.has(handle.recoveryPath) &&
      (state.records >= 256 || state.bytes >= 8 * 1024 * 1024)
    ) {
      const folder = handle.recoveryPath,
        owner = state,
        prefixBytes = state.bytes,
        prefixRecords = state.records;
      const temporary = path.join(
        folder,
        "checkpoint." + randomUUID() + ".maintenance",
      );
      const job = new Promise<void>((resolve) => setImmediate(resolve))
        .then(async () => {
          // Build the large snapshot after acceptance, outside the append lane.
          await atomicWrite(
            temporary,
            JSON.stringify({
              version: RECOVERY_VERSION,
              epoch: handle.epoch,
              revision: accepted.revision,
              document: candidate,
            }) + "\n",
          );
          await this.serialize(folder, async () => {
            if (this.writers.get(folder) !== owner) return;
            const file = await fs.open(journalPath, "r");
            let tail: Buffer;
            try {
              const size = (await file.stat()).size;
              if (size !== owner.bytes || size < prefixBytes)
                throw new Error("Recovery maintenance ownership changed");
              tail = Buffer.alloc(size - prefixBytes);
              let offset = 0;
              while (offset < tail.length) {
                const { bytesRead } = await file.read(
                  tail,
                  offset,
                  tail.length - offset,
                  prefixBytes + offset,
                );
                if (!bytesRead)
                  throw new Error("Recovery maintenance read made no progress");
                offset += bytesRead;
              }
            } finally {
              await file.close();
            }
            // A crash between these publications is safe: replay ignores records
            // at or before the checkpoint revision, and retains every later edit.
            await fs.rename(temporary, path.join(folder, "checkpoint.json"));
            await atomicWrite(journalPath, tail);
            owner.bytes -= prefixBytes;
            owner.records -= prefixRecords;
          });
        })
        .catch((error) => console.error("Recovery compaction failed", error))
        .finally(async () => {
          await fs.unlink(temporary).catch(() => {});
          this.maintenance.delete(folder);
        });
      this.maintenance.set(folder, job);
    }
  }

  async read(
    handle: Pick<
      RecoveryHandle,
      "documentId" | "fileRevision" | "recoveryPath"
    >,
    base: PresentationDocument,
  ) {
    const folder = handle.recoveryPath;
    const rawMeta = JSON.parse(
      await fs.readFile(path.join(folder, "metadata.json"), "utf8"),
    );
    const meta = metadataSchema.parse(rawMeta);
    const rawCheckpoint = JSON.parse(
      await fs.readFile(path.join(folder, "checkpoint.json"), "utf8"),
    );
    rawCheckpoint.document = parseRuntimeDocument(rawCheckpoint.document);
    const checkpoint = checkpointSchema.parse(rawCheckpoint);
    if (
      meta.documentId !== handle.documentId ||
      meta.documentId !== base.documentId ||
      meta.baseFileRevision !== handle.fileRevision ||
      checkpoint.epoch !== meta.epoch ||
      checkpoint.document.documentId !== handle.documentId ||
      checkpoint.revision < meta.savedRevision
    )
      throw new Error("Recovery base mismatch");
    let document = checkpoint.document;
    let revision = checkpoint.revision;
    const journal = await fs.readFile(
      path.join(folder, "transactions.jsonl"),
      "utf8",
    );
    const lines = journal.split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      let accepted: AcceptedTransaction;
      let raw;
      try {
        raw = JSON.parse(lines[index]);
      } catch (error) {
        if (
          index === lines.length - 1 &&
          !journal.endsWith("\n") &&
          error instanceof SyntaxError
        )
          break;
        throw error;
      }
      {
        if (
          raw.documentId !== handle.documentId ||
          raw.epoch !== meta.epoch ||
          !Number.isInteger(raw.revision)
        )
          throw new Error("Recovery transaction mismatch");
        // A durable checkpoint owns earlier revisions, including interrupted compaction.
        if (raw.revision <= checkpoint.revision) continue;
        accepted = acceptedTransactionSchema.parse(raw);
      }
      if (
        accepted.documentId !== handle.documentId ||
        accepted.epoch !== meta.epoch
      )
        throw new Error("Recovery transaction mismatch");
      if (accepted.revision <= revision) continue;
      if (accepted.revision !== revision + 1)
        throw new Error("Recovery revision gap");
      document = applyValidatedDocumentOperations(
        document,
        accepted.operations,
      );
      revision = accepted.revision;
    }
    return {
      document: presentationDocumentSchema.parse(document),
      epoch: meta.epoch,
      revision,
      savedRevision: meta.savedRevision,
    };
  }
}
