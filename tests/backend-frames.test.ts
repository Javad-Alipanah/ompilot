import { describe, expect, test } from "bun:test";
import { RpcFrameDecoder } from "../src/omp/rpcFrames";

function chunks(value: unknown, chunkId = "frame-1") {
  const bytes = Buffer.from(JSON.stringify(value));
  const size = 256 * 1024;
  const count = Math.ceil(bytes.length / size);
  return Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk", chunkId, index, count, byteLength: bytes.length,
    data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
  }));
}

describe("RPC v2 frame decoding", () => {
  test("reassembles full UTF-8 responses over one MiB without clipping", () => {
    const value = { type: "response", id: "request-3", command: "get_messages", success: true,
      data: { messages: [{ role: "assistant", content: "فارسی 🌱".repeat(120_000) }] } };
    const decoder = new RpcFrameDecoder();
    const physical = chunks(value);
    for (const frame of physical.slice(0, -1)) expect(decoder.push(frame)).toBeUndefined();
    expect(decoder.push(physical.at(-1))).toEqual(value);
  });

  test("rejects corrupt sequences and permits recovery with a fresh frame", () => {
    const decoder = new RpcFrameDecoder();
    const physical = chunks({ type: "message_end", message: "x".repeat(1_100_000) });
    expect(decoder.push(physical[0])).toBeUndefined();
    expect(() => decoder.push(physical[2])).toThrow(/sequence/);
    decoder.reset();
    expect(decoder.push({ type: "notice", message: "Recovered" })).toEqual({ type: "notice", message: "Recovered" });
  });

  test("rejects metadata allocation attacks and noncanonical base64", () => {
    const decoder = new RpcFrameDecoder();
    expect(() => decoder.push({ type: "rpc_chunk", chunkId: "bad", index: 0, count: 2,
      byteLength: Number.MAX_SAFE_INTEGER, data: "e30=" })).toThrow(/metadata/);
    const physical = chunks({ type: "message_end", message: "x".repeat(1_100_000) });
    expect(() => decoder.push({ ...physical[0], data: "%%%" })).toThrow(/data/);
  });
});
