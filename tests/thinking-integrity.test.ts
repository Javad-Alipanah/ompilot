import { afterEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatMessagesFromOmp, messagesFromSessionFile } from "../src/omp/sessionHistory";
import { formatSessionPlainText } from "../src/omp/sessionTranscript";
import { InspectionService } from "../src/omp/inspectionService";
import type { OmpRpcClient } from "../src/omp/rpcClient";

mock.module("vscode", () => ({
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
}));
const { SessionManager } = await import("../src/omp/sessionManager");
const sessions: InstanceType<typeof SessionManager>[] = [];
const services: InspectionService[] = [];
const directories: string[] = [];
afterEach(async () => {
  services.splice(0).forEach((service) => service.dispose());
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function mainSession() {
  const session = new SessionManager(() => "/tmp/omp-thinking-test");
  sessions.push(session);
  const internal = session as any;
  internal.client = { isReady: true, prompt() {}, removeAllListeners() {}, dispose: async () => {}, getState: async () => ({ isSettled: true, isStreaming: false }) };
  session.ensureStarted = async () => {};
  await session.send("Local thinking fixture");
  internal.handleEvent({ type: "agent_start" });
  internal.handleEvent({ type: "message_start", message: { role: "assistant", content: [] } });
  const emit = (event: Record<string, unknown>) => internal.handleEvent({ type: "message_update", assistantMessageEvent: event });
  return { session, internal, emit };
}
const thinkingText = (session: InstanceType<typeof SessionManager>) => session.getMessages().flatMap((message) => message.parts).filter((part) => part.kind === "thinking").map((part) => part.text);

test("main host retains distinct full thinking blocks across streamed deltas and final snapshots", async () => {
  const { session, internal, emit } = await mainSession();
  const first = "First 🧠 line\n".repeat(2_000) + "FIRST_END";
  emit({ type: "thinking_start", contentIndex: 0 });
  emit({ type: "thinking_delta", contentIndex: 0, delta: first.slice(0, 12_000) });
  emit({ type: "thinking_delta", contentIndex: 0, delta: first.slice(12_000) });
  emit({ type: "thinking_end", contentIndex: 0, content: first });
  emit({ type: "text_delta", contentIndex: 1, delta: "Interim answer" });
  emit({ type: "thinking_start", contentIndex: 2 });
  emit({ type: "thinking_delta", contentIndex: 2, delta: "Second reasoning" });
  emit({ type: "thinking_end", contentIndex: 2, content: "Second reasoning" });
  expect(thinkingText(session)).toEqual([first, "Second reasoning"]);
  internal.handleEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: first }, { type: "text", text: "Interim answer" }, { type: "thinking", thinking: "Second reasoning" }], ttft: 3_500 } });
  expect(thinkingText(session)).toEqual([first, "Second reasoning"]);
  expect(session.getMessages().flatMap((message) => message.parts).find((part) => part.kind === "thinking")).toMatchObject({ durationMs: 3_500, streaming: false });
  expect(formatSessionPlainText(session.getMessages())).toContain("FIRST_END");
});

test("an end-only thinking payload is retained and closed without duplicate content", async () => {
  const { session, emit } = await mainSession();
  emit({ type: "thinking_start" });
  emit({ type: "thinking_end", content: "End-only reasoning" });
  expect(thinkingText(session)).toEqual(["End-only reasoning"]);
  const block = session.getMessages().flatMap((message) => message.parts).find((part) => part.kind === "thinking");
  expect(block?.kind === "thinking" && block.streaming).toBe(false);
});

test("final answer snapshots do not erase reasoning already received from the provider", async () => {
  const { session, internal, emit } = await mainSession();
  emit({ type: "thinking_delta", delta: "Known streamed reasoning" });
  emit({ type: "thinking_end", content: "Known streamed reasoning" });
  emit({ type: "text_delta", delta: "Answer" });
  internal.handleEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Answer" }] } });
  expect(thinkingText(session)).toEqual(["Known streamed reasoning"]);
});

test("omitted or empty final thinking preserves multiple streamed blocks and their timing", async () => {
  for (const omitted of [true, false]) {
    const { session, internal, emit } = await mainSession();
    emit({ type: "thinking_delta", delta: "First known reasoning" });
    emit({ type: "thinking_end", content: "First known reasoning" });
    emit({ type: "text_delta", delta: "Interim" });
    emit({ type: "thinking_delta", delta: "Second known reasoning" });
    emit({ type: "thinking_end", content: "Second known reasoning" });
    emit({ type: "text_delta", delta: "Answer" });
    const content = omitted ? [{ type: "text", text: "Interim" }, { type: "text", text: "Answer" }] : [{ type: "thinking", thinking: "" }, { type: "text", text: "Interim" }, { type: "thinking", thinking: "" }, { type: "text", text: "Answer" }];
    internal.handleEvent({ type: "message_end", message: { role: "assistant", content, ttft: 2_100 } });
    expect(thinkingText(session)).toEqual(["First known reasoning", "Second known reasoning"]);
    const parts = session.getMessages().find((message) => message.role === "assistant")!.parts;
    expect(parts.map((part) => part.kind)).toEqual(["thinking", "text", "thinking", "text"]);
    expect(parts[0]).toMatchObject({ durationMs: 2_100, streaming: false });
  }
});

test("restored main history and export preserve complete thinking in order around tool calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-thinking-persistence-")); directories.push(directory);
  const file = join(directory, "primary.jsonl");
  const first = "Reasoning 🧠\n".repeat(2_000) + "RESTORED_FIRST_END";
  const raw = [{ role: "assistant", timestamp: 1_790_000_000_000, ttft: 2_400, content: [
    { type: "thinking", thinking: first }, { type: "toolCall", id: "read-1", name: "read", arguments: { path: "sample.ts" } }, { type: "thinking", thinking: "Second restored reasoning" }, { type: "text", text: "Final answer" },
  ] }, { role: "toolResult", toolCallId: "read-1", content: [{ type: "text", text: "Tool result" }] }];
  await writeFile(file, JSON.stringify({ type: "session", id: "primary" }) + "\n" + raw.map((message) => JSON.stringify({ type: "message", message })).join("\n") + "\n");
  const messages = chatMessagesFromOmp(await messagesFromSessionFile(file));
  expect(messages[0].parts.map((part) => part.kind)).toEqual(["thinking", "tool", "thinking", "text"]);
  expect(messages[0].parts[0]).toMatchObject({ kind: "thinking", text: first, durationMs: 2_400 });
  expect(messages[0].parts[2]).toMatchObject({ kind: "thinking", text: "Second restored reasoning" });
  const exported = formatSessionPlainText(messages);
  expect(exported).toContain("RESTORED_FIRST_END");
  expect(exported.indexOf("RESTORED_FIRST_END")).toBeLessThan(exported.indexOf("[Tool: read]"));
  expect(exported.indexOf("[Tool: read]")).toBeLessThan(exported.indexOf("Second restored reasoning"));
});

class InspectorClient extends EventEmitter {
  isReady = true; isRunning = true;
  sessionFile?: string;
  messages: unknown[] = [];
  failWorkerRpc = false;
  async getState() { return { sessionFile: this.sessionFile }; }
  async request(command: Record<string, unknown>) {
    if (command.type === "get_subagents") return { success: true, data: { subagents: this.failWorkerRpc ? [] : [{ id: "worker", status: "running" }] } };
    if (command.type === "get_subagent_messages") {
      if (this.failWorkerRpc) return { success: false, error: "Unknown subagent" };
      const from = Number(command.fromByte || 0);
      return { success: true, data: { messages: this.messages.slice(from), nextByte: this.messages.length, sessionFile: "worker.jsonl" } };
    }
    return { success: true, data: {} };
  }
}
function inspector(client: InspectorClient) {
  const service = new InspectionService(client as unknown as OmpRpcClient, () => {}); services.push(service); return service;
}
test("live worker reasoning survives partial snapshots and persisted replay without duplication", async () => {
  const client = new InspectorClient(); const service = inspector(client); await service.start(); await service.select("worker");
  const emit = (event: unknown) => client.emit("event", { type: "subagent_event", payload: { id: "worker", event } });
  const message = { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: "🧠 worker thought\n".repeat(2_000) + "WORKER_END" }, { type: "text", text: "Result" }] };
  emit({ type: "message_start", message: { role: "assistant", timestamp: 2, content: [] } });
  emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", partial: message } });
  expect(service.getSnapshot().transcript?.messages).toEqual([{ ...message, streaming: true }]);
  emit({ type: "message_end", message }); client.messages.push(message); await service.refresh();
  expect(service.getSnapshot().transcript?.messages).toEqual([message]);
});

test("resumed worker and advisor sidecars preserve every raw thinking part and its metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-thinking-sidecars-")); directories.push(directory);
  const parent = join(directory, "primary.jsonl"); const artifacts = parent.slice(0, -6); await mkdir(artifacts);
  const raw = { role: "assistant", content: [{ type: "thinking", thinking: "Persisted thought\n".repeat(2_000) + "SIDECAR_END", thinkingSignature: "opaque-provider-metadata" }, { type: "text", text: "Result" }] };
  const fixture = JSON.stringify({ type: "title", name: "thinking fixture" }) + "\n" + JSON.stringify({ type: "session", id: "thinking" }) + "\n" + JSON.stringify({ type: "message", message: raw }) + "\n";
  await writeFile(parent, JSON.stringify({ type: "session", id: "primary" }) + "\n");
  await Promise.all([writeFile(join(artifacts, "worker.jsonl"), fixture), writeFile(join(artifacts, "__advisor.jsonl"), fixture)]);
  const client = new InspectorClient(); client.sessionFile = parent; client.failWorkerRpc = true;
  const service = inspector(client); await service.start();
  const agents = service.getSnapshot().agents;
  const advisor = agents.find((agent) => agent.kind === "advisor")!;
  expect(await service.getTranscript("worker")).toEqual([raw]);
  expect(await service.getTranscript(advisor.id)).toEqual([raw]);
  await service.select(advisor.id);
  expect(service.getSnapshot().transcript?.readOnly).toBe(true);
});
