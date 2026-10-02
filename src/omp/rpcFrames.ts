import type { OmpRpcEvent } from "./types";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

interface PendingChunks {
  id: string;
  count: number;
  byteLength: number;
  buffers: Buffer[];
  receivedBytes: number;
}

/** OMP v2 transports one logical JSON frame as ordered base64 UTF-8 chunks. */
export class RpcFrameDecoder {
  private pending?: PendingChunks;

  reset(): void {
    this.pending = undefined;
  }

  finish(): void {
    if (this.pending) throw new Error("Incomplete RPC chunk sequence at EOF");
  }

  push(value: unknown): OmpRpcEvent | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("RPC frame must be an object");
    }
    const frame = value as OmpRpcEvent;
    if (frame.type !== "rpc_chunk") {
      if (this.pending) throw new Error("RPC chunk sequence interrupted");
      if (typeof frame.type !== "string") throw new Error("RPC frame must have a type");
      return frame;
    }
    const { chunkId, index, count, byteLength, data } = frame;
    if (
      typeof chunkId !== "string" ||
      !chunkId ||
      chunkId.length > 128 ||
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 2 ||
      count > Math.ceil(MAX_REASSEMBLED_BYTES / CHUNK_BYTES) ||
      index >= count ||
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < MAX_FRAME_BYTES ||
      byteLength > MAX_REASSEMBLED_BYTES
    ) {
      throw new Error("Invalid RPC chunk metadata");
    }
    if (
      typeof data !== "string" ||
      !data ||
      data.length > Math.ceil(CHUNK_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    ) {
      throw new Error("Invalid RPC chunk data");
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data || bytes.length > CHUNK_BYTES) {
      throw new Error("Invalid RPC chunk data");
    }
    if (!this.pending) {
      if (index !== 0) throw new Error("RPC chunk sequence must start at index 0");
      this.pending = { id: chunkId, count, byteLength, buffers: [], receivedBytes: 0 };
    }
    const pending = this.pending;
    if (
      pending.id !== chunkId ||
      pending.count !== count ||
      pending.byteLength !== byteLength ||
      index !== pending.buffers.length
    )
      throw new Error("RPC chunk sequence mismatch");
    pending.buffers.push(bytes);
    pending.receivedBytes += bytes.length;
    if (pending.receivedBytes > byteLength)
      throw new Error("RPC chunk sequence exceeds declared length");
    if (pending.buffers.length < count) return undefined;
    if (pending.receivedBytes !== byteLength) throw new Error("RPC chunk sequence length mismatch");
    this.pending = undefined;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.buffers));
    const decoded: unknown = JSON.parse(text);
    if (
      !decoded ||
      typeof decoded !== "object" ||
      Array.isArray(decoded) ||
      typeof (decoded as OmpRpcEvent).type !== "string" ||
      (decoded as OmpRpcEvent).type === "rpc_chunk"
    ) {
      throw new Error("Invalid reassembled RPC frame");
    }
    return decoded as OmpRpcEvent;
  }
}
