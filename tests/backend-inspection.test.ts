import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OmpRpcClient } from "../src/omp/rpcClient";
import { InspectionService } from "../src/omp/inspectionService";

class FakeClient extends EventEmitter {
  isReady = true;
  isRunning = true;
  sessionFile?: string;
  roster: unknown[] = [];
  commands: Record<string, unknown>[] = [];
  messages: Record<string, unknown[]> = {};
  handler?: (command: Record<string, unknown>) => Promise<any>;
  async getState() { return { sessionFile: this.sessionFile }; }
  async request(command: Record<string, unknown>) {
    this.commands.push(command);
    if (this.handler) return this.handler(command);
    let data: unknown = {};
    if (command.type === "get_subagents") data = { subagents: this.roster };
    if (command.type === "get_subagent_messages") {
      const messages = this.messages[String(command.subagentId)] ?? [];
      const from = Number(command.fromByte ?? 0);
      data = { sessionFile: "unused", fromByte: from, nextByte: messages.length, reset: false, messages: messages.slice(from) };
    }
    return { type: "response", command: command.type, success: true, data };
  }
}

const services: InspectionService[] = [];
const directories: string[] = [];
afterEach(async () => {
  services.splice(0).forEach(service => service.dispose());
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
function service(client: FakeClient) {
  const instance = new InspectionService(client as unknown as OmpRpcClient, () => {});
  services.push(instance);
  return instance;
}
async function session() {
  const dir = await mkdtemp(join(tmpdir(), "omp-inspection-test-"));
  directories.push(dir);
  const sessionFile = join(dir, "primary.jsonl");
  await writeFile(sessionFile, JSON.stringify({ type: "session", id: "primary", cwd: dir }) + "\n");
  await mkdir(sessionFile.slice(0, -6));
  return { dir, sessionFile, artifacts: sessionFile.slice(0, -6) };
}
function entry(message: unknown) { return JSON.stringify({ type: "message", message }) + "\n"; }
function header(id: string) { return JSON.stringify({ type: "title", name: id }) + "\n" + JSON.stringify({ type: "session", id }) + "\n"; }

describe("session inspection", () => {
  test("normalizes exact wire shapes, retains completed workers and uses capabilities", async () => {
    const client = new FakeClient();
    client.roster = [{ id: "Anna", agent: "scout", status: "running", progress: { model: "provider/model" } }];
    const inspector = service(client);
    await inspector.start();
    expect(client.commands[0]).toEqual({ type: "set_subagent_subscription", level: "events" });
    expect(inspector.getSnapshot().agents[0]).toMatchObject({ id: "Anna", kind: "worker", status: "running", canSteer: true, canCancel: true });
    client.emit("event", { type: "subagent_progress", payload: { agent: "scout", progress: { id: "Anna", status: "running", resolvedModelIdentity: "changed" } } });
    expect(inspector.getSnapshot().agents[0].model).toBe("changed");
    client.emit("event", { type: "subagent_lifecycle", payload: { id: "Anna", agent: "scout", status: "completed" } });
    client.roster = [];
    await inspector.refresh();
    expect(inspector.getSnapshot().agents[0]).toMatchObject({ status: "completed", canSteer: false, canCancel: false });
    await expect(inspector.steer("Anna", "continue")).rejects.toThrow(/running/);
  });

  test("fetches incremental full worker transcripts and replaces on reset", async () => {
    const client = new FakeClient();
    client.roster = [{ id: "worker", agent: "task", status: "running" }];
    client.messages.worker = [{ role: "user", content: "start" }, { role: "assistant", content: "x".repeat(1_200_000) }];
    const inspector = service(client);
    await inspector.start();
    await inspector.select("worker");
    client.messages.worker.push({ role: "assistant", content: "next" });
    await inspector.refresh();
    expect(inspector.getSnapshot().transcript?.messages).toEqual(client.messages.worker);
    expect(client.commands.filter(command => command.type === "get_subagent_messages").at(-1)?.fromByte).toBe(2);
    client.handler = async command => ({ success: true, data: command.type === "get_subagents" ? { subagents: client.roster } : { reset: true, fromByte: 0, nextByte: 1, messages: [{ role: "user", content: "reset" }] } });
    expect(await inspector.getTranscript("worker")).toEqual([{ role: "user", content: "reset" }]);
  });

  test("routes targeted worker commands and rejects unknown arbitrary path selectors", async () => {
    const client = new FakeClient();
    client.roster = [{ id: "worker", agent: "task", status: "running" }];
    const inspector = service(client);
    await inspector.start();
    await inspector.steer("worker", "use another approach");
    await inspector.cancel("worker");
    expect(client.commands).toContainEqual({ type: "steer_subagent", subagentId: "worker", message: "use another approach" });
    expect(client.commands).toContainEqual({ type: "cancel_subagent", subagentId: "worker" });
    await expect(inspector.getTranscript("/etc/passwd")).rejects.toThrow(/unknown/i);
  });

  test("discovers only own valid saved children and advisor sidecars, with finalized full messages", async () => {
    const { dir, sessionFile, artifacts } = await session();
    const child = join(artifacts, "Anna.jsonl");
    const childDir = child.slice(0, -6);
    await mkdir(childDir);
    const full = { role: "assistant", model: "advisor/model", content: "full".repeat(400_000) };
    await writeFile(child, header("Anna") + entry({ role: "assistant", content: "done" }));
    await writeFile(join(artifacts, "__advisor.reviewer.jsonl"), header("reviewer") + entry(full) + '{"type":"message"');
    await writeFile(join(childDir, "__advisor.jsonl"), header("child-advisor") + entry({ role: "assistant", content: "child advice" }));
    await writeFile(join(artifacts, "not-a-session.jsonl"), entry({ role: "user", content: "wrong" }));
    await writeFile(join(artifacts, "__advisor-2.jsonl"), header("__advisor-2") + entry({ role: "assistant", content: "a worker" }));
    await writeFile(join(dir, "__advisor.unrelated.jsonl"), header("unrelated") + entry({ role: "assistant", content: "private" }));
    await symlink(join(dir, "__advisor.unrelated.jsonl"), join(artifacts, "__advisor.symlink.jsonl"));
    const client = new FakeClient(); client.sessionFile = sessionFile;
    const inspector = service(client);
    await inspector.start();
    const agents = inspector.getSnapshot().agents;
    expect(agents.map(agent => agent.name)).toContain("Anna");
    expect(agents.filter(agent => agent.kind === "advisor")).toHaveLength(2);
    expect(agents.filter(agent => agent.kind === "worker").map(agent => agent.id)).toContain("__advisor-2");
    expect(agents.some(agent => agent.sessionFile?.endsWith("not-a-session.jsonl"))).toBe(false);
    const advisor = agents.find(agent => agent.sessionFile?.endsWith("__advisor.reviewer.jsonl"))!;
    await inspector.select(advisor.id);
    expect(inspector.getSnapshot().transcript).toMatchObject({ agentId: advisor.id, readOnly: true, messages: [full] });
    await expect(inspector.steer(advisor.id, "control")).rejects.toThrow(/read.only/i);
    await appendFile(advisor.sessionFile!, '}\n'); // The completed metadata line is not a message.
    expect(await inspector.getTranscript(advisor.id)).toEqual([full]);
  });

  test("surfaces parent and child prewalk/advisor notices and stops updates on disposal", async () => {
    const client = new FakeClient();
    const inspector = service(client); await inspector.start();
    client.emit("event", { type: "notice", source: "prewalk", message: "Switched model" });
    client.emit("event", { type: "subagent_event", payload: { id: "Anna", event: { type: "notice", source: "advisor", message: "Advice delivered" } } });
    expect(inspector.getSnapshot().notices.map(notice => notice.message)).toEqual(["Switched model", "Advice delivered"]);
    inspector.dispose();
    client.emit("event", { type: "notice", message: "Late" });
    expect(inspector.getSnapshot().notices).toHaveLength(2);
    expect(client.listenerCount("event")).toBe(0);
  });

  test("coalesces concurrent refreshes and recovers after a failed poll", async () => {
    const client = new FakeClient(); const inspector = service(client); await inspector.start();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    client.handler = async command => { if (command.type === "get_subagents") { calls++; await gate; throw new Error("temporary outage"); } return { success: true, data: {} }; };
    const first = inspector.refresh(); const second = inspector.refresh();
    release(); await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(inspector.getSnapshot().error).toContain("temporary outage");
    client.handler = undefined; await inspector.refresh();
    expect(inspector.getSnapshot().error).toBeUndefined();
  });

  test("clears prior session rows and transcript after an own-session switch", async () => {
    const firstSession = await session(); const secondSession = await session();
    const client = new FakeClient(); client.sessionFile = firstSession.sessionFile;
    client.roster = [{ id: "old", agent: "task", status: "running" }];
    const inspector = service(client); await inspector.start(); await inspector.select("old");
    client.sessionFile = secondSession.sessionFile; client.roster = []; await inspector.refresh();
    expect(inspector.getSnapshot().agents).toEqual([]);
    expect(inspector.getSnapshot().selectedId).toBeUndefined();
    expect(inspector.getSnapshot().transcript).toBeUndefined();
  });

  test("shows full live worker snapshots and reconciles finalized disk messages without duplicates", async () => {
    const client = new FakeClient();
    client.roster = [{ id: "live", agent: "scout", description: "Inspect source", status: "running" }];
    client.messages.live = [{ role: "user", content: "start", timestamp: 1 }];
    const inspector = service(client); await inspector.start(); await inspector.select("live");
    const emit = (event: unknown) => client.emit("event", { type: "subagent_event", payload: { id: "live", event } });
    emit({ type: "message_start", message: { role: "assistant", timestamp: 2, content: [] } });
    const partial = { role: "assistant", timestamp: 2, content: [{ type: "text", text: "🌱".repeat(300_000) }] };
    emit({ type: "message_update", message: partial });
    expect(inspector.getSnapshot().transcript?.messages).toEqual([client.messages.live[0], { ...partial, streaming: true }]);
    await inspector.refresh();
    expect(inspector.getSnapshot().transcript?.messages).toHaveLength(2);
    emit({ type: "message_end", message: partial });
    expect(inspector.getSnapshot().transcript?.messages).toEqual([client.messages.live[0], partial]);
    client.messages.live.push(partial);
    await inspector.refresh();
    expect(inspector.getSnapshot().transcript?.messages).toEqual(client.messages.live);
    emit({ type: "message_start", message: { role: "assistant", timestamp: 3, content: [] } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "next turn", partial: { role: "assistant", timestamp: 3, content: [{ type: "text", text: "next turn" }] } } });
    expect(inspector.getSnapshot().transcript?.messages).toHaveLength(3);
    expect(inspector.getSnapshot().agents[0].name).toContain("scout");
    expect(inspector.getSnapshot().agents[0].name).toContain("live");
  });

  test("preserves buffered and concurrent startup notices on initial own-session synchronization", async () => {
    const { sessionFile } = await session();
    const client = new FakeClient(); client.sessionFile = sessionFile;
    client.getState = async () => {
      client.emit("event", { type: "notice", source: "prewalk", message: "During startup" });
      return { sessionFile };
    };
    const inspector = new InspectionService(client as unknown as OmpRpcClient, () => {}, [{ type: "notice", source: "advisor", message: "Before ready" }]);
    services.push(inspector); await inspector.start();
    expect(inspector.getSnapshot().notices.map(notice => notice.message)).toEqual(["Before ready", "During startup"]);
    client.emit("event", { type: "advisor_yielded" });
    expect(inspector.getSnapshot().notices.at(-1)?.source).toBe("advisor");
  });

  test("reads saved worker transcript after resume RPC refuses its selector", async () => {
    const { sessionFile, artifacts } = await session();
    const messages = [{ role: "user", content: "steering recorded" }, { role: "assistant", content: "complete" }];
    await writeFile(join(artifacts, "saved.jsonl"), header("saved") + messages.map(entry).join(""));
    const client = new FakeClient(); client.sessionFile = sessionFile;
    client.handler = async command => command.type === "get_subagent_messages"
      ? { success: false, error: "Unknown subagent or session file unavailable: saved" }
      : { success: true, data: { subagents: [] } };
    const inspector = service(client); await inspector.start();
    expect(await inspector.getTranscript("saved")).toEqual(messages);
  });

  test("restores nested saved workers and their own advisors after resume", async () => {
    const { sessionFile, artifacts } = await session();
    const parentFile = join(artifacts, "Anna.jsonl");
    const parentDirectory = parentFile.slice(0, -6);
    const childFile = join(parentDirectory, "Anna.Bob.jsonl");
    const childDirectory = childFile.slice(0, -6);
    const grandchildFile = join(childDirectory, "Anna.Bob.Chen.jsonl");
    const nestedMessages = [
      { role: "user", content: "Inspect the nested task" },
      { role: "assistant", content: [{ type: "thinking", thinking: "Preserved nested reasoning" }, { type: "text", text: "Nested result" }] },
    ];
    const advisorMessage = { role: "assistant", content: "Nested advisor review" };
    await mkdir(childDirectory, { recursive: true });
    await writeFile(parentFile, header("Anna") + entry({ role: "assistant", content: "Parent result" }));
    await writeFile(childFile, header("Anna.Bob") + nestedMessages.map(entry).join(""));
    await writeFile(grandchildFile, header("Anna.Bob.Chen") + entry({ role: "assistant", content: "Grandchild result" }));
    await writeFile(join(childDirectory, "__advisor.jsonl"), header("nested-advisor") + entry(advisorMessage));
    const client = new FakeClient(); client.sessionFile = sessionFile;
    client.handler = async command => command.type === "get_subagent_messages"
      ? { success: false, error: "Unknown subagent or session file unavailable" }
      : { success: true, data: { subagents: [] } };
    const inspector = service(client); await inspector.start();
    const agents = inspector.getSnapshot().agents;
    expect(agents.find(agent => agent.id === "Anna.Bob")).toMatchObject({ parentId: "Anna", status: "recorded", sessionFile: childFile, canSteer: false, canCancel: false });
    expect(agents.find(agent => agent.id === "Anna.Bob.Chen")).toMatchObject({ parentId: "Anna.Bob", sessionFile: grandchildFile });
    await inspector.select("Anna.Bob");
    expect(inspector.getSnapshot().transcript).toEqual({ agentId: "Anna.Bob", messages: nestedMessages, readOnly: false });
    const advisor = agents.find(agent => agent.kind === "advisor")!;
    expect(advisor.parentId).toBe("Anna.Bob");
    await inspector.select(advisor.id);
    expect(inspector.getSnapshot().transcript).toEqual({ agentId: advisor.id, messages: [advisorMessage], readOnly: true });
    await expect(inspector.cancel(advisor.id)).rejects.toThrow(/read.only/i);
  });

  test("nested discovery rejects unrelated folders, linked children and escaping stems", async () => {
    const { dir, sessionFile, artifacts } = await session();
    const parentDirectory = join(artifacts, "Anna");
    const unrelatedDirectory = join(dir, "unrelated");
    const strayDirectory = join(parentDirectory, "stray");
    await mkdir(parentDirectory);
    await mkdir(unrelatedDirectory);
    await mkdir(strayDirectory);
    await writeFile(join(artifacts, "Anna.jsonl"), header("Anna"));
    await writeFile(join(unrelatedDirectory, "Anna.Private.jsonl"), header("private") + entry({ role: "assistant", content: "private transcript" }));
    await writeFile(join(unrelatedDirectory, "__advisor.private.jsonl"), header("private-advisor"));
    await writeFile(join(strayDirectory, "Anna.Stray.jsonl"), header("stray"));
    await writeFile(join(parentDirectory, "Anna.Invalid.jsonl"), entry({ role: "assistant", content: "not a session header" }));
    await mkdir(join(parentDirectory, "Anna.Invalid"));
    await writeFile(join(parentDirectory, "Anna.Invalid", "Anna.Invalid.Hidden.jsonl"), header("hidden"));
    await symlink(join(unrelatedDirectory, "Anna.Private.jsonl"), join(parentDirectory, "Anna.LinkedFile.jsonl"));
    await writeFile(join(parentDirectory, "Anna.LinkedDirectory.jsonl"), header("linked-directory"));
    await symlink(unrelatedDirectory, join(parentDirectory, "Anna.LinkedDirectory"), "dir");
    await writeFile(join(parentDirectory, "...jsonl"), header("escaping-stem"));
    await writeFile(join(parentDirectory, "..jsonl"), header("current-directory-stem"));
    await writeFile(join(dir, "__advisor.escape.jsonl"), header("escaped-advisor"));
    await writeFile(join(parentDirectory, "__advisor.own.jsonl"), header("own-advisor"));
    await symlink(join(unrelatedDirectory, "__advisor.private.jsonl"), join(parentDirectory, "__advisor.linked.jsonl"));
    const client = new FakeClient(); client.sessionFile = sessionFile;
    const inspector = service(client); await inspector.start();
    expect(inspector.getSnapshot().agents.map(agent => agent.id).sort()).toEqual([
      "Anna", "Anna.LinkedDirectory", "advisor:Anna:__advisor.own.jsonl",
    ].sort());
    await expect(inspector.select("Anna.Private")).rejects.toThrow(/unknown/i);
    await expect(inspector.select("Anna.Invalid.Hidden")).rejects.toThrow(/unknown/i);
  });

  test("an in-flight selection cannot clear process exit or restore stale transcript data", async () => {
    const client = new FakeClient(); client.roster = [{ id: "Anna", status: "running" }];
    const inspector = service(client); await inspector.start();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    client.handler = async command => {
      if (command.type === "get_subagent_messages") await gate;
      return { success: true, data: { nextByte: 1, messages: [{ role: "assistant", content: "stale" }] } };
    };
    const selecting = inspector.select("Anna");
    client.isRunning = false;
    client.emit("exit");
    release(); await selecting;
    expect(inspector.getSnapshot()).toMatchObject({ error: "OMP process stopped" });
    expect(inspector.getSnapshot().agents[0]).toMatchObject({ status: "stopped", canSteer: false, canCancel: false });
    expect(inspector.getSnapshot().transcript).toBeUndefined();
  });

  test("nested transcript reads reject an ancestor replaced by a link after discovery", async () => {
    const { dir, sessionFile, artifacts } = await session();
    const parentDirectory = join(artifacts, "Anna");
    const nestedDirectory = join(parentDirectory, "Anna.Bob");
    const unrelatedDirectory = join(dir, "unrelated");
    await mkdir(nestedDirectory, { recursive: true });
    await mkdir(join(unrelatedDirectory, "Anna.Bob"), { recursive: true });
    await writeFile(join(artifacts, "Anna.jsonl"), header("Anna"));
    await writeFile(join(parentDirectory, "Anna.Bob.jsonl"), header("Anna.Bob"));
    await writeFile(join(nestedDirectory, "__advisor.jsonl"), header("own-advisor") + entry({ role: "assistant", content: "Own advisor" }));
    await writeFile(join(unrelatedDirectory, "Anna.Bob", "__advisor.jsonl"), header("private-advisor") + entry({ role: "assistant", content: "Private advisor" }));
    const client = new FakeClient(); client.sessionFile = sessionFile;
    const inspector = service(client); await inspector.start();
    const advisor = inspector.getSnapshot().agents.find(agent => agent.kind === "advisor")!;
    expect(advisor.parentId).toBe("Anna.Bob");
    await rm(parentDirectory, { recursive: true });
    await symlink(unrelatedDirectory, parentDirectory, "dir");
    await expect(inspector.getTranscript(advisor.id)).rejects.toThrow(/outside this session/i);
  });

  test("terminal lifecycle cannot be overwritten by an older in-flight roster response", async () => {
    const client = new FakeClient(); client.roster = [{ id: "Anna", agent: "task", status: "running" }];
    const inspector = service(client); await inspector.start();
    client.handler = async command => {
      if (command.type === "get_subagents") client.emit("event", { type: "subagent_lifecycle", payload: { id: "Anna", agent: "task", status: "completed" } });
      return { success: true, data: { subagents: client.roster } };
    };
    await inspector.refresh();
    expect(inspector.getSnapshot().agents[0].status).toBe("completed");
  });
});
