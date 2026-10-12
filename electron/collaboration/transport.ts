import type { Socket } from "node:net";
import {
  MAX_COLLAB_CONTROL_BYTES,
  MAX_COLLAB_OPERATION_BYTES,
  MAX_COLLAB_PREVIEW_BYTES,
  MAX_COLLAB_MESSAGE_BYTES,
  type ClientMessage,
  type ServerMessage,
} from "../../src/core/collaboration/protocol";

function messageLimit(message: ClientMessage | ServerMessage) {
  if (message.type === "snapshot") return MAX_COLLAB_MESSAGE_BYTES;
  if (
    message.type === "transaction.submit" ||
    message.type === "transaction.accepted" ||
    message.type === "transactions.replay" ||
    message.type === "resume"
  )
    return MAX_COLLAB_OPERATION_BYTES * 8;
  if (message.type === "interaction.preview") return MAX_COLLAB_PREVIEW_BYTES;
  return MAX_COLLAB_CONTROL_BYTES;
}

export const MAX_OUTBOUND_QUEUE_BYTES = MAX_COLLAB_MESSAGE_BYTES + 8 * 1024 * 1024;
interface Outbound {
  queue: Buffer[];
  bytes: number;
  blocked: boolean;
  ending: boolean;
}
const outbound = new WeakMap<Socket, Outbound>();
function stateFor(socket: Socket) {
  let state = outbound.get(socket);
  if (state) return state;
  state = { queue: [], bytes: 0, blocked: false, ending: false };
  outbound.set(socket, state);
  const current = state;
  socket.on("drain", () => {
    current.blocked = false;
    while (!socket.destroyed && !current.blocked && current.queue.length) {
      const bytes = current.queue.shift()!;
      current.bytes -= bytes.length;
      current.blocked = !socket.write(bytes);
    }
    if (current.ending && !current.queue.length) socket.end();
  });
  socket.once("close", () => { current.queue = []; current.bytes = 0; });
  return state;
}
export function transportDiagnostics(socket: Socket) {
  const state = outbound.get(socket);
  return { queuedBytes: (state?.bytes ?? 0) + socket.writableLength, blocked: state?.blocked ?? false };
}
export function write(socket: Socket, message: ClientMessage | ServerMessage) {
  const bytes = Buffer.from(JSON.stringify(message) + "\n");
  if (bytes.length > messageLimit(message)) throw new Error("Collaboration message is too large");
  if (socket.destroyed || socket.writableEnded) return;
  const state = stateFor(socket);
  if (state.ending) return;
  if (state.queue.length >= 2048 || state.bytes + socket.writableLength + bytes.length > MAX_OUTBOUND_QUEUE_BYTES) {
    // Never drop an accepted transaction or stall authority acceptance. A slow
    // replica reconnects through the existing retained replay/snapshot protocol.
    socket.destroy();
    return;
  }
  if (state.blocked) { state.queue.push(bytes); state.bytes += bytes.length; }
  else state.blocked = !socket.write(bytes);
}
export function end(socket: Socket) {
  const state = stateFor(socket);
  state.ending = true;
  if (!state.queue.length) socket.end();
  else { const timer = setTimeout(() => socket.destroy(), 1000); timer.unref(); socket.once("close", () => clearTimeout(timer)); }
}

function inboundMessageLimit(bytes: Buffer) {
  // ShowMe's writer emits a canonical envelope with "type" first. Large
  // message classes only receive their larger budget when the following
  // required top-level field also matches that canonical envelope. A caller
  // cannot claim "snapshot" or "transaction.submit" alone to obtain a larger
  // pre-parse allocation budget.
  const prefix = bytes
    .subarray(0, Math.min(bytes.length, MAX_COLLAB_CONTROL_BYTES))
    .toString("utf8");
  const match =
    /^\s*\{\s*"type"\s*:\s*"([a-z.]+)"\s*(?:,\s*"([a-zA-Z]+)"\s*:)?/.exec(
      prefix,
    );
  if (!match) return null;
  const [, type, nextKey] = match;
  if (type === "interaction.preview") return MAX_COLLAB_PREVIEW_BYTES;
  if (type === "snapshot" && nextKey === "document")
    return MAX_COLLAB_MESSAGE_BYTES;
  if (type === "transaction.submit" && nextKey === "transaction")
    return MAX_COLLAB_OPERATION_BYTES * 8;
  if (type === "transaction.accepted" && nextKey === "accepted")
    return MAX_COLLAB_OPERATION_BYTES * 8;
  if (type === "transactions.replay" && nextKey === "epoch")
    return MAX_COLLAB_OPERATION_BYTES * 8;
  if (type === "resume" && nextKey === "actorId")
    return MAX_COLLAB_OPERATION_BYTES * 8;
  return MAX_COLLAB_CONTROL_BYTES;
}

export function listenLines(
  socket: Socket,
  handle: (input: unknown) => void,
  fail: (error: Error) => void,
) {
  let buffer = Buffer.alloc(0);
  let length = 0;
  const reject = (message: string) => {
    fail(new Error(message));
    socket.destroy();
  };
  const appendBounded = (segment: Buffer) => {
    const prefixBytes = Math.max(0, MAX_COLLAB_CONTROL_BYTES - length);
    const prefix =
      prefixBytes > 0
        ? Buffer.concat([buffer.subarray(0, length), segment.subarray(0, prefixBytes)])
        : buffer.subarray(0, MAX_COLLAB_CONTROL_BYTES);
    const limit = inboundMessageLimit(prefix) ?? MAX_COLLAB_CONTROL_BYTES;
    const needed = length + segment.length;
    if (needed > limit) return false;
    if (needed > buffer.length) {
      const replacement = Buffer.allocUnsafe(Math.min(limit, Math.max(needed, buffer.length * 2, 1024)));
      buffer.copy(replacement, 0, 0, length);
      buffer = replacement;
    }
    segment.copy(buffer, length);
    length = needed;
    return true;
  };

  socket.on("data", (chunk: Buffer) => {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline >= 0 ? newline : chunk.length;
      if (!appendBounded(chunk.subarray(offset, end))) {
        reject("Collaboration message exceeds its limit");
        return;
      }

      if (newline < 0) return;

      const line = buffer.subarray(0, length);
      buffer = Buffer.alloc(0);
      length = 0;
      try {
        const input: unknown = JSON.parse(line.toString("utf8"));
        handle(input);
      } catch {
        reject("Malformed collaboration message");
        return;
      }
      offset = newline + 1;
    }
  });
}
