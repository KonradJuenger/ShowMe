import type { Asset, AssetCategory } from "../core/assets";
import type { DocumentSummary } from "../core/documentSummary";
import type { ContextMenuRequest, ContextMenuSelection } from "./contextMenu";
import type { PresentationCommand } from "../core/presentationSession";
import type {
  PresentationDisplay,
  PresentationDisplayAssignment,
} from "../core/presentationDisplays";
import type {
  DiscoveryRecord,
  InteractionPreview,
} from "../core/collaboration/protocol";
import type { DocumentProjection } from "../core/documentProjection";
import type {
  AcceptedTransaction,
  DocumentTransaction,
} from "../core/documentTransactions";
import type {
  EditScope,
  LeaseDenied,
  LeaseGrant,
} from "../core/documentAuthority";

export interface CollaborationStatus {
  hosted: DiscoveryRecord | null;
  pending: Array<{
    id: string;
    displayName: string;
    deviceName: string;
    address: string;
  }>;
  connected: Array<{
    id: string;
    displayName: string;
    deviceName: string;
    address: string;
  }>;
  clientStatus:
    | "idle"
    | "connecting"
    | "waiting"
    | "connected"
    | "rejected"
    | "incompatible"
    | "lost";
  clientDocumentId: string | null;
  actorId?: string | null;
  sessionRevision?: number | null;
  leases?: LeaseGrant[];
  locks?: Array<{
    slideId: string;
    elementId: string;
    actorId: string;
    expiresAt: number;
  }>;
  peers?: Array<{
    id: string;
    displayName: string;
    color: string;
    activeSlideId: string | null;
    selectionScopeId: string | null;
    selection: string[];
  }>;
  joinedName: string;
  error: string;
}

export interface AssetPage {
  items: Asset[];
  total: number;
  counts: Record<AssetCategory, number>;
}

export interface PresenterState {
  transition?: import("../core/slideTransitions").SlideTransitionPlayback;
  transitionSlides?: Record<
    string,
    import("../core/slideTransitions").ResolvedSlideTransition
  >;
  /** Slide entrances wait for audience rendering, without consuming their clock. */
  awaitingAudience?: boolean;
  prepareAudience?: boolean;
  presentationReady?: boolean;
  motion?: import("../core/motionPlayback").MotionPlaybackState;
  motionSlides?: Record<
    string,
    import("../core/motionPlayback").MotionStageTiming[]
  >;
  deckId: string;
  slideIds: string[];
  index: number | null;
  /** Last activated slide before the current activation. */
  previousSlideId?: string;
  previousSlideIndex?: number;
  black?: boolean;
  restartToken?: number;
  startedAt?: number;
  slideStartedAt?: number;
  stepStartedAt?: number;
  /** Logical slide-time offsets in ms at which Motion click stages were entered. */
  motionStageStartedOffsets?: number[];
  pausedAt?: number;
  pausedDuration?: number;
  resumeMotion?: boolean;
  contentRevision?: number;
  presenterDisplayId?: number;
  audienceDisplayId?: number;
  displayWarning?: string;
}

export interface MediaLibraryInfo {
  path: string;
  isDefault: boolean;
  defaultPath: string;
}

export interface SystemFontSource {
  id: string;
  weight: number;
  italic: boolean;
  data: Uint8Array;
}

export interface SystemFontFamily {
  family: string;
  weights: number[];
  sources?: SystemFontSource[];
}

export type FileCommand =
  | "save"
  | "save-as"
  | "package"
  | "export-pdf"
  | "export-pptx"
  | "export-html"
  | "prepare-close";
export type CloseResult = "closed" | "canceled";

export interface Platform {
  getMcpEnabled?(): Promise<boolean>;
  getMcpEditingEnabled?(): Promise<boolean>;
  setMcpEditingEnabled?(enabled: boolean): Promise<boolean>;
  agentHistory?(): Promise<{ documentId: string | null; canUndo: boolean; canRedo: boolean; summary: string | null }>;
  agentUndo?(request: { documentId: string; redo: boolean }): Promise<{ ok: boolean; error?: { message: string } }>;
  onAgentHistoryChanged?(callback: () => void): () => void;
  getMcpConnection?(): Promise<import("../core/agentRead").McpConnectionInfo>;
  setMcpEnabled?(enabled: boolean): Promise<boolean>;
  onMcpEnabledChanged?(callback: (enabled: boolean) => void): () => void;
  editorAgentContext?(request: import("../core/agentContext").EditorAgentContextRequest): Promise<import("../core/agentContext").EditorAgentContextReply>;
  agentContext?(): Promise<import("../core/agentContext").AgentContext>;
  agentPreview?(request: import("../core/agentPreview").AgentPreviewRequest): Promise<import("../core/agentPreview").AgentPreviewResult>;
  effectLibrary?(
    request: import("../core/libraryEffects").EffectLibraryRequest,
  ): Promise<import("../core/libraryEffects").EffectLibrary>;
  getLibraryLifecycle?(): Promise<
    import("../core/libraryLifecycle").LibraryLifecycleInfo
  >;
  chooseShowMeRoot?(): Promise<
    import("../core/libraryLifecycle").LibraryLifecycleInfo | null
  >;
  setLibraryLifecycleMode?(
    mode: import("../core/libraryLifecycle").LibraryLifecycleMode,
  ): Promise<import("../core/libraryLifecycle").LibraryLifecycleInfo>;
  scanLibrary?(): Promise<import("../core/libraryLifecycle").LibraryScanResult>;
  emptyOldLibraryTrash?(): Promise<
    import("../core/libraryLifecycle").LibraryScanResult
  >;
  reviewLibraryTrash?(): Promise<void>;
  presentationImageDiagnostics?(): Promise<{
    jobs: number;
    cacheHits: number;
    pending: number;
    rssBytes: number | null;
  }>;
  /** Null invalidates renderer cache choices after a global cache setting/clear. */
  onFontInventoryChanged?(callback: () => void): () => void;
  onMediaInventoryChanged?(callback: () => void): () => void;
  onImageReadiness?(
    cb: (
      status: import("../core/presentationImages").ImageReadiness | null,
    ) => void,
  ): () => void;
  imageReadiness?(
    documentId: string,
    retry?: boolean,
    slideId?: string,
  ): Promise<import("../core/presentationImages").ImageReadiness | null>;
  preparedImage?(
    documentId: string,
    slideId: string,
    elementId: string,
    profile?: import("../core/presentationImages").ImageOutputProfile,
  ): Promise<import("../core/presentationImages").PreparedImage | null>;
  /** Omitted output uses the shared audience profile, independent of editor zoom. */
  preparedSlideImages?(
    documentId: string,
    slideId: string,
    profile?: import("../core/presentationImages").ImageOutputProfile,
  ): Promise<import("../core/presentationImages").PreparedSlideImages>;
  /** Audience-only preparation handshake; completes the current whole-deck plan. */
  prepareAudience?(documentId: string): Promise<import("../core/presentationImages").ImageOutputProfile>;
  audienceImageProfile?(documentId: string): Promise<import("../core/presentationImages").ImageOutputProfile>;
  preparedAssetImage?(
    assetId: string,
    size: number,
  ): Promise<import("../core/presentationImages").PreparedImage | null>;
  getImageCacheFolder?(): Promise<MediaLibraryInfo>;
  chooseImageCacheFolder?(): Promise<MediaLibraryInfo | null>;
  resetImageCacheFolder?(): Promise<MediaLibraryInfo>;
  getImageCachingEnabled?(): Promise<boolean>;
  getHtmlFontEmbedding?(): Promise<import("../export/html/types").HtmlFontEmbedding>;
  setHtmlFontEmbedding?(mode: import("../export/html/types").HtmlFontEmbedding): Promise<void>;
  onHtmlExportProgress?(callback: (progress: import("../export/html/types").HtmlExportProgress | null) => void): () => void;
  getHtmlExportJpegQuality?(): Promise<number>;
  setHtmlExportJpegQuality?(quality: number): Promise<void>;
  getImageCacheFormat?(): Promise<import("../core/presentationImages").ImageCacheFormat>;
  setImageCacheFormat?(format: import("../core/presentationImages").ImageCacheFormat): Promise<void>;
  getDeleteImageCacheOnClose?(): Promise<boolean>;
  setDeleteImageCacheOnClose?(enabled: boolean): Promise<void>;
  setImageCachingEnabled?(enabled: boolean): Promise<void>;
  clearPresentationImages?(): Promise<void>;
  openDocumentFile?(
    file: string,
    mode?: "saved" | "recover",
  ): Promise<DocumentSummary>;
  recoveryCandidate?(file: string): Promise<{
    originalPath: string;
    recoveryPath: string;
    documentId: string;
    originalLastSavedAt: string | null;
    updatedAt: string;
  } | null>;
  inspectDocument?(
    file: string,
  ): Promise<{ summary: DocumentSummary; firstSlideId: string }>;
  listUntitledRecoveries?(): Promise<
    Array<{ documentId: string; name: string; updatedAt: string }>
  >;
  recoverUntitled?(documentId: string): Promise<DocumentSummary>;
  saveDocumentToFile?(
    documentId: string,
    destination?: string,
  ): Promise<DocumentSummary>;
  closeDocument?(documentId: string): Promise<void>;
  renderProjection?(
    documentId: string,
    slideId?: string,
  ): Promise<DocumentProjection>;
  documentProjection?(
    documentId: string,
    slideId?: string,
  ): Promise<DocumentProjection>;
  documentCommit?(
    documentId: string,
    transaction: DocumentTransaction,
  ): Promise<AcceptedTransaction>;
  documentAcquireLeases?(
    documentId: string,
    scopes: EditScope[],
  ): Promise<{ denied: false; grants: LeaseGrant[] } | LeaseDenied>;
  documentRenewLeases?(
    documentId: string,
    tokens: string[],
  ): Promise<LeaseGrant[]>;
  documentReleaseLeases?(documentId: string, tokens: string[]): Promise<void>;
  documentUndo?(
    documentId: string,
    tokens: string[],
  ): Promise<AcceptedTransaction>;
  documentRedo?(
    documentId: string,
    tokens: string[],
  ): Promise<AcceptedTransaction>;
  documentHistoryState?(
    documentId: string,
  ): Promise<{ canUndo: boolean; canRedo: boolean }>;
  onDocumentAccepted?(
    cb: (event: { documentId: string; accepted: AcceptedTransaction }) => void,
  ): () => void;
  onDocumentInvalidated?(
    cb: (event: { documentId: string }) => void,
  ): () => void;
  collaborationInterfaces?(): Promise<
    Array<{ name: string; address: string; recommended: boolean }>
  >;
  collaborationStart?(
    documentId: string,
    address?: string,
  ): Promise<DiscoveryRecord>;
  collaborationDiscover?(): Promise<DiscoveryRecord[]>;
  collaborationJoin?(
    record: DiscoveryRecord,
    displayName: string,
  ): Promise<void>;
  collaborationStatus?(): Promise<CollaborationStatus>;
  collaborationSelection?(
    slideId: string | null,
    selectionScopeId: string | null,
    elementIds: string[],
  ): Promise<boolean>;
  collaborationPreview?(preview: InteractionPreview): Promise<void>;
  collaborationClearPreview?(): Promise<void>;
  onCollaborationPreview?(
    cb: (message: {
      actorId: string;
      preview: InteractionPreview | null;
    }) => void,
  ): () => void;
  onCollaborationStatus?(cb: (status: CollaborationStatus) => void): () => void;
  onCollaborationDiscovery?(
    cb: (records: DiscoveryRecord[]) => void,
  ): () => void;
  collaborationApprove?(id: string): Promise<void>;
  collaborationReject?(id: string): Promise<void>;
  collaborationLeave?(): Promise<void>;
  collaborationStop?(): Promise<void>;
  isTest?: boolean;
  getMediaLibrary(): Promise<MediaLibraryInfo>;
  openMediaLibrary?(): Promise<void>;
  systemFonts?(): Promise<SystemFontFamily[]>;
  managedFonts?(documentId?: string): Promise<SystemFontFamily[]>;
  showContextMenu?(
    request: ContextMenuRequest,
  ): Promise<ContextMenuSelection | null>;
  closeContextMenu?(): Promise<void>;
  readTextClipboard?(): Promise<string>;
  writeTextClipboard?(value: string): Promise<void>;
  createDocument(name: string): Promise<DocumentSummary | null>;
  openDocument(): Promise<DocumentSummary | null>;
  openDocumentInNewWindow?(): Promise<void>;
  openRecentDocument(location: string): Promise<DocumentSummary>;
  listDocuments(): Promise<DocumentSummary[]>;
  currentDocument(): Promise<DocumentSummary | null>;
  onDocumentOpened(cb: (document: DocumentSummary) => void): () => void;
  onFileCommand?(cb: (command: FileCommand) => void): () => void;
  saveDocument?(documentId: string): Promise<DocumentSummary | null>;
  saveDocumentAs?(documentId: string): Promise<DocumentSummary | null>;
  packageDocument?(documentId: string): Promise<string | null>;
  exportPresentation?(
    documentId: string,
    format: "pdf" | "pptx" | "html",
  ): Promise<{ warnings: import("../export/shared").ExportWarning[] } | null>;
  exportReady?(error: string | null): Promise<void>;
  packageMediaState?(
    documentId: string,
  ): Promise<{ packaged: boolean; locked: boolean }>;
  saveMediaAs?(documentId: string, assetId: string): Promise<void>;
  requestClose?(documentId: string): Promise<CloseResult>;
  readSlideTransfer(files: File[]): Promise<unknown | null>;
  startSlideDrag(bundle: unknown): boolean;
  libraryBrowser?(
    request: import("../core/libraryBrowser").LibraryBrowserRequest,
  ): Promise<import("../core/libraryBrowser").LibraryBrowserResult>;
  effectThumbnail?(
    definition: import("../core/effects").EffectDefinition,
  ): Promise<string | null>;
  listAssets(query: string, offset: number, limit: number): Promise<AssetPage>;
  getAsset(id: string): Promise<Asset>;
  importAssets(files?: File[]): Promise<Asset[]>;
  importDroppedFiles(files: File[]): Promise<Asset[]>;
  assetUrl(id: string, preview?: boolean): Promise<string | null>;
  releaseUrl(url: string): void;
  retainUrl?(url: string): void;
  updateAsset(asset: Asset): Promise<void>;
  storePreview(id: string, data: Uint8Array): Promise<void>;
  capturePreview?(
    projection: DocumentProjection,
    width: number,
    height: number,
  ): Promise<string | null>;
  thumbnail(deckId: string, slideId: string): Promise<string | null>;
  storeThumbnail(deckId: string, slideId: string, data: string): Promise<void>;
  displays(): Promise<PresentationDisplay[]>;
  onDisplaysChanged?(cb: (displays: PresentationDisplay[]) => void): () => void;
  setPresentationDisplays(
    assignment: PresentationDisplayAssignment | null,
  ): Promise<void>;
  presentationCommand(command: PresentationCommand): Promise<void>;
  showPresenterConsole(): Promise<void>;
  present(state: PresenterState): Promise<void>;
  updatePresentation(state: PresenterState): Promise<void>;
  getPresentation(): Promise<PresenterState | null>;
  onPresentation(cb: (s: PresenterState | null) => void): () => void;
  navigate(index: number): Promise<void>;
  setBlack(value: boolean): Promise<void>;
  restartPresentationMedia(): Promise<void>;
  closePresentation(): Promise<void>;
  fullscreen(): Promise<void>;
}

declare global {
  interface Window {
    desktop?: Platform;
  }
}
