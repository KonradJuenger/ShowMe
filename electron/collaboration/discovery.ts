import dgram from "node:dgram";
import { isIP } from "node:net";
import {
  discoverySchema,
  type DiscoveryRecord,
} from "../../src/core/collaboration/protocol";
import { isPrivateAddress } from "./security";

const GROUP = "239.255.42.99";
const GROUP6 = "ff05::114";
const PORT = 41873;
const DISCOVERY_VERSION = 1 as const;
const PREFIX = `showme-collab-v${DISCOVERY_VERSION}:`;

export async function advertise(
  record: Omit<DiscoveryRecord, "address">,
  interfaceAddress: string,
) {
  const ipv6 = isIP(interfaceAddress) === 6;
  const socket = dgram.createSocket(ipv6 ? "udp6" : "udp4");
  const payload = Buffer.from(
    PREFIX + JSON.stringify(discoverySchema.parse(record)),
  );
  function send() {
    socket.send(payload, PORT, ipv6 ? GROUP6 : GROUP);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, interfaceAddress, () => {
        socket.off("error", reject);
        try {
          socket.setMulticastInterface(interfaceAddress);
          socket.setMulticastTTL(1);
          send();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  } catch (error) {
    socket.close();
    throw error;
  }
  socket.on("error", () => {});
  const timer = setInterval(send, 2000);
  return () => {
    clearInterval(timer);
    socket.close();
  };
}

export class DiscoveryBrowser {
  private sockets: dgram.Socket[] = [];
  private records = new Map<
    string,
    { record: DiscoveryRecord; seen: number }
  >();
  private expiryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly onChanged?: (records: DiscoveryRecord[]) => void) {}

  async start(interfaces: string[]) {
    this.expiryTimer = setInterval(() => {
      const before = this.records.size;
      this.list();
      if (this.records.size !== before) this.onChanged?.(this.list());
    }, 2000);
    for (const ipv6 of [false, true]) {
      const addresses = interfaces.filter(
        (address) => isIP(address) === (ipv6 ? 6 : 4),
      );
      if (!addresses.length) continue;
      const socket = dgram.createSocket({
        type: ipv6 ? "udp6" : "udp4",
        reuseAddr: true,
        ipv6Only: ipv6,
      });
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.bind(PORT, ipv6 ? "::" : "0.0.0.0", () => {
            socket.off("error", reject);
            resolve();
          });
        });
      } catch {
        socket.close();
        continue;
      }
      socket.on("error", () => {});
      for (const address of addresses) {
        try {
          socket.addMembership(ipv6 ? GROUP6 : GROUP, address);
        } catch {
          /* unavailable interface */
        }
      }
      socket.on("message", (bytes, info) => this.receive(bytes, info.address));
      this.sockets.push(socket);
    }
  }

  private receive(bytes: Buffer, address: string) {
    if (bytes.length > 1024 || !isPrivateAddress(address)) return;
    const text = bytes.toString("utf8");
    if (!text.startsWith(PREFIX)) return;
    try {
      const value = discoverySchema.parse(
        JSON.parse(text.slice(PREFIX.length)),
      );
      const prior = this.records.get(value.sessionId)?.record;
      this.records.set(value.sessionId, {
        record: { ...value, address },
        seen: Date.now(),
      });
      if (!prior || JSON.stringify(prior) !== JSON.stringify({ ...value, address }))
        this.onChanged?.(this.list());
    } catch {
      /* malformed advertisements are ignored */
    }
  }

  list() {
    const now = Date.now();
    for (const [id, entry] of this.records)
      if (now - entry.seen > 6000) this.records.delete(id);
    return [...this.records.values()].map((entry) => entry.record);
  }

  stop() {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = null;
    for (const socket of this.sockets) socket.close();
    this.sockets = [];
    this.records.clear();
  }
}
