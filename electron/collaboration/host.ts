import net, { type Socket } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import {
  COLLAB_DOCUMENT_VERSION,
  COLLAB_PROTOCOL_VERSION,
  clientMessageSchema,
  compatibleVersions,
  type CollaborationPeer,
  type DiscoveryRecord,
  type InteractionPreview,
} from "../../src/core/collaboration/protocol";
import { collaboratorColor } from "../../src/core/collaboration/color";
import type { DocumentRuntime } from "../../src/core/documentRuntime";
import { advertise } from "./discovery";
import {
  isPrivateAddress,
  privateInterfaces,
  selectedLanAddress,
} from "./security";
import { listenLines, write, end } from "./transport";

const versions = {
  appVersion: "0.1.0",
  protocolVersion: COLLAB_PROTOCOL_VERSION,
  documentVersion: COLLAB_DOCUMENT_VERSION,
};
const incompatible =
  "This collaboration session uses an incompatible ShowMe version.";
const RESUME_TTL = 10 * 60_000;

export interface Peer {
  id: string;
  displayName: string;
  deviceName: string;
  address: string;
  color: string;
}

interface ConnectedPeer {
  peer: Peer;
  socket: Socket;
  resumeToken: string;
}

interface ResumeRecord {
  actorId: string;
  peer: Peer;
  resumeToken: string;
  expiresAt: number;
}

export class CollaborationHost {
  private server: net.Server | null = null;
  private stopAdvertise: (() => void) | null = null;
  private hosted: DiscoveryRecord | null = null;
  private localDocumentId: string | null = null;
  private pending = new Map<
    string,
    { peer: Peer; socket: Socket; markApproved: () => void }
  >();
  private connected = new Map<string, ConnectedPeer>();
  private resumeRecords = new Map<string, ResumeRecord>();
  private peers = new Map<string, CollaborationPeer>();
  private hostUnsubscribe: (() => void) | null = null;

  constructor(
    private readonly runtimeFor: (documentId: string) => DocumentRuntime,
    private readonly appVersion: string,
    private readonly onChanged: () => void,
    private readonly onPreview: (
      actorId: string,
      preview: InteractionPreview | null,
    ) => void,
  ) {}

  private emit() {
    this.onChanged();
  }

  private runtime() {
    if (!this.localDocumentId) throw new Error("Host session is unavailable");
    return this.runtimeFor(this.localDocumentId);
  }

  private pruneResumeRecords() {
    const now = Date.now();
    for (const [token, record] of this.resumeRecords) {
      if (this.connected.has(record.actorId)) {
        record.expiresAt = now + RESUME_TTL;
        continue;
      }
      if (record.expiresAt <= now) this.resumeRecords.delete(token);
    }
  }

  private hostSnapshot() {
    if (!this.localDocumentId) throw new Error("Host session is unavailable");
    return this.runtime().fullSnapshot(this.localDocumentId);
  }

  private serverLeases() {
    if (!this.localDocumentId) return [];
    return this.runtime()
      .leaseState(this.localDocumentId)
      .map((lease) => ({
        ...lease,
        actorId: lease.actorId === "local" ? "host" : lease.actorId,
      }));
  }

  private hostPeers() {
    return [...this.peers.values()];
  }

  private resolveDisplayName(requested: string, excludeActorId?: string) {
    const base = requested.trim() || "Guest";
    const reserved = [
      ...[...this.peers.values()]
        .filter((peer) => peer.id !== excludeActorId)
        .map((peer) => peer.displayName),
      ...[...this.pending.values()]
        .filter((entry) => entry.peer.id !== excludeActorId)
        .map((entry) => entry.peer.displayName),
      ...[...this.resumeRecords.values()]
        .filter((entry) => entry.actorId !== excludeActorId)
        .map((entry) => entry.peer.displayName),
    ];
    const used = new Set(
      reserved.map((name) => name.toLocaleLowerCase("en-US")),
    );
    if (!used.has(base.toLocaleLowerCase("en-US"))) return base;
    let suffix = 2;
    while (used.has(`${base} ${suffix}`.toLocaleLowerCase("en-US")))
      suffix += 1;
    return `${base} ${suffix}`;
  }

  private writeBestEffort(
    socket: Socket,
    message: Parameters<typeof write>[1],
  ) {
    try {
      write(socket, message);
    } catch (error) {
      console.error("Collaboration broadcast failed", error);
      socket.destroy();
    }
  }

  private broadcastPeers() {
    const peers = this.hostPeers();
    for (const entry of this.connected.values())
      this.writeBestEffort(entry.socket, { type: "peers.changed", peers });
  }

  private broadcastLeases() {
    const leases = this.serverLeases();
    for (const entry of this.connected.values())
      this.writeBestEffort(entry.socket, { type: "leases.changed", leases });
  }

  private clearActorPreview(actorId: string) {
    for (const [peerActorId, entry] of this.connected)
      if (peerActorId !== actorId)
        this.writeBestEffort(entry.socket, {
          type: "interaction.preview.clear",
          actorId,
        });
    this.onPreview(actorId, null);
  }

  private sendSnapshot(
    socket: Socket,
    actorId: string,
    resumeToken: string,
  ) {
    const snapshot = this.hostSnapshot();
    const { recovery: _recovery, ...document } = snapshot.document;
    write(socket, {
      type: "snapshot",
      document,
      actorId,
      resumeToken,
      epoch: snapshot.epoch,
      revision: snapshot.revision,
    });
  }

  async start(documentId: string, interfaceAddress?: string) {
    if (this.server)
      throw new Error("A collaboration session is already active");
    const runtime = this.runtimeFor(documentId);
    const snapshot = runtime.fullSnapshot(documentId);
    const address = interfaceAddress ?? selectedLanAddress();
    if (interfaceAddress && !privateInterfaces().includes(interfaceAddress))
      throw new Error("The selected LAN interface is unavailable");
    const server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, address, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const port = (server.address() as net.AddressInfo).port;
    const record: DiscoveryRecord = {
      sessionId: randomBytes(32).toString("hex"),
      presentationName: snapshot.document.deck.name,
      hostName: os.hostname().slice(0, 200),
      port,
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      address,
    };
    try {
      const { address: _address, ...advertisement } = record;
      this.stopAdvertise = await advertise(advertisement, address);
    } catch (error) {
      server.close();
      throw error;
    }

    this.server = server;
    this.hosted = record;
    this.localDocumentId = documentId;
    const hostName = "Host";
    this.peers.set("host", {
      id: "host",
      displayName: hostName,
      color: collaboratorColor(hostName),
      activeSlideId: null,
      selectionScopeId: null,
      selection: [],
    });
    this.hostUnsubscribe = runtime.subscribeAccepted(documentId, (accepted) => {
      for (const [peerActorId, entry] of this.connected)
        if (peerActorId !== accepted.actorId)
          this.writeBestEffort(entry.socket, {
            type: "transaction.accepted",
            accepted,
          });
      this.clearActorPreview(
        accepted.actorId === "local" ? "host" : accepted.actorId,
      );
      this.broadcastLeases();
      this.emit();
    });
    this.emit();
    return record;
  }

  private accept(socket: Socket) {
    socket.on("error", () => {});
    if (this.pending.size >= 32 || this.connected.size >= 16) {
      socket.destroy();
      return;
    }
    const address = socket.remoteAddress ?? "";
    if (!isPrivateAddress(address)) {
      socket.destroy();
      return;
    }
    socket.setTimeout(5 * 60_000, () => socket.destroy());

    let stage: "hello" | "join" | "pending" | "approved" = "hello";
    let actorId: string = randomUUID();
    let windowStart = Date.now();
    let messageCount = 0;

    const cleanup = () => {
      this.pending.delete(actorId);
      const entry = this.connected.get(actorId);
      if (entry?.socket === socket) {
        this.connected.delete(actorId);
        if (this.localDocumentId)
          this.runtime().releaseForActor(this.localDocumentId, actorId);
        const presence = this.peers.get(actorId);
        if (presence) {
          const record = this.resumeRecords.get(entry.resumeToken);
          if (record) record.expiresAt = Date.now() + RESUME_TTL;
          this.peers.delete(actorId);
        }
        this.clearActorPreview(actorId);
        this.broadcastPeers();
        this.broadcastLeases();
      }
      this.emit();
    };
    socket.on("close", cleanup);

    listenLines(
      socket,
      (input) => {
        const now = Date.now();
        if (now - windowStart >= 1000) {
          windowStart = now;
          messageCount = 0;
        }
        if (++messageCount > 100) {
          socket.destroy();
          return;
        }
        const parsed = clientMessageSchema.safeParse(input);
        if (
          !parsed.success ||
          (stage === "hello" && parsed.data.type !== "hello") ||
          (stage === "join" && parsed.data.type !== "join") ||
          stage === "pending" ||
          (stage === "approved" &&
            (parsed.data.type === "hello" || parsed.data.type === "join"))
        ) {
          socket.destroy();
          return;
        }

        if (parsed.data.type === "hello") {
          if (parsed.data.sessionId !== this.hosted?.sessionId) {
            socket.destroy();
            return;
          }
          if (
            !compatibleVersions(
              { ...versions, appVersion: this.appVersion },
              parsed.data.versions,
            )
          ) {
            write(socket, { type: "incompatible", reason: incompatible });
            end(socket);
            return;
          }
          write(socket, {
            type: "compatible",
            versions: { ...versions, appVersion: this.appVersion },
          });
          stage = "join";
          return;
        }

        if (parsed.data.type === "join") {
          this.pruneResumeRecords();
          const resume = parsed.data.resumeToken
            ? this.resumeRecords.get(parsed.data.resumeToken)
            : undefined;
          if (resume) {
            actorId = resume.actorId;
            const peer: Peer = {
              ...resume.peer,
              deviceName: parsed.data.deviceName,
              address,
            };
            const current = this.connected.get(actorId);
            if (current && current.socket !== socket) current.socket.destroy();
            resume.peer = peer;
            resume.expiresAt = Date.now() + RESUME_TTL;
            this.connected.set(actorId, {
              peer,
              socket,
              resumeToken: resume.resumeToken,
            });
            this.peers.set(actorId, {
              id: actorId,
              displayName: peer.displayName,
              color: peer.color,
              activeSlideId: null,
              selectionScopeId: null,
              selection: [],
            });
            socket.setTimeout(0);
            stage = "approved";
            const snapshot = this.runtime().metadata(this.localDocumentId!);
            let canReplay = null;
            if (
              parsed.data.epoch === snapshot.epoch &&
              parsed.data.lastRevision !== undefined
            ) {
              try {
                canReplay = this.runtime().acceptedAfter(
                  snapshot.documentId,
                  parsed.data.lastRevision,
                );
              } catch {
                canReplay = null;
              }
            }
            if (canReplay !== null) {
              try {
                write(socket, {
                  type: "resume",
                  actorId,
                  resumeToken: resume.resumeToken,
                  epoch: snapshot.epoch,
                  revision: snapshot.revision,
                  transactions: canReplay,
                });
              } catch {
                this.sendSnapshot(socket, actorId, resume.resumeToken);
              }
            } else {
              this.sendSnapshot(socket, actorId, resume.resumeToken);
            }
            this.broadcastPeers();
            this.broadcastLeases();
            this.emit();
            return;
          }

          const displayName = this.resolveDisplayName(parsed.data.displayName);
          const peer: Peer = {
            id: actorId,
            displayName,
            deviceName: parsed.data.deviceName,
            address,
            color: collaboratorColor(displayName),
          };
          this.pending.set(actorId, {
            peer,
            socket,
            markApproved: () => {
              stage = "approved";
            },
          });
          stage = "pending";
          socket.setTimeout(30_000, () => socket.destroy());
          write(socket, { type: "waiting" });
          this.emit();
          return;
        }

        if (stage !== "approved" || !this.localDocumentId) return;
        const message = parsed.data;

        void (async () => {
          const runtime = this.runtime();
          const documentId = this.localDocumentId!;
          if (message.type === "transaction.submit") {
            let accepted;
            try {
              accepted = await runtime.commitForActor(
                documentId,
                actorId,
                message.transaction,
              );
            } catch (error) {
              this.writeBestEffort(socket, {
                type: "transaction.rejected",
                transactionId: message.transaction.transactionId,
                reason: String(error).slice(0, 500),
              });
              return;
            }
            // A reply failure after durable acceptance is only a transport
            // failure. The retry/resume path will recover the accepted revision.
            this.writeBestEffort(socket, {
              type: "transaction.accepted",
              accepted,
            });
          } else if (message.type === "lease.acquire") {
            const result = runtime.acquireForActor(
              documentId,
              actorId,
              message.scopes,
            );
            this.writeBestEffort(socket, {
              type: "lease.result",
              requestId: message.requestId,
              denied: result.denied,
              grants: result.denied ? [] : result.grants,
              ...(result.denied
                ? { ownerActorId: result.ownerActorId }
                : {}),
            });
            this.broadcastLeases();
          } else if (message.type === "lease.renew") {
            try {
              const grants = runtime.renewForActor(
                documentId,
                actorId,
                message.tokens,
              );
              this.writeBestEffort(socket, {
                type: "lease.result",
                requestId: message.requestId,
                denied: false,
                grants,
              });
              this.broadcastLeases();
            } catch {
              this.clearActorPreview(actorId);
              this.writeBestEffort(socket, {
                type: "lease.result",
                requestId: message.requestId,
                denied: true,
                grants: [],
              });
            }
          } else if (message.type === "lease.release") {
            runtime.releaseForActor(documentId, actorId, message.tokens);
            this.clearActorPreview(actorId);
            this.broadcastLeases();
          } else if (message.type === "transactions.missing") {
            const replay = runtime.acceptedAfter(
              documentId,
              message.fromRevision,
            );
            if (replay === null) {
              const entry = this.connected.get(actorId);
              if (entry)
                this.sendSnapshot(socket, actorId, entry.resumeToken);
            } else {
              const snapshot = runtime.metadata(documentId);
              try {
                write(socket, {
                  type: "transactions.replay",
                  epoch: snapshot.epoch,
                  fromRevision: message.fromRevision,
                  revision: snapshot.revision,
                  transactions: replay,
                });
              } catch {
                const entry = this.connected.get(actorId);
                if (entry)
                  this.sendSnapshot(socket, actorId, entry.resumeToken);
              }
            }
          } else if (message.type === "history.action") {
            try {
              const accepted =
                message.action === "undo"
                  ? await runtime.undoForActor(documentId, actorId)
                  : await runtime.redoForActor(documentId, actorId);
              const state = runtime.historyStateForActor(documentId, actorId);
              this.writeBestEffort(socket, {
                type: "history.result",
                requestId: message.requestId,
                ok: true,
                ...state,
                accepted,
              });
            } catch (error) {
              const state = runtime.historyStateForActor(documentId, actorId);
              this.writeBestEffort(socket, {
                type: "history.result",
                requestId: message.requestId,
                ok: false,
                ...state,
                reason: String(error).slice(0, 500),
              });
            }
          } else if (message.type === "history.state") {
            this.writeBestEffort(socket, {
              type: "history.result",
              requestId: message.requestId,
              ok: true,
              ...runtime.historyStateForActor(documentId, actorId),
            });
          } else if (message.type === "presence") {
            const peer = this.peers.get(actorId);
            if (peer) {
              this.peers.set(actorId, {
                ...peer,
                activeSlideId: message.activeSlideId,
                selectionScopeId: message.selectionScopeId,
                selection: message.selection,
              });
              this.broadcastPeers();
                this.emit();
            }
          } else if (message.type === "heartbeat") {
            const tokens = runtime
              .leaseState(documentId)
              .filter((lease) => lease.actorId === actorId)
              .map((lease) => lease.token);
            if (tokens.length) {
              try {
                runtime.renewForActor(documentId, actorId, tokens);
                this.broadcastLeases();
              } catch {
                this.clearActorPreview(actorId);
              }
            }
          } else if (message.type === "interaction.preview") {
            const scopes = message.preview.elements.map((element) => ({
              kind: "element" as const,
              slideId: message.preview.slideId,
              elementId: element.id,
            }));
            if (!runtime.actorOwns(documentId, actorId, scopes)) return;
            for (const [peerActorId, entry] of this.connected)
              if (peerActorId !== actorId)
                this.writeBestEffort(entry.socket, {
                  type: "interaction.preview",
                  actorId,
                  preview: message.preview,
                });
            this.onPreview(actorId, message.preview);
          } else if (message.type === "interaction.preview.clear") {
            this.clearActorPreview(actorId);
          }
        })().catch(() => socket.destroy());
      },
      () => socket.destroy(),
    );
  }

  approve(id: string) {
    const entry = this.pending.get(id);
    if (!entry || !this.localDocumentId)
      throw new Error("Join request is no longer pending");
    const resumeToken = randomBytes(32).toString("hex");
    this.pending.delete(id);
    this.connected.set(id, { ...entry, resumeToken });
    this.resumeRecords.set(resumeToken, {
      actorId: id,
      peer: entry.peer,
      resumeToken,
      expiresAt: Date.now() + RESUME_TTL,
    });
    this.peers.set(id, {
      id,
      displayName: entry.peer.displayName,
      color: entry.peer.color,
      activeSlideId: null,
      selectionScopeId: null,
      selection: [],
    });
    entry.markApproved();
    entry.socket.setTimeout(0);
    this.sendSnapshot(entry.socket, id, resumeToken);
    this.broadcastPeers();
    this.broadcastLeases();
    this.emit();
  }

  reject(id: string) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    write(entry.socket, { type: "rejected" });
    end(entry.socket);
    this.emit();
  }

  isHosting(documentId: string) {
    return this.localDocumentId === documentId && !!this.server;
  }

  get hostedRecord() {
    return this.hosted;
  }

  get connectedPeers() {
    return this.connected;
  }

  isActive() {
    return Boolean(this.server);
  }

  status() {
    return {
      hosted: this.hosted,
      pending: [...this.pending.values()].map((entry) => entry.peer),
      connected: [...this.connected.values()].map((entry) => entry.peer),
      sessionRevision: this.localDocumentId
        ? this.runtime().currentRevision(this.localDocumentId)
        : null,
      leases: this.serverLeases(),
      peers: this.hostPeers(),
    };
  }

  preview(preview: InteractionPreview) {
    if (!this.localDocumentId) return;
    const scopes = preview.elements.map((element) => ({
      kind: "element" as const,
      slideId: preview.slideId,
      elementId: element.id,
    }));
    const runtime = this.runtime();
    if (!runtime.actorOwns(this.localDocumentId, "local", scopes)) return;
    for (const entry of this.connected.values())
      this.writeBestEffort(entry.socket, {
        type: "interaction.preview",
        actorId: "host",
        preview,
      });
  }

  clearPreview() {
    if (!this.localDocumentId) return;
    this.clearActorPreview("host");
  }

  async select(
    activeSlideId: string | null,
    selectionScopeId: string | null,
    elementIds: string[],
  ) {
    if (!this.localDocumentId) return true;
    const prior = this.peers.get("host");
    const displayName = prior?.displayName ?? "Host";
    this.peers.set("host", {
      id: "host",
      displayName,
      color: prior?.color ?? collaboratorColor(displayName),
      activeSlideId,
      selectionScopeId,
      selection: [...elementIds],
    });
    this.broadcastPeers();
    this.emit();
    return true;
  }

  stop() {
    this.hostUnsubscribe?.();
    this.hostUnsubscribe = null;
    this.stopAdvertise?.();
    this.stopAdvertise = null;
    const documentId = this.localDocumentId;
    if (documentId) {
      const runtime = this.runtime();
      for (const actorId of this.connected.keys())
        runtime.releaseForActor(documentId, actorId);
    }
    for (const actorId of this.connected.keys()) this.clearActorPreview(actorId);
    for (const entry of [
      ...this.pending.values(),
      ...this.connected.values(),
    ]) {
      this.writeBestEffort(entry.socket, { type: "stopped" });
      end(entry.socket);
    }
    this.pending.clear();
    this.connected.clear();
    this.resumeRecords.clear();
    this.peers.clear();
    this.server?.close();
    this.server = null;
    this.hosted = null;
    this.localDocumentId = null;
    this.emit();
  }
}
