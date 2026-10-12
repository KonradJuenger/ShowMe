import { editablePage } from "../../src/core/templates";
import net, { type Socket } from "node:net";
import { listenLines, write } from "./transport";
import { randomUUID } from "node:crypto";
import os from "node:os";
import type { EditScope, LeaseGrant } from "../../src/core/documentAuthority";
import type {
  AcceptedTransaction,
  DocumentTransaction,
} from "../../src/core/documentTransactions";
import {
  COLLAB_DOCUMENT_VERSION,
  COLLAB_PROTOCOL_VERSION,
  compatibleVersions,
  discoverySchema,
  interactionPreviewSchema,
  serverMessageSchema,
  type CollaborationPeer,
  type DiscoveryRecord,
  type InteractionPreview,
} from "../../src/core/collaboration/protocol";
import { ClientReplica } from "../../src/core/collaboration/clientReplica";
import type { DocumentRuntime } from "../../src/core/documentRuntime";
import { DiscoveryBrowser } from "./discovery";
import { isPrivateAddress, privateInterfaces } from "./security";
import { CollaborationHost } from "./host";

const versions = {
  appVersion: "0.1.0",
  protocolVersion: COLLAB_PROTOCOL_VERSION,
  documentVersion: COLLAB_DOCUMENT_VERSION,
};
export type { Peer } from "./host";
export type ClientStatus =
  | "idle"
  | "connecting"
  | "waiting"
  | "connected"
  | "rejected"
  | "incompatible"
  | "lost";

interface PendingTransaction {
  transaction: DocumentTransaction;
  resolve: (accepted: AcceptedTransaction) => void;
  reject: (error: Error) => void;
}

interface PendingLease {
  resolve: (
    result:
      | { denied: false; grants: LeaseGrant[] }
      | { denied: true; ownerActorId?: string },
  ) => void;
  reject: (error: Error) => void;
}

interface PendingHistory {
  resolve: (value: {
    accepted?: AcceptedTransaction;
    canUndo: boolean;
    canRedo: boolean;
  }) => void;
  reject: (error: Error) => void;
}

export class CollaborationService {
  private readonly host: CollaborationHost;
  private browser: DiscoveryBrowser | null = null;
  private get connected() {
    return this.host.connectedPeers;
  }

  private client: Socket | null = null;
  private clientStatus: ClientStatus = "idle";
  private replica = new ClientReplica();
  private actorId: string | null = null;
  private resumeToken: string | null = null;
  private clientLeases: LeaseGrant[] = [];
  private clientPeers: CollaborationPeer[] = [];
  private clientPresence: {
    activeSlideId: string | null;
    selectionScopeId: string | null;
    selection: string[];
  } | null = null;
  private pendingTransactions = new Map<string, PendingTransaction>();
  private pendingLeases = new Map<string, PendingLease>();
  private pendingHistory = new Map<string, PendingHistory>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private lastJoin: {
    record: DiscoveryRecord;
    displayName: string;
    deviceName: string;
  } | null = null;

  private onStatusChanged: (() => void) | null = null;
  private onDiscoveryChanged: ((records: DiscoveryRecord[]) => void) | null =
    null;
  private onPreview:
    ((actorId: string, preview: InteractionPreview | null) => void) | null =
    null;
  private onGuestAccepted: ((accepted: AcceptedTransaction) => void) | null =
    null;
  private onGuestInvalidated: ((documentId: string) => void) | null = null;
  private onGuestUnavailable: ((documentId: string) => void) | null = null;
  private joinedName = "";
  private error = "";

  constructor(
    runtimeFor: (documentId: string) => DocumentRuntime,
    private readonly appVersion = versions.appVersion,
  ) {
    this.host = new CollaborationHost(
      runtimeFor,
      this.appVersion,
      () => this.emit(),
      (actorId, preview) => this.onPreview?.(actorId, preview),
    );
  }

  subscribe(
    onStatusChanged: () => void,
    onDiscoveryChanged: (records: DiscoveryRecord[]) => void,
    onPreview?: (actorId: string, preview: InteractionPreview | null) => void,
    onGuestAccepted?: (accepted: AcceptedTransaction) => void,
    onGuestInvalidated?: (documentId: string) => void,
    onGuestUnavailable?: (documentId: string) => void,
  ) {
    this.onStatusChanged = onStatusChanged;
    this.onDiscoveryChanged = onDiscoveryChanged;
    this.onPreview = onPreview ?? null;
    this.onGuestAccepted = onGuestAccepted ?? null;
    this.onGuestInvalidated = onGuestInvalidated ?? null;
    this.onGuestUnavailable = onGuestUnavailable ?? null;
  }

  private emit() {
    this.onStatusChanged?.();
  }

  async start(documentId: string, interfaceAddress?: string) {
    if (this.client || this.host.isActive())
      throw new Error("A collaboration session is already active");
    return this.host.start(documentId, interfaceAddress);
  }

  approve(id: string) {
    return this.host.approve(id);
  }

  reject(id: string) {
    return this.host.reject(id);
  }

  isHosting(documentId: string) {
    return this.host.isHosting(documentId);
  }

  isGuest(documentId: string) {
    return (
      this.clientStatus !== "idle" &&
      this.replica.document?.documentId === documentId
    );
  }

  clientDocument() {
    return this.replica.document;
  }

  projection(documentId: string, slideId?: string) {
    const document = this.replica.document;
    if (!document || document.documentId !== documentId)
      throw new Error("Guest replica is unavailable");
    const id = slideId ?? document.deck.slideIds[0];
    const slide = editablePage(document, id);
    if (!slide) throw new Error(`Unknown slide: ${id}`);
    return {
      documentId,
      epoch: this.replica.epoch,
      revision: this.replica.revision,
      savedRevision: this.replica.revision,
      deck: structuredClone(document.deck),
      slide: structuredClone(slide),
      templates: structuredClone(document.templates),
    };
  }

  commitClient(documentId: string, transaction: DocumentTransaction) {
    if (
      !this.client ||
      this.clientStatus !== "connected" ||
      this.replica.document?.documentId !== documentId
    )
      return Promise.reject(new Error("Client is disconnected"));
    const existing = this.pendingTransactions.get(transaction.transactionId);
    if (existing)
      return new Promise<AcceptedTransaction>((resolve, reject) => {
        const priorResolve = existing.resolve;
        const priorReject = existing.reject;
        existing.resolve = (accepted) => {
          priorResolve(accepted);
          resolve(accepted);
        };
        existing.reject = (error) => {
          priorReject(error);
          reject(error);
        };
      });
    return new Promise<AcceptedTransaction>((resolve, reject) => {
      this.pendingTransactions.set(transaction.transactionId, {
        transaction,
        resolve,
        reject,
      });
      try {
        write(this.client!, { type: "transaction.submit", transaction });
      } catch (error) {
        this.pendingTransactions.delete(transaction.transactionId);
        reject(error);
      }
    });
  }

  private leaseRequest(
    message:
      | { type: "lease.acquire"; scopes: EditScope[] }
      | { type: "lease.renew"; tokens: string[] },
  ) {
    if (!this.client || this.clientStatus !== "connected")
      return Promise.reject(new Error("Client is disconnected"));
    const requestId = randomUUID();
    return new Promise<
      | { denied: false; grants: LeaseGrant[] }
      | { denied: true; ownerActorId?: string }
    >((resolve, reject) => {
      this.pendingLeases.set(requestId, { resolve, reject });
      write(this.client!, { ...message, requestId });
    });
  }

  acquireClient(documentId: string, scopes: EditScope[]) {
    if (this.replica.document?.documentId !== documentId)
      return Promise.reject(new Error("Guest document mismatch"));
    return this.leaseRequest({ type: "lease.acquire", scopes });
  }

  async renewClient(documentId: string, tokens: string[]) {
    if (this.replica.document?.documentId !== documentId)
      throw new Error("Guest document mismatch");
    const result = await this.leaseRequest({ type: "lease.renew", tokens });
    if (result.denied) throw new Error("Lease expired");
    return result.grants;
  }

  releaseClient(documentId: string, tokens?: string[]) {
    if (
      !this.client ||
      this.clientStatus !== "connected" ||
      this.replica.document?.documentId !== documentId
    )
      return;
    try {
      write(this.client, { type: "lease.release", tokens: tokens ?? [] });
    } catch {
      this.client.destroy();
    }
  }

  private historyRequest(action?: "undo" | "redo") {
    if (!this.client || this.clientStatus !== "connected")
      return Promise.reject(new Error("Client is disconnected"));
    const requestId = randomUUID();
    return new Promise<{
      accepted?: AcceptedTransaction;
      canUndo: boolean;
      canRedo: boolean;
    }>((resolve, reject) => {
      this.pendingHistory.set(requestId, { resolve, reject });
      write(
        this.client!,
        action
          ? { type: "history.action", requestId, action }
          : { type: "history.state", requestId },
      );
    });
  }

  async undoClient(documentId: string) {
    if (this.replica.document?.documentId !== documentId)
      throw new Error("Guest document mismatch");
    const result = await this.historyRequest("undo");
    if (!result.accepted) throw new Error("Undo did not produce a transaction");
    return result.accepted;
  }

  async redoClient(documentId: string) {
    if (this.replica.document?.documentId !== documentId)
      throw new Error("Guest document mismatch");
    const result = await this.historyRequest("redo");
    if (!result.accepted) throw new Error("Redo did not produce a transaction");
    return result.accepted;
  }

  async historyStateClient(documentId: string) {
    if (this.replica.document?.documentId !== documentId)
      return { canUndo: false, canRedo: false };
    return this.historyRequest();
  }

  preview(raw: InteractionPreview) {
    const preview = interactionPreviewSchema.parse(raw);
    if (this.host.isActive()) this.host.preview(preview);
    else if (this.client && this.clientStatus === "connected") {
      try {
        write(this.client, { type: "interaction.preview", preview });
      } catch {
        this.client.destroy();
      }
    }
  }

  clearPreview() {
    if (this.host.isActive()) this.host.clearPreview();
    else if (this.client && this.clientStatus === "connected") {
      try {
        write(this.client, { type: "interaction.preview.clear" });
      } catch {
        this.client.destroy();
      }
    }
  }

  async select(
    activeSlideId: string | null,
    selectionScopeId: string | null,
    elementIds: string[],
  ) {
    if (this.host.isActive())
      return this.host.select(activeSlideId, selectionScopeId, elementIds);
    this.clientPresence = {
      activeSlideId,
      selectionScopeId,
      selection: [...elementIds],
    };
    if (this.client && this.clientStatus === "connected") {
      try {
        write(this.client, {
          type: "presence",
          ...this.clientPresence,
        });
      } catch {
        this.client.destroy();
      }
    }
    return true;
  }

  async discover() {
    if (!this.browser) {
      const browser = new DiscoveryBrowser((records) =>
        this.onDiscoveryChanged?.(
          records.filter(
            (record) => record.sessionId !== this.host.hostedRecord?.sessionId,
          ),
        ),
      );
      await browser.start(privateInterfaces());
      this.browser = browser;
    }
    return this.browser
      .list()
      .filter(
        (record) => record.sessionId !== this.host.hostedRecord?.sessionId,
      );
  }

  async join(
    record: DiscoveryRecord,
    displayName: string,
    deviceName = os.hostname(),
  ) {
    if (this.client || this.host.isActive())
      throw new Error("A collaboration session is already active");
    if (!isPrivateAddress(record.address))
      throw new Error("Only private LAN addresses are allowed");
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.lastJoin = { record, displayName, deviceName };

    const target = { ...record, address: record.address };
    const { address: _address, ...parsed } = target;
    discoverySchema.parse(parsed);
    const socket = net.createConnection({
      host: target.address,
      port: target.port,
    });
    this.client = socket;
    this.clientStatus = "connecting";
    this.joinedName = target.presentationName;
    this.error = "";
    this.emit();

    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    }).catch((error) => {
      this.client = null;
      this.clientStatus = "lost";
      this.emit();
      this.scheduleReconnect();
      throw error;
    });

    write(socket, {
      type: "hello",
      sessionId: target.sessionId,
      versions: { ...versions, appVersion: this.appVersion },
    });

    const becomeConnected = () => {
      this.clientStatus = "connected";
      this.reconnectDelay = 1000;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (this.client === socket && this.clientStatus === "connected")
          try {
            write(socket, { type: "heartbeat" });
          } catch {
            socket.destroy();
          }
      }, 5000);
      for (const pending of this.pendingTransactions.values())
        write(socket, {
          type: "transaction.submit",
          transaction: pending.transaction,
        });
      if (this.clientPresence)
        write(socket, { type: "presence", ...this.clientPresence });
      this.emit();
    };

    const acceptTransaction = (accepted: AcceptedTransaction) => {
      try {
        this.replica.apply(accepted);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("Collaboration stream gap")
        ) {
          write(socket, {
            type: "transactions.missing",
            fromRevision: this.replica.revision,
          });
          return;
        }
        throw error;
      }
      this.pendingTransactions
        .get(accepted.transactionId)
        ?.resolve(accepted);
      this.pendingTransactions.delete(accepted.transactionId);
      this.onGuestAccepted?.(accepted);
      this.emit();
    };

    listenLines(
      socket,
      (input) => {
        const parsedMessage = serverMessageSchema.safeParse(input);
        if (!parsedMessage.success) {
          socket.destroy();
          return;
        }
        const message = parsedMessage.data;
        if (message.type === "compatible") {
          if (
            !compatibleVersions(
              { ...versions, appVersion: this.appVersion },
              message.versions,
            )
          ) {
            this.clientStatus = "incompatible";
            socket.end();
            this.emit();
            return;
          }
          write(socket, {
            type: "join",
            displayName,
            deviceName,
            ...(this.resumeToken
              ? {
                  resumeToken: this.resumeToken,
                  epoch: this.replica.epoch || undefined,
                  lastRevision: this.replica.document
                    ? this.replica.revision
                    : undefined,
                }
              : {}),
          });
        } else if (message.type === "incompatible") {
          this.clientStatus = "incompatible";
          this.error = message.reason;
          this.lastJoin = null;
          socket.end();
        } else if (message.type === "waiting") {
          this.clientStatus = "waiting";
        } else if (message.type === "rejected") {
          this.clientStatus = "rejected";
          this.lastJoin = null;
          socket.end();
        } else if (message.type === "snapshot") {
          this.replica.install(
            message.document,
            message.epoch,
            message.revision,
          );
          this.onGuestInvalidated?.(message.document.documentId);
          this.actorId = message.actorId;
          this.resumeToken = message.resumeToken;
          becomeConnected();
        } else if (message.type === "resume") {
          if (
            !this.replica.document ||
            this.replica.epoch !== message.epoch
          ) {
            this.clientStatus = "lost";
            socket.destroy();
            return;
          }
          this.actorId = message.actorId;
          this.resumeToken = message.resumeToken;
          try {
            for (const accepted of message.transactions)
              acceptTransaction(accepted);
          } catch {
            write(socket, {
              type: "transactions.missing",
              fromRevision: this.replica.revision,
            });
            return;
          }
          if (this.replica.revision !== message.revision) {
            write(socket, {
              type: "transactions.missing",
              fromRevision: this.replica.revision,
            });
            return;
          }
          becomeConnected();
        } else if (message.type === "transaction.accepted") {
          acceptTransaction(message.accepted);
        } else if (message.type === "transaction.rejected") {
          const pending = this.pendingTransactions.get(message.transactionId);
          pending?.reject(new Error(message.reason));
          this.pendingTransactions.delete(message.transactionId);
          this.error = message.reason;
        } else if (message.type === "lease.result") {
          const pending = this.pendingLeases.get(message.requestId);
          if (pending) {
            pending.resolve(
              message.denied
                ? {
                    denied: true,
                    ...(message.ownerActorId
                      ? { ownerActorId: message.ownerActorId }
                      : {}),
                  }
                : { denied: false, grants: message.grants },
            );
            this.pendingLeases.delete(message.requestId);
          }
        } else if (message.type === "transactions.replay") {
          if (message.epoch !== this.replica.epoch) {
            this.clientStatus = "lost";
            socket.destroy();
            return;
          }
          for (const accepted of message.transactions)
            acceptTransaction(accepted);
          if (this.replica.revision !== message.revision)
            write(socket, {
              type: "transactions.missing",
              fromRevision: this.replica.revision,
            });
        } else if (message.type === "history.result") {
          const pending = this.pendingHistory.get(message.requestId);
          if (pending) {
            if (message.ok)
              pending.resolve({
                canUndo: message.canUndo,
                canRedo: message.canRedo,
                ...(message.accepted
                  ? { accepted: message.accepted }
                  : {}),
              });
            else
              pending.reject(
                new Error(message.reason ?? "History action failed"),
              );
            this.pendingHistory.delete(message.requestId);
          }
        } else if (message.type === "leases.changed") {
          this.clientLeases = message.leases;
        } else if (message.type === "peers.changed") {
          const nextIds = new Set(message.peers.map((peer) => peer.id));
          for (const peer of this.clientPeers)
            if (!nextIds.has(peer.id)) this.onPreview?.(peer.id, null);
          this.clientPeers = message.peers;
        } else if (message.type === "interaction.preview") {
          this.onPreview?.(message.actorId, message.preview);
        } else if (message.type === "interaction.preview.clear") {
          this.onPreview?.(message.actorId, null);
        } else if (message.type === "stopped") {
          // A deliberate host stop is terminal, unlike an incidental socket
          // loss. Clear the guest replica/identity immediately so stale guest
          // file-ownership restrictions and projection state cannot survive.
          this.lastJoin = null;
          this.leave();
          return;
        }
        this.emit();
      },
      (error) => {
        this.error = error.message;
        this.emit();
        socket.destroy();
      },
    );

    socket.on("close", () => {
      for (const pending of this.pendingLeases.values())
        pending.reject(new Error("Collaboration connection lost"));
      this.pendingLeases.clear();
      for (const pending of this.pendingHistory.values())
        pending.reject(new Error("Collaboration connection lost"));
      this.pendingHistory.clear();
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (
        this.clientStatus === "connected" ||
        this.clientStatus === "waiting" ||
        this.clientStatus === "connecting"
      )
        this.clientStatus = "lost";
      this.client = null;
      this.clientLeases = [];
      for (const peer of this.clientPeers) this.onPreview?.(peer.id, null);
      this.clientPeers = [];
      this.emit();
      if (this.clientStatus === "lost") this.scheduleReconnect();
    });
    socket.on("error", (error) => {
      this.error = error.message;
      this.emit();
    });
  }

  private scheduleReconnect() {
    if (
      !this.lastJoin ||
      this.reconnectTimer ||
      this.client ||
      this.host.isActive()
    )
      return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(8000, delay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.lastJoin && !this.client && !this.host.isActive())
        void this.join(
          this.lastJoin.record,
          this.lastJoin.displayName,
          this.lastJoin.deviceName,
        ).catch(() => {});
    }, delay);
  }

  status() {
    const host = this.host.status();
    const leases = this.host.isActive() ? host.leases : this.clientLeases;
    return {
      hosted: host.hosted,
      pending: host.pending,
      connected: [...this.connected.values()].map((entry) => entry.peer),
      actorId: this.actorId,
      sessionRevision: this.host.isActive()
        ? host.sessionRevision
        : this.replica.document
          ? this.replica.revision
          : null,
      leases,
      locks: leases.flatMap((lease) =>
        lease.scope.kind === "element"
          ? [
              {
                slideId: lease.scope.slideId,
                elementId: lease.scope.elementId,
                actorId: lease.actorId,
                expiresAt: lease.expiresAt,
              },
            ]
          : [],
      ),
      peers: this.host.isActive() ? host.peers : this.clientPeers,
      clientStatus: this.clientStatus,
      clientDocumentId: this.replica.document?.documentId ?? null,
      joinedName: this.joinedName,
      error: this.error,
    };
  }

  leave() {
    const unavailableDocumentId = this.replica.document?.documentId ?? null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.lastJoin = null;
    if (this.client && this.clientStatus === "connected") {
      const tokens = this.clientLeases
        .filter((lease) => lease.actorId === this.actorId)
        .map((lease) => lease.token);
      try {
        if (tokens.length)
          write(this.client, { type: "lease.release", tokens });
        write(this.client, { type: "interaction.preview.clear" });
      } catch {
        // The socket is being torn down below.
      }
    }
    for (const pending of this.pendingTransactions.values())
      pending.reject(new Error("Left collaboration session"));
    this.pendingTransactions.clear();
    for (const pending of this.pendingLeases.values())
      pending.reject(new Error("Left collaboration session"));
    this.pendingLeases.clear();
    for (const pending of this.pendingHistory.values())
      pending.reject(new Error("Left collaboration session"));
    this.pendingHistory.clear();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.client?.destroy();
    this.client = null;
    this.clientStatus = "idle";
    this.actorId = null;
    this.resumeToken = null;
    this.replica = new ClientReplica();
    this.clientLeases = [];
    for (const peer of this.clientPeers) this.onPreview?.(peer.id, null);
    this.clientPeers = [];
    this.clientPresence = null;
    this.joinedName = "";
    this.error = "";
    if (unavailableDocumentId)
      this.onGuestUnavailable?.(unavailableDocumentId);
    this.emit();
  }

  stop() {
    this.host.stop();
  }

  close() {
    this.leave();
    this.stop();
    this.browser?.stop();
    this.browser = null;
  }
}
