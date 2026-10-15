import type { AcceptedTransaction } from "../src/core/documentTransactions";
import { acceptedImpact } from "../src/core/documentImpact";
import type {
  PackageFontResources,
  fontStorageService,
} from "./fontIntegration";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { measurePerformance } from "../src/core/performance";
import {
  collectUsedFontUsages,
  nonPortableFontFamilies,
} from "../src/core/fonts";
import { idSchema } from "../src/core/ids";
import { hashSchema, type Asset } from "../src/core/assets";
import type { DocumentSummary } from "../src/core/documentSummary";
import {
  parsePackageManifest,
  withoutSpeakerNotes,
  parsePackagedAssetMetadata,
  packageManifestSchema,
  SHOWME_DOCUMENT_EXTENSION,
  SHOWME_PACKAGE_DOCUMENT_PATH,
  SHOWME_PACKAGE_FORMAT,
  SHOWME_PACKAGE_VERSION,
  type ShowMePackageManifest,
} from "../src/core/package";
import {
  writeStoredZipFile,
  readStoredZipFile,
  readArchiveEntry,
  type ZipEntryInput,
} from "./packageArchive";
import { StorageMedia } from "./storage/media";
import {
  RecoveryJournal,
  type RecoveryHandle,
} from "./storage/recoveryJournal";
import {
  DocumentRuntime,
  parseRuntimeDocument,
} from "../src/core/documentRuntime";
import {
  forkPresentationDocument,
  newPresentationDocument,
  presentationDocumentSchema,
  type PresentationDocument,
} from "../src/core/document";
import { documentAssetIds } from "../src/core/documentAssets";
import type { LibraryLifecycleMode } from "../src/core/libraryLifecycle";
import {
  LibraryOpenProtection,
  restoreLibraryAsset,
  isInsideRoot,
  documentLibraryHashes,
  documentFontUsages,
} from "./libraryLifecycle";
import { atomicWrite, digest, hashFile } from "./storage/io";
export { atomicWrite, hashFile } from "./storage/io";
import {
  assetIdFromFilename,
  libraryIndex,
  folderForMediaType,
  findManagedFile,
} from "./mediaLibrary";

interface StoredDocument {
  handle: RecoveryHandle;
  runtime: DocumentRuntime;
  packagePath?: string;
  packageFingerprint?: string;
  packageFonts?: PackageFontResources;
  packageAssets?: Map<string, { asset: Asset; file: string }>;
  packageLocked?: boolean;
  localMedia?: StorageMedia;
}

export interface RecoveryCandidate {
  originalPath: string;
  recoveryPath: string;
  documentId: string;
  originalLastSavedAt: string | null;
  updatedAt: string;
}

function documentNameFromFile(file: string) {
  const extension = path.extname(file);
  return path.basename(file, extension) || "Untitled";
}

function ensureSmePath(file: string) {
  if (path.extname(file).toLowerCase() !== SHOWME_DOCUMENT_EXTENSION)
    throw new Error("ShowMe presentations must use the .sme extension");
  return path.resolve(file);
}

function adjacentRecoveryPath(file: string) {
  return file.slice(0, -SHOWME_DOCUMENT_EXTENSION.length) + ".recovery.sme";
}

export class DocumentStorage {
  private readonly documents = new Map<string, StoredDocument>();
  private readonly recovery = new RecoveryJournal();
  public readonly cacheRoot: string;
  public readonly recoveryRoot: string;
  private readonly media: StorageMedia;
  private protection: LibraryOpenProtection;
  lifecycleMode: LibraryLifecycleMode;
  onResourcesChanged?: (documentIds: readonly string[]) => void;
  private readonly documentFonts = new Map<
    string,
    import("../src/core/fonts").FontUsage[]
  >();
  fonts?: typeof fontStorageService;
  packageFontWarnings(id: string) {
    const entry = this.entry(id);
    const document = entry.runtime.authority.document;
    return nonPortableFontFamilies(
      collectUsedFontUsages(
        [
          ...Object.values(document.slides),
          ...Object.values(document.templates).map((page) => ({
            ...page,
            notes: "",
          })),
        ],
        document.deck,
      ),
      entry.packageFonts?.files ?? [],
    );
  }
  async managedFonts(documentId?: string) {
    const resources = documentId
      ? this.entry(documentId).packageFonts
      : undefined;
    return this.fonts?.managed(this, resources) ?? [];
  }
  private importDocumentId: string | null = null;
  private readonly retainedDocumentAssets = new Map<string, Set<string>>();
  private externalProtectionId: string | null = null;
  private externalDocument: PresentationDocument | null = null;
  setExternalOpenDocument(
    document: PresentationDocument | null,
    accepted?: AcceptedTransaction,
  ) {
    if (document === this.externalDocument) return;
    this.externalDocument = document;
    const key = document ? `remote:${document.documentId}` : null;
    if (this.externalProtectionId && this.externalProtectionId !== key)
      this.releaseDocumentAssets(this.externalProtectionId);
    this.externalProtectionId = key;
    if (document && key) {
      const impact = accepted && acceptedImpact(accepted, document);
      if (!impact || impact.dependencies)
        this.trackDocumentDependencies(key, document, impact?.dependencyPages);
    }
  }
  private trackDocumentDependencies(
    key: string,
    document: PresentationDocument,
    pageIds?: readonly string[],
  ) {
    const usages = documentFontUsages(document, pageIds);
    const previous = this.documentFonts.get(key) ?? [];
    const all = new Map(
      [...previous, ...usages].map((usage) => [JSON.stringify(usage), usage]),
    );
    this.documentFonts.set(key, [...all.values()]);
    this.retainDocumentAssets(
      key,
      documentLibraryHashes(this.assetRoot, document, pageIds),
    );
  }
  private retainDocumentAssets(id: string, hashes: Iterable<string>) {
    const retained = this.retainedDocumentAssets.get(id) ?? new Set<string>();
    for (const hash of hashes) retained.add(hash);
    this.retainedDocumentAssets.set(id, retained);
    this.protection.protect(retained);
  }
  private releaseDocumentAssets(id: string) {
    this.documentFonts.delete(id);
    this.retainedDocumentAssets.delete(id);
    this.protection.replace(
      [...this.retainedDocumentAssets.values()].flatMap((hashes) => [
        ...hashes,
      ]),
    );
    if (this.importDocumentId === id) this.importDocumentId = null;
  }
  openDocuments() {
    return [...this.documents.values()].map(
      (entry) => entry.runtime.authority.document,
    );
  }
  setImportDocument(id: string | null) {
    this.importDocumentId = id;
  }
  get openProtection() {
    return this.protection;
  }
  protectAssetImports(documentId: string, hashes: string[]) {
    this.entry(documentId);
    this.retainDocumentAssets(
      documentId,
      hashes.map((hash) => hashSchema.parse(hash)),
    );
  }

  get assetRoot() {
    return this.media.assetRoot;
  }

  constructor(
    assetRoot: string,
    cacheRoot: string,
    mode?: LibraryLifecycleMode,
  ) {
    this.cacheRoot = path.resolve(cacheRoot);
    this.recoveryRoot = path.join(path.dirname(this.cacheRoot), "recovery");
    this.media = new StorageMedia(assetRoot, this.cacheRoot);
    this.media.onChanged = (change) => {
      if (
        !change.ids ||
        change.ids.some((id) =>
          /\.(ttf|otf|woff2?)$/i.test(
            libraryIndex(this.assetRoot)?.files.get(id)?.file ?? "",
          ),
        )
      )
        this.onFontInventoryChanged?.();
      const changed = change.ids ? new Set(change.ids) : undefined;
      const affected: string[] = [];
      const documents = [
        ...this.openDocuments(),
        ...(this.externalDocument ? [this.externalDocument] : []),
      ];
      for (const document of documents) {
        const key =
          document === this.externalDocument
            ? "remote:" + document.documentId
            : document.documentId;
        const fonts =
          libraryIndex(this.assetRoot)?.fontHashes(
            this.documentFonts.get(key) ?? [],
            changed,
          ) ?? [];
        if (
          !changed ||
          fonts.length ||
          [...changed].some((id) =>
            this.retainedDocumentAssets.get(key)?.has(id),
          )
        ) {
          this.retainDocumentAssets(key, fonts);
          affected.push(document.documentId);
        }
      }
      if (affected.length) this.onResourcesChanged?.(affected);
    };
    this.lifecycleMode = mode ?? "managed";
    this.protection = new LibraryOpenProtection(this.cacheRoot, assetRoot);
  }

  onFontInventoryChanged?: () => void;

  async init() {
    if (this.lifecycleMode !== "portable") await this.media.init();
    await fs.mkdir(this.cacheRoot, { recursive: true });
    await fs.mkdir(this.recoveryRoot, { recursive: true });
  }

  async setAssetRoot(newRoot: string) {
    for (const entry of this.documents.values()) {
      for (const hash of documentAssetIds(entry.runtime.authority.document)) {
        if (entry.packageAssets?.has(hash)) continue;
        if (!findManagedFile(newRoot, hash))
          throw new Error(
            "The selected Library is missing media used by an open presentation. Save it as portable or close it before changing Library location.",
          );
      }
    }
    const previousProtection = this.protection;
    await this.media.setAssetRoot(newRoot);
    this.protection = new LibraryOpenProtection(this.cacheRoot, newRoot);
    this.protection.protect([
      ...[...this.retainedDocumentAssets.values()].flatMap((hashes) => [
        ...hashes,
      ]),
      ...this.openDocuments().flatMap((document) =>
        documentLibraryHashes(newRoot, document),
      ),
    ]);
    await previousProtection.dispose();
  }

  private async lastSavedAt(file: string) {
    return new Date((await fs.stat(file)).mtimeMs).toISOString();
  }

  private async withDocumentLock<T>(
    handle: { filePath: string | null; lockPath?: string },
    task: () => Promise<T>,
  ) {
    if (!handle.filePath) return task();
    const lock =
      handle.lockPath ??
      path.join(
        this.cacheRoot,
        "locks",
        digest(path.resolve(handle.filePath)) + ".lock",
      );
    await fs.mkdir(path.dirname(lock), { recursive: true });
    let lockHandle;
    try {
      lockHandle = await fs.open(lock, "wx");
    } catch {
      throw new Error(
        "Presentation is being written, or a stale lock remains. Retry after closing the other writer.",
      );
    }
    try {
      return await task();
    } finally {
      await lockHandle.close();
      await fs.rm(lock, { force: true });
    }
  }

  private serializeDocument(document: PresentationDocument) {
    const { recovery: _recovery, ...clean } =
      presentationDocumentSchema.parse(document);
    const deck = { ...clean.deck } as Partial<typeof clean.deck>;
    delete deck.name;
    return JSON.stringify({ ...clean, deck }, null, 2) + "\n";
  }

  private entry(id: string) {
    const entry = this.documents.get(idSchema.parse(id));
    if (!entry) throw new Error("Presentation is not open");
    return entry;
  }

  private host(
    document: PresentationDocument,
    handle: Omit<RecoveryHandle, "epoch" | "revision" | "savedRevision">,
    state?: { epoch: string; revision: number; savedRevision: number },
  ) {
    if (this.documents.has(document.documentId))
      throw new Error("Presentation is already open");
    const recoveryHandle: RecoveryHandle = {
      ...handle,
      epoch: state?.epoch ?? crypto.randomUUID(),
      revision: state?.revision ?? 0,
      savedRevision: state?.savedRevision ?? 0,
    };
    const runtime = new DocumentRuntime(document, {
      actorId: "local",
      epoch: recoveryHandle.epoch,
      revision: recoveryHandle.revision,
      savedRevision: recoveryHandle.savedRevision,
      durableCommit: async (accepted, candidate) => {
        const impact = acceptedImpact(accepted, candidate);
        if (impact.dependencies)
          this.trackDocumentDependencies(
            candidate.documentId,
            candidate,
            impact.dependencyPages,
          );
        await this.recovery.append(
          recoveryHandle,
          accepted,
          runtime.authority.document,
          candidate,
        );
        recoveryHandle.revision = accepted.revision;
      },
    });
    this.trackDocumentDependencies(document.documentId, document);
    this.importDocumentId = document.documentId;
    this.documents.set(document.documentId, {
      handle: recoveryHandle,
      runtime,
    });
    const stagedRoot = path.join(
      this.cacheRoot,
      "portable-assets",
      document.documentId,
    );
    if (existsSync(stagedRoot))
      this.entry(document.documentId).localMedia = new StorageMedia(
        stagedRoot,
        this.cacheRoot,
      );
    return this.summary(document.documentId);
  }

  documentRuntime(id: string) {
    return this.entry(id).runtime;
  }

  hasDocument(id: string) {
    return this.documents.has(idSchema.parse(id));
  }

  summary(id: string) {
    const entry = this.entry(id);
    const { handle, runtime } = entry;
    const document = runtime.authority.document;
    return {
      id: document.documentId,
      name: handle.filePath
        ? documentNameFromFile(handle.filePath)
        : document.deck.name,
      location: entry.packagePath ?? handle.filePath ?? "",
      dirty:
        runtime.authority.dirty || (!entry.packagePath && !handle.filePath),
      untitled: !entry.packagePath && !handle.filePath,
    } satisfies DocumentSummary;
  }

  async inspectDocument(file: string) {
    if (path.extname(file).toLowerCase() === ".smp") {
      const resolved = path.resolve(file);
      const open = [...this.documents.entries()].find(
        ([, entry]) => entry.packagePath === resolved,
      );
      if (open)
        return {
          summary: this.summary(open[0]),
          firstSlideId: open[1].runtime.authority.document.deck.slideIds[0],
        };
      const { document, manifest } = await this.verifyPackage(resolved);
      return {
        summary: {
          id: document.documentId,
          name: manifest.documentName,
          location: resolved,
          dirty: false,
          untitled: false,
        } satisfies DocumentSummary,
        firstSlideId: document.deck.slideIds[0],
      };
    }
    const resolved = ensureSmePath(file);
    const text = await measurePerformance("document.read", () =>
      fs.readFile(resolved, "utf8"),
    );
    const raw = measurePerformance("document.parse", () =>
      JSON.parse(text),
    ) as { deck?: Record<string, unknown> };
    const document = measurePerformance("document.validate", () =>
      parseRuntimeDocument({
        ...raw,
        deck: { ...(raw.deck ?? {}), name: documentNameFromFile(resolved) },
      }),
    );
    return {
      summary: {
        id: document.documentId,
        name: document.deck.name,
        location: resolved,
        dirty: false,
        untitled: false,
      } satisfies DocumentSummary,
      firstSlideId: document.deck.slideIds[0],
    };
  }

  async openDocument(file: string, mode: "saved" | "recover" = "saved") {
    const resolved = ensureSmePath(file);
    const text = await measurePerformance("document.read", () =>
      fs.readFile(resolved, "utf8"),
    );
    const raw = measurePerformance("document.parse", () =>
      JSON.parse(text),
    ) as { deck?: Record<string, unknown> };
    let document = measurePerformance("document.validate", () =>
      parseRuntimeDocument({
        ...raw,
        deck: { ...(raw.deck ?? {}), name: documentNameFromFile(resolved) },
      }),
    );
    const fileRevision = digest(text);
    let state:
      { epoch: string; revision: number; savedRevision: number } | undefined;
    const recoveryPath = adjacentRecoveryPath(resolved);
    if (mode === "recover") {
      const recovered = await this.recovery.read(
        { documentId: document.documentId, fileRevision, recoveryPath },
        document,
      );
      document = recovered.document;
      state = recovered;
    }
    return measurePerformance("document.authority", () =>
      this.host(
        document,
        {
          documentId: document.documentId,
          filePath: resolved,
          fileRevision,
          recoveryPath,
        },
        state,
      ),
    );
  }

  async discardRecoveryForPath(file: string) {
    const resolved = ensureSmePath(file);
    await this.recovery.discard(adjacentRecoveryPath(resolved));
  }

  async recoveryCandidate(file: string): Promise<RecoveryCandidate | null> {
    const resolved = ensureSmePath(file);
    try {
      const text = await fs.readFile(resolved, "utf8");
      const raw = JSON.parse(text) as { deck?: Record<string, unknown> };
      const base = parseRuntimeDocument({
        ...raw,
        deck: { ...(raw.deck ?? {}), name: documentNameFromFile(resolved) },
      });
      const recoveryPath = adjacentRecoveryPath(resolved);
      const recovered = await this.recovery.read(
        {
          documentId: base.documentId,
          fileRevision: digest(text),
          recoveryPath,
        },
        base,
      );
      if (recovered.revision <= recovered.savedRevision) return null;
      const files = ["checkpoint.json", "transactions.jsonl"];
      const updatedAt = new Date(
        Math.max(
          ...(await Promise.all(
            files.map(
              async (name) =>
                (await fs.stat(path.join(recoveryPath, name))).mtimeMs,
            ),
          )),
        ),
      ).toISOString();
      return {
        originalPath: resolved,
        recoveryPath,
        documentId: base.documentId,
        originalLastSavedAt: await this.lastSavedAt(resolved),
        updatedAt,
      };
    } catch {
      return null;
    }
  }

  async createDocument(name: string) {
    const document = newPresentationDocument(name);
    const summary = this.host(document, {
      documentId: document.documentId,
      filePath: null,
      fileRevision: null,
      recoveryPath: path.join(
        this.recoveryRoot,
        document.documentId + ".recovery.sme",
      ),
    });
    const { handle } = this.entry(document.documentId);
    await this.recovery.checkpoint(handle, document);
    return summary;
  }

  async listUntitledRecoveries() {
    const candidates: {
      documentId: string;
      name: string;
      updatedAt: string;
    }[] = [];
    for (const entry of await fs.readdir(this.recoveryRoot, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".recovery.sme"))
        continue;
      const recoveryPath = path.join(this.recoveryRoot, entry.name);
      try {
        const checkpoint = JSON.parse(
          await fs.readFile(path.join(recoveryPath, "checkpoint.json"), "utf8"),
        ) as { version?: number; document?: PresentationDocument };
        const base = parseRuntimeDocument(checkpoint.document);
        const recovered = await this.recovery.read(
          { documentId: base.documentId, fileRevision: null, recoveryPath },
          base,
        );
        if (recovered.revision <= recovered.savedRevision) continue;
        candidates.push({
          documentId: base.documentId,
          name: recovered.document.deck.name,
          updatedAt: new Date(
            (await fs.stat(recoveryPath)).mtimeMs,
          ).toISOString(),
        });
      } catch {
        /* Ignore incomplete recovery directories. */
      }
    }
    return candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async recoverUntitled(documentId: string) {
    const id = idSchema.parse(documentId);
    const recoveryPath = path.join(this.recoveryRoot, id + ".recovery.sme");
    const checkpoint = JSON.parse(
      await fs.readFile(path.join(recoveryPath, "checkpoint.json"), "utf8"),
    ) as { document?: PresentationDocument };
    const base = parseRuntimeDocument(checkpoint.document);
    if (base.documentId !== id)
      throw new Error("Recovery targets another document");
    const recovered = await this.recovery.read(
      { documentId: id, fileRevision: null, recoveryPath },
      base,
    );
    if (recovered.revision <= recovered.savedRevision)
      throw new Error("No unsaved recovery state is available");
    return this.host(
      recovered.document,
      { documentId: id, filePath: null, fileRevision: null, recoveryPath },
      recovered,
    );
  }

  async saveDocument(id: string, destination?: string) {
    const entry = this.entry(id);
    const { handle, runtime } = entry;
    if (!destination && entry.packagePath)
      return this.savePackageAs(
        id,
        entry.packagePath,
        entry.packageLocked ?? false,
        entry.packageFingerprint,
      );
    if (destination && path.extname(destination).toLowerCase() === ".smp")
      return this.savePackageAs(id, destination, entry.packageLocked ?? false);
    const target = destination ? ensureSmePath(destination) : handle.filePath;
    if (!target) throw new Error("Untitled presentations require Save As");
    return runtime.authority.runExclusive(async (snapshot) => {
      if (entry.packageLocked)
        throw new Error(
          "Locked package media cannot be extracted into the shared Library",
        );
      await this.fonts?.toLibrary(this, id, entry.packageFonts);
      for (const assetId of documentAssetIds(snapshot.document)) {
        if (!entry.packageAssets?.has(assetId) && !entry.localMedia) continue;
        const asset = await this.assetForDocument(id, assetId);
        const source = this.assetPathForDocument(id, assetId);
        this.retainDocumentAssets(id, [assetId]);
        const imported = await this.media.importBytes(
          asset.names[0],
          await fs.readFile(source),
        );
        if (imported.id !== assetId)
          throw new Error("Presentation asset failed hash verification");
      }
      const sameFile =
        handle.filePath && path.resolve(handle.filePath) === target;
      await this.withDocumentLock({ filePath: target }, async () => {
        if (sameFile) {
          const current = digest(await fs.readFile(target, "utf8"));
          if (current !== handle.fileRevision)
            throw new Error(
              "This presentation changed on disk. Reopen it before saving to avoid overwriting external edits.",
            );
        }
        const text = this.serializeDocument(snapshot.document);
        await atomicWrite(target, text);
        const previousRecovery = handle.recoveryPath;
        handle.filePath = target;
        handle.fileRevision = digest(text);
        handle.recoveryPath = adjacentRecoveryPath(target);
        handle.savedRevision = snapshot.revision;
        runtime.authority.syncRuntimeDeckName(documentNameFromFile(target));
        runtime.authority.markSaved(snapshot.revision);
        entry.packagePath = undefined;
        entry.packageLocked = undefined;
        await this.recovery.discard(previousRecovery);
        if (previousRecovery !== handle.recoveryPath)
          await this.recovery.discard(handle.recoveryPath);
      });
      return this.summary(id);
    });
  }

  async assertNativeFileUnchanged(id: string) {
    const { handle } = this.entry(id);
    if (!handle.filePath || !handle.fileRevision)
      throw new Error("This presentation has no saved native file");
    if (
      digest(await fs.readFile(handle.filePath, "utf8")) !== handle.fileRevision
    )
      throw new Error(
        "This presentation changed on disk. Reopen it before moving to avoid removing external edits.",
      );
    return { file: handle.filePath, revision: handle.fileRevision };
  }

  closeDocument(id: string) {
    this.entry(id);
    this.documents.delete(id);
    this.releaseDocumentAssets(id);
  }

  async discardDocumentChanges(id: string) {
    const { handle } = this.entry(id);
    await this.recovery.discard(handle.recoveryPath);
    this.documents.delete(idSchema.parse(id));
    this.releaseDocumentAssets(id);
  }

  private async verifyPackage(file: string) {
    const archive = await readStoredZipFile(file);
    const { entries } = archive;
    try {
      const manifestBytes = entries.get("manifest.json");
      if (!manifestBytes) throw new Error("Package manifest is missing");
      const manifest = parsePackageManifest(
        JSON.parse((await readArchiveEntry(manifestBytes)).toString("utf8")),
      );
      const documentBytes = entries.get(manifest.documentPath);
      if (!documentBytes) throw new Error("Package document is missing");
      const rawDocument = JSON.parse(
        (await readArchiveEntry(documentBytes)).toString("utf8"),
      ) as {
        deck?: Record<string, unknown>;
      };
      const document = parseRuntimeDocument({
        ...rawDocument,
        deck: { ...(rawDocument.deck ?? {}), name: manifest.documentName },
      });
      if (document.documentId !== manifest.sourceDocumentId)
        throw new Error(
          "Package document identity does not match its manifest",
        );
      const actualIds = documentAssetIds(document);
      const declaredIds = manifest.assets.map((item) => item.id).sort();
      if (
        actualIds.length !== declaredIds.length ||
        actualIds.some((assetId, index) => assetId !== declaredIds[index])
      )
        throw new Error("Package asset manifest does not match the document");
      for (const item of manifest.assets) {
        const metadataBytes = entries.get(item.metadataPath);
        const original = entries.get(item.originalPath);
        if (!metadataBytes || !original)
          throw new Error("Package asset is incomplete");
        const metadata = parsePackagedAssetMetadata(
          JSON.parse(
            (await readArchiveEntry(metadataBytes, 1024 ** 2)).toString("utf8"),
          ),
        );
        if (
          item.metadataPath !== `metadata/${item.id}.json` ||
          item.originalPath !==
            `${folderForMediaType(metadata.mediaType)}/${metadata.filename}` ||
          assetIdFromFilename(metadata.filename) !== item.id
        )
          throw new Error("Package asset layout is invalid");
        if (
          metadata.id !== item.id ||
          metadata.mime !== item.mime ||
          original.bytes !== item.bytes ||
          (await hashFile(original.file)) !== item.id
        )
          throw new Error(`Packaged asset ${item.id} failed verification`);
      }
      return { entries, manifest, document, dispose: archive.dispose };
    } catch (error) {
      await archive.dispose();
      throw error;
    }
  }

  private async cachePackageAssets(
    file: string,
    verified: Awaited<ReturnType<DocumentStorage["verifyPackage"]>>,
  ) {
    const packageAssets = new Map<string, { asset: Asset; file: string }>();
    for (const item of verified.manifest.assets) {
      const metadataBytes = verified.entries.get(item.metadataPath)!;
      const original = verified.entries.get(item.originalPath)!;
      const metadata = parsePackagedAssetMetadata(
        JSON.parse(
          (await readArchiveEntry(metadataBytes, 1024 ** 2)).toString("utf8"),
        ),
      );
      const embeddedPath = path.join(
        this.cacheRoot,
        "packages",
        digest(path.resolve(file)),
        item.id,
      );
      await fs.mkdir(path.dirname(embeddedPath), { recursive: true });
      await fs.copyFile(original.file, embeddedPath);
      packageAssets.set(item.id, { asset: metadata, file: embeddedPath });
    }
    return packageAssets;
  }

  async openPackage(file: string): Promise<DocumentSummary> {
    const resolved = path.resolve(file);
    const packageFingerprint = await hashFile(resolved);
    const verified = await this.verifyPackage(resolved);
    try {
      const packageAssets = await this.cachePackageAssets(resolved, verified);
      const packageFonts = await this.fonts?.load(this, resolved);
      if ((await hashFile(resolved)) !== packageFingerprint)
        throw new Error("Package changed while opening; reopen it.");
      let document = forkPresentationDocument(verified.document);
      document = presentationDocumentSchema.parse({
        ...document,
        deck: { ...document.deck, name: verified.manifest.documentName },
      });
      this.host(document, {
        documentId: document.documentId,
        filePath: null,
        fileRevision: null,
        recoveryPath: path.join(
          this.recoveryRoot,
          document.documentId + ".recovery.sme",
        ),
      });
      const entry = this.entry(document.documentId);
      entry.packagePath = resolved;
      entry.packageFingerprint = packageFingerprint;
      entry.packageFonts = packageFonts;
      entry.packageAssets = packageAssets;
      entry.packageLocked = verified.manifest.lockMediaFiles;
      try {
        await this.recovery.checkpoint(entry.handle, document);
      } catch (error) {
        this.closeDocument(document.documentId);
        throw error;
      }
      return this.summary(document.documentId);
    } finally {
      await verified.dispose();
    }
  }

  private async writePackage(
    id: string,
    file: string,
    lockMediaFiles: boolean,
    document: PresentationDocument,
    expectedFingerprint?: string,
  ) {
    const entry = this.entry(id);
    if (document.documentId !== entry.runtime.authority.document.documentId)
      throw new Error("Package snapshot targets another presentation");
    const assetIds = documentAssetIds(document);
    const assets: ShowMePackageManifest["assets"] = [];
    const entries: ZipEntryInput[] = [];
    for (const assetId of assetIds) {
      let asset = await this.assetForDocument(id, assetId);
      const source = this.assetPathForDocument(id, assetId);
      if (!entry.packageAssets?.has(assetId)) {
        const folder = path.basename(path.dirname(source));
        asset = {
          ...asset,
          filename: path.basename(source),
          mediaType:
            folder === "images"
              ? "image"
              : folder === "video"
                ? "video"
                : folder === "audio"
                  ? "audio"
                  : folder === "fonts"
                    ? "font"
                    : "other",
        };
      }
      const bytes = (await fs.stat(source)).size;
      if ((await hashFile(source)) !== assetId)
        throw new Error(`Asset ${assetId} failed hash verification`);
      const folder = folderForMediaType(asset.mediaType);
      const metadataPath = `metadata/${assetId}.json`;
      const originalPath = `${folder}/${asset.filename}`;
      assets.push({
        id: assetId,
        bytes,
        mime: asset.mime,
        metadataPath,
        originalPath,
      });
      entries.push({
        name: metadataPath,
        data: JSON.stringify(asset, null, 2) + "\n",
      });
      entries.push({ name: originalPath, file: source });
    }
    const packagedFonts = await this.fonts?.package(
      this,
      document,
      entry.packageFonts,
    );
    entries.push(...(packagedFonts?.entries ?? []));
    const manifest = {
      ...packageManifestSchema.parse({
        format: SHOWME_PACKAGE_FORMAT,
        packageVersion: SHOWME_PACKAGE_VERSION,
        documentVersion: document.version,
        sourceDocumentId: document.documentId,
        documentName: document.deck.name,
        documentPath: SHOWME_PACKAGE_DOCUMENT_PATH,
        createdAt: new Date().toISOString(),
        lockMediaFiles,
        assets,
      }),
      fonts: packagedFonts?.fonts ?? [],
    };
    entries.push({
      name: SHOWME_PACKAGE_DOCUMENT_PATH,
      data: this.serializeDocument(document),
    });
    entries.push({
      name: "manifest.json",
      data: JSON.stringify(manifest, null, 2) + "\n",
    });
    const staging = `${file}.${crypto.randomUUID()}.tmp`;
    let fingerprint: string;
    let packageAssets: StoredDocument["packageAssets"];
    let packageFonts: PackageFontResources | undefined;
    try {
      await writeStoredZipFile(staging, entries);
      const verified = await this.verifyPackage(staging);
      try {
        packageAssets = await this.cachePackageAssets(file, verified);
      } finally {
        await verified.dispose();
      }
      packageFonts = await this.fonts?.load(this, staging);
      fingerprint = await hashFile(staging);
      await this.withDocumentLock(
        { filePath: file, lockPath: file + ".showme-write.lock" },
        async () => {
          if (
            expectedFingerprint &&
            (await hashFile(file)) !== expectedFingerprint
          )
            throw new Error(
              "This package changed on disk. Reopen it before saving, or use Save As to explicitly overwrite it.",
            );
          await fs.rename(staging, file);
        },
      );
    } finally {
      await fs.rm(staging, { force: true });
    }
    return {
      path: path.resolve(file),
      fingerprint,
      packageAssets,
      packageFonts,
    };
  }

  async packageDocument(
    id: string,
    file: string,
    lockMediaFiles?: boolean,
    removeSpeakerNotes = false,
  ) {
    const entry = this.entry(id);
    return entry.runtime.authority.runExclusive(
      async (snapshot) =>
        (
          await this.writePackage(
            id,
            file,
            lockMediaFiles ?? entry.packageLocked ?? false,
            removeSpeakerNotes
              ? withoutSpeakerNotes(snapshot.document)
              : snapshot.document,
          )
        ).path,
    );
  }

  async savePackageAs(
    id: string,
    file: string,
    lockMediaFiles: boolean,
    expectedFingerprint?: string,
  ) {
    const entry = this.entry(id);
    return entry.runtime.authority.runExclusive(async (snapshot) => {
      const written = await this.writePackage(
        id,
        file,
        lockMediaFiles,
        snapshot.document,
        expectedFingerprint,
      );
      entry.packagePath = written.path;
      entry.packageFingerprint = written.fingerprint;
      entry.packageLocked = lockMediaFiles;
      entry.packageFonts = written.packageFonts;
      entry.packageAssets = new Map([
        ...(entry.packageAssets ?? []),
        ...(written.packageAssets ?? []),
      ]);
      entry.handle.savedRevision = snapshot.revision;
      entry.runtime.authority.markSaved(snapshot.revision);
      await this.recovery.discard(entry.handle.recoveryPath);
      return this.summary(id);
    });
  }

  async loadDerivedAssets() {
    await this.media.loadDerivedAssets();
  }

  async verifiedAssetPath(id: string) {
    const index = libraryIndex(this.assetRoot);
    if (index && !(await index.verify(hashSchema.parse(id))))
      throw new Error("Asset not found: " + id);
    return this.assetPath(id);
  }
  async verifiedAssetPathForDocument(documentId: string, id: string) {
    let file: string | undefined;
    try {
      file = this.assetPathForDocument(documentId, id);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith("Asset not found:")
      )
        throw error;
    }
    if (file && !isInsideRoot(this.assetRoot, file)) return file;
    await this.verifiedAssetPath(id);
    return this.assetPathForDocument(documentId, id);
  }
  async dispose() {
    await this.recovery.settleMaintenance();
    this.media.dispose();
    for (const entry of this.documents.values()) entry.localMedia?.dispose();
    await this.protection.dispose();
  }

  assetPath(id: string) {
    restoreLibraryAsset(this.assetRoot, id);
    return this.media.assetPath(id);
  }

  assetPathForDocument(documentId: string, id: string) {
    const documentIdParsed = idSchema.parse(documentId);
    const assetId = hashSchema.parse(id);
    const embedded = this.entry(documentIdParsed).packageAssets?.get(assetId);
    if (embedded) return embedded.file;
    const local = this.entry(documentIdParsed).localMedia;
    if (local) {
      try {
        return local.assetPath(assetId);
      } catch {
        /* May belong to the shared library. */
      }
    }
    restoreLibraryAsset(this.assetRoot, assetId);
    return this.media.assetPath(assetId);
  }

  async assetForDocument(documentId: string, id: string) {
    const documentIdParsed = idSchema.parse(documentId);
    const assetId = hashSchema.parse(id);
    const embedded = this.entry(documentIdParsed).packageAssets?.get(assetId);
    if (embedded) return embedded.asset;
    const local = this.entry(documentIdParsed).localMedia;
    if (local) {
      try {
        return await local.asset(assetId);
      } catch {
        /* May belong to the shared library. */
      }
    }
    await this.verifiedAssetPath(assetId);
    return this.media.asset(assetId);
  }

  isPackaged(documentId: string) {
    const entry = this.entry(idSchema.parse(documentId));
    return {
      packaged: Boolean(entry.packagePath),
      locked: Boolean(entry.packageLocked),
    };
  }

  async saveMediaAs(documentId: string, id: string, destination: string) {
    const parsed = idSchema.parse(documentId);
    const entry = this.entry(parsed);
    if (entry.packageLocked) throw new Error("Package media is locked");
    const assetId = hashSchema.parse(id);
    const assetIds = documentAssetIds(entry.runtime.authority.document);
    if (!assetIds.includes(assetId))
      throw new Error("Media is not referenced by this presentation");
    const source = await this.verifiedAssetPathForDocument(parsed, assetId);
    await fs.copyFile(source, destination);
  }

  previewPath(id: string) {
    return this.media.previewPath(id);
  }

  async listAssets(query: string, offset: number, limit: number) {
    const entry = this.importDocumentId
      ? this.documents.get(this.importDocumentId)
      : undefined;
    if (this.lifecycleMode === "portable") {
      if (!entry)
        return { items: [], total: 0, counts: { images: 0, videos: 0 } };
      return (await this.localMedia(entry)).listAssets(query, offset, limit);
    }
    return this.media.listAssets(query, offset, limit);
  }

  private async localMedia(entry: StoredDocument) {
    if (!entry.localMedia) {
      entry.localMedia = new StorageMedia(
        path.join(this.cacheRoot, "portable-assets", entry.handle.documentId),
        this.cacheRoot,
      );
      await entry.localMedia.init();
    }
    return entry.localMedia;
  }

  private async importSource(name: string, source: string | Uint8Array) {
    const entry = this.importDocumentId
      ? this.documents.get(this.importDocumentId)
      : undefined;
    if (
      entry &&
      (entry.packagePath ||
        (this.lifecycleMode === "portable" && !entry.handle.filePath))
    ) {
      const local = await this.localMedia(entry);
      const asset =
        typeof source === "string"
          ? await local.importFile(source)
          : await local.importBytes(name, source);
      entry.packageAssets ??= new Map();
      entry.packageAssets.set(asset.id, {
        asset,
        file: local.assetPath(asset.id),
      });
      return asset;
    }
    if (this.lifecycleMode === "portable")
      throw new Error(
        "Save this presentation as a portable .smp package before importing media",
      );
    const documentId = this.importDocumentId;
    const protect = (hash: string) => {
      if (documentId) this.retainDocumentAssets(documentId, [hash]);
      else this.protection.protect([hash]);
      restoreLibraryAsset(this.assetRoot, hash);
    };
    return typeof source === "string"
      ? this.media.importFile(source, protect)
      : this.media.importBytes(name, source, protect);
  }

  async importFile(file: string) {
    return this.importSource(path.basename(file), file);
  }

  async importAssetData(name: string, bytes: Uint8Array) {
    return this.importSource(name, bytes);
  }

  async asset(id: string): Promise<Asset> {
    await this.verifiedAssetPath(id);
    return this.media.asset(id);
  }

  async updateAsset(asset: Asset) {
    for (const entry of this.documents.values()) {
      const embedded = entry.packageAssets?.get(asset.id);
      if (embedded) embedded.asset = asset;
      if (entry.localMedia) await entry.localMedia.updateAsset(asset);
    }
    if (this.lifecycleMode !== "portable") await this.media.updateAsset(asset);
  }

  async storePreview(id: string, data: Uint8Array) {
    await this.media.storePreview(id, data);
  }

  thumbnailPath(documentId: string, slideId: string) {
    return this.media.thumbnailPath(documentId, slideId);
  }

  async storeThumbnail(documentId: string, slideId: string, data: string) {
    await this.media.storeThumbnail(documentId, slideId, data);
  }
}
