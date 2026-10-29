import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import {
  end,
  listenLines,
  transportDiagnostics,
  write,
  MAX_OUTBOUND_QUEUE_BYTES,
} from "../../../electron/collaboration/transport";
import { DocumentAuthority } from "../../../src/core/documentAuthority";
import { newPresentationDocument } from "../../../src/core/document";
import { ClientReplica } from "../../../src/core/collaboration/clientReplica";
import { CollaborationService } from "../../../electron/collaboration/session";
import { storedDocument } from "../../helpers/storage";
import {
  COLLAB_DOCUMENT_VERSION,
  COLLAB_PROTOCOL_VERSION,
  clientMessageSchema,
  compatibleVersions,
  serverMessageSchema,
} from "../../../src/core/collaboration/protocol";

vi.mock("../../../electron/collaboration/discovery", () => ({
  advertise: async () => () => {},
  DiscoveryBrowser: class {},
}));
vi.mock("../../../electron/collaboration/security", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../electron/collaboration/security")>()),
  privateInterfaces: () => ["127.0.0.1"],
  selectedLanAddress: () => "127.0.0.1",
}));

it("a stopped host releases the guest session before the hosted document closes", async () => {
  const { storage, id } = await storedDocument();
  const host = new CollaborationService((documentId) => storage.documentRuntime(documentId));
  const guest = new CollaborationService(() => { throw new Error("Guest has no local host runtime"); });
  const unavailable: string[] = [];
  guest.subscribe(() => {}, () => {}, undefined, undefined, undefined, (documentId) => unavailable.push(documentId));
  try {
    const record = await host.start(id);
    await guest.join(record, "Guest");
    await vi.waitFor(() => expect(host.status().pending).toHaveLength(1));
    host.approve(host.status().pending[0].id);
    await vi.waitFor(() => expect(guest.status().clientStatus).toBe("connected"));
    host.stop();
    await storage.closeDocument(id);
    await vi.waitFor(() => expect(guest.status().clientStatus).toBe("idle"));
    expect(guest.status().clientDocumentId).toBeNull();
    expect(unavailable).toEqual([id]);
  } finally {
    guest.close();
    host.close();
  }
});

it("public protocol v1 handshake accepts current peers and rejects mismatched versions", () => {
  expect(COLLAB_PROTOCOL_VERSION).toBe(1);
  expect(COLLAB_DOCUMENT_VERSION).toBe(1);
  const versions = {
    appVersion: "0.1.0",
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    documentVersion: COLLAB_DOCUMENT_VERSION,
  };
  expect(serverMessageSchema.parse({ type: "compatible", versions })).toEqual({
    type: "compatible",
    versions,
  });
  expect(compatibleVersions(versions, versions)).toBe(true);
  expect(
    compatibleVersions(versions, { ...versions, protocolVersion: 2 }),
  ).toBe(false);
  expect(
    compatibleVersions(versions, { ...versions, documentVersion: 2 }),
  ).toBe(false);
  const hello = { type: "hello", sessionId: "a".repeat(64), versions };
  expect(clientMessageSchema.parse(hello)).toEqual(hello);
});

class Peer extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  frames: Buffer[] = [];
  blocked = false;
  write(bytes: Buffer) {
    this.frames.push(bytes);
    this.writableLength += this.blocked ? bytes.length : 0;
    return !this.blocked;
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
  end() {
    this.writableEnded = true;
  }
  get socket() {
    return this as unknown as Socket;
  }
  drain() {
    this.writableLength = 0;
    this.blocked = false;
    this.emit("drain");
  }
}

it("a blocked peer preserves ordering and disconnects at bounded backlog without blocking healthy peers", () => {
  const slow = new Peer(),
    healthy = new Peer();
  slow.blocked = true;
  write(slow.socket, { type: "waiting" });
  write(slow.socket, { type: "stopped" });
  expect(slow.frames).toHaveLength(1);
  end(slow.socket);
  slow.drain();
  expect(slow.frames.map((frame) => JSON.parse(frame.toString()).type)).toEqual(
    ["waiting", "stopped"],
  );
  expect(slow.writableEnded).toBe(true);
  const stalled = new Peer();
  stalled.blocked = true;
  for (let i = 0; i < 3000; i++) {
    write(stalled.socket, { type: "heartbeat" });
    write(healthy.socket, { type: "heartbeat" });
  }
  expect(stalled.destroyed).toBe(true);
  expect(transportDiagnostics(stalled.socket).queuedBytes).toBeLessThanOrEqual(
    MAX_OUTBOUND_QUEUE_BYTES,
  );
  expect(healthy.frames).toHaveLength(3000);
});

it("fragmented lines retain message limits and reject malformed or oversized control envelopes", () => {
  const peer = new Peer(),
    messages: unknown[] = [],
    errors: Error[] = [];
  listenLines(
    peer.socket,
    (message) => messages.push(message),
    (error) => errors.push(error),
  );
  for (const byte of Buffer.from('{"type":"heartbeat"}\n'))
    peer.emit("data", Buffer.from([byte]));
  expect(messages).toEqual([{ type: "heartbeat" }]);
  peer.emit(
    "data",
    Buffer.from('{"type":"heartbeat","padding":"' + "x".repeat(32768)),
  );
  expect(peer.destroyed).toBe(true);
  expect(errors).toHaveLength(1);
});

it("lost acknowledgement duplicates, replay gaps and retention exhaustion converge through canonical snapshot/replay", async () => {
  const document = newPresentationDocument("LAN"),
    slideId = document.deck.slideIds[0];
  const authority = new DocumentAuthority(document),
    replica = new ClientReplica();
  replica.install(document, authority.epoch, 0);
  const grant = authority.acquire("guest", [{ kind: "notes", slideId }]);
  if (grant.denied) throw new Error("Lease denied");
  const transaction = {
    transactionId: "lost-ack",
    documentId: document.documentId,
    epoch: authority.epoch,
    baseRevision: 0,
    leaseTokens: grant.grants.map((g) => g.token),
    operations: [{ type: "slide.notes.set" as const, slideId, notes: "one" }],
  };
  const accepted = await authority.commit("guest", transaction);
  expect(await authority.commit("guest", transaction)).toBe(accepted);
  const next = await authority.commit("guest", {
    ...transaction,
    transactionId: "next",
    baseRevision: 1,
    operations: [{ type: "slide.notes.set", slideId, notes: "two" }],
  });
  expect(() => replica.apply(next)).toThrow("stream gap");
  replica.applyMany(authority.acceptedAfter(0)!);
  replica.apply(accepted);
  expect(replica.document).toEqual(authority.document);
  for (let i = 0; i < 4100; i++)
    await authority.commit("guest", {
      ...transaction,
      transactionId: "edit-" + i,
      baseRevision: authority.revision,
      operations: [{ type: "slide.notes.set", slideId, notes: String(i) }],
    });
  expect(authority.acceptedAfter(0)).toBeNull();
  replica.install(authority.document, authority.epoch, authority.revision);
  expect(replica.document).toEqual(authority.document);
});
