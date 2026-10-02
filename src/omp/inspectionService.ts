import { createReadStream } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import type { InspectionSnapshot, InspectorAgent, InspectorNotice } from "./inspectionTypes";
import type { OmpRpcClient } from "./rpcClient";
import type { OmpRpcEvent } from "./types";

type RecordValue = Record<string, unknown>;
interface TranscriptCache {
  messages: unknown[];
  nextByte: number;
  sessionFile?: string;
}
interface LiveMessage {
  key: number;
  identity?: string;
  message: RecordValue;
  ended: boolean;
}

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function successful(response: OmpRpcEvent, command: string): RecordValue {
  if (response.success === false) throw new Error(String(response.error ?? `${command} failed`));
  return record(response.data);
}
function isAdvisorName(name: string): boolean {
  // OMP reserves __advisor and uses a dot before named advisor slugs. A
  // __advisor-2.jsonl belongs to an ordinary task whose requested id collided.
  return name === "__advisor.jsonl" || /^__advisor\.[^/\\]+\.jsonl$/.test(name);
}
function sessionDirectory(file: string | undefined): string | undefined {
  return file && path.isAbsolute(file) && file.endsWith(".jsonl") ? file.slice(0, -6) : undefined;
}

/** Per-primary-session roster and full transcripts. No VS Code or global history access. */
export class InspectionService {
  private readonly agents = new Map<string, InspectorAgent>();
  private readonly notices: InspectorNotice[] = [];
  private readonly transcripts = new Map<string, TranscriptCache>();
  private readonly transcriptRequests = new Map<string, Promise<unknown[]>>();
  private readonly diskFiles = new Map<string, { file: string; directory: string }>();
  private readonly revisions = new Map<string, number>();
  private readonly liveMessages = new Map<string, LiveMessage[]>();
  private nextLiveKey = 0;
  private revision = 0;
  private sessionFile?: string;
  private synchronized = false;
  private selectedId?: string;
  private error?: string;
  private started = false;
  private disposed = false;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<void>;

  constructor(
    private readonly client: OmpRpcClient,
    private readonly onSnapshot: (snapshot: InspectionSnapshot) => void,
    private readonly initialEvents: OmpRpcEvent[] = [],
  ) {}

  getSnapshot(): InspectionSnapshot {
    const selected = this.selectedId ? this.agents.get(this.selectedId) : undefined;
    const cache = selected ? this.transcripts.get(selected.id) : undefined;
    return {
      agents: [...this.agents.values()].map((agent) => ({ ...agent })),
      notices: this.notices.map((notice) => ({ ...notice })),
      selectedId: this.selectedId,
      transcript:
        selected && (cache || this.liveMessages.has(selected.id))
          ? {
              agentId: selected.id,
              messages: this.visibleMessages(selected.id),
              readOnly: selected.kind === "advisor",
            }
          : undefined,
      error: this.error,
    };
  }

  private publish(): void {
    if (!this.disposed) this.onSnapshot(this.getSnapshot());
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error("Inspection service disposed");
    if (this.started) return this.refresh();
    this.started = true;
    this.client.on("event", this.onEvent);
    this.client.on("exit", this.onExit);
    for (const event of this.initialEvents) this.onEvent(event);
    try {
      successful(
        await this.client.request({ type: "set_subagent_subscription", level: "events" }),
        "set_subagent_subscription",
      );
    } catch (error) {
      this.addNotice("inspector", `Subagent event subscription unavailable: ${errorText(error)}`);
    }
    await this.refresh();
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.refreshing = this.refreshOnce()
      .catch((error) => {
        this.error = errorText(error);
        this.publish();
      })
      .finally(() => {
        this.refreshing = undefined;
        this.schedule();
      });
    return this.refreshing;
  }

  private schedule(delay?: number): void {
    if (this.disposed || !this.started || this.timer || !this.client.isRunning) return;
    const active = [...this.agents.values()].some((agent) => agent.canCancel);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.refresh();
      },
      delay ?? (active || this.selectedId ? 1500 : 5000),
    );
    this.timer.unref?.();
  }

  private async refreshOnce(): Promise<void> {
    const state = await this.client.getState();
    if (this.disposed) return;
    const currentFile = text(state.sessionFile);
    if (this.synchronized && currentFile !== this.sessionFile) {
      this.generation++;
      this.sessionFile = currentFile;
      this.agents.clear();
      this.transcripts.clear();
      this.transcriptRequests.clear();
      this.liveMessages.clear();
      this.diskFiles.clear();
      this.revisions.clear();
      this.notices.length = 0;
      this.selectedId = undefined;
    }
    this.synchronized = true;
    this.sessionFile = currentFile;
    const generation = this.generation;
    const atRevision = this.revision;
    const roster = successful(
      await this.client.request({ type: "get_subagents" }),
      "get_subagents",
    );
    if (this.disposed || generation !== this.generation) return;
    const liveIds = new Set<string>();
    for (const raw of Array.isArray(roster.subagents) ? roster.subagents : []) {
      const value = record(raw);
      const id = text(value.id);
      if (!id) continue;
      liveIds.add(id);
      if ((this.revisions.get(id) ?? 0) > atRevision) continue;
      this.upsertWorker(value);
    }
    for (const agent of this.agents.values()) {
      if (
        agent.kind === "worker" &&
        agent.canCancel &&
        !liveIds.has(agent.id) &&
        (this.revisions.get(agent.id) ?? 0) <= atRevision
      ) {
        agent.status = "finished";
        agent.canSteer = false;
        agent.canCancel = false;
      }
    }
    await this.discoverSavedAgents();
    if (this.disposed || generation !== this.generation) return;
    if (this.selectedId) await this.getTranscript(this.selectedId);
    if (this.disposed || generation !== this.generation) return;
    this.error = undefined;
    this.publish();
  }

  private upsertWorker(value: RecordValue): void {
    const progress = record(value.progress);
    const id = text(value.id) ?? text(progress.id);
    if (!id) return;
    const existing = this.agents.get(id);
    const wireStatus = text(value.status) ?? text(progress.status) ?? existing?.status ?? "pending";
    const status = wireStatus === "started" ? "running" : wireStatus;
    const running = status === "running" || status === "pending";
    const modelValue =
      value.model ??
      progress.resolvedModelIdentity ??
      progress.model ??
      progress.resolvedModel ??
      progress.modelOverride;
    const modelRecord = record(modelValue);
    const model =
      text(modelValue) ??
      (text(modelRecord.id)
        ? `${text(modelRecord.provider) ? `${modelRecord.provider}/` : ""}${modelRecord.id}`
        : undefined);
    this.agents.set(id, {
      id,
      name:
        text(value.name) ??
        (text(value.agent)
          ? `${value.agent} · ${id}${text(value.description) ? ` — ${value.description}` : ""}`
          : (existing?.name ?? id)),
      kind: "worker",
      parentId:
        text(value.parentId) ??
        (id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : existing?.parentId),
      status,
      model: model ?? existing?.model,
      sessionFile: text(value.sessionFile) ?? existing?.sessionFile,
      canSteer: running,
      canCancel: running,
    });
  }

  private addNotice(source: string, message: string, timestamp = Date.now()): void {
    this.notices.push({ source, message, timestamp });
  }

  private onEvent = (event: OmpRpcEvent): void => {
    if (this.disposed) return;
    if (event.type === "notice") {
      if (text(event.message))
        this.addNotice(
          text(event.source) ?? "omp",
          String(event.message),
          typeof event.timestamp === "number" ? event.timestamp : Date.now(),
        );
    } else if (event.type === "extension_ui_request" && event.method === "notify") {
      if (text(event.message)) this.addNotice("extension", String(event.message));
    } else if (event.type === "advisor_yielded") {
      this.addNotice("advisor", "Advisor completed a review turn");
      this.schedule(100);
    } else if (event.type === "subagent_lifecycle" || event.type === "subagent_progress") {
      const payload = record(event.payload);
      const id = text(payload.id) ?? text(record(payload.progress).id);
      if (!id) return;
      if (
        event.type === "subagent_progress" &&
        this.agents.has(id) &&
        !this.agents.get(id)?.canCancel
      )
        return;
      this.upsertWorker(payload);
      this.revisions.set(id, ++this.revision);
      this.schedule(100);
    } else if (event.type === "subagent_event") {
      const payload = record(event.payload);
      const nested = record(payload.event);
      if (nested.type === "notice" && text(nested.message)) {
        this.addNotice(
          `${text(payload.id) ?? "worker"}/${text(nested.source) ?? "omp"}`,
          String(nested.message),
        );
      } else if (nested.type === "advisor_yielded") {
        this.addNotice(
          `${text(payload.id) ?? "worker"}/advisor`,
          "Advisor completed a review turn",
        );
      } else if (
        ["message_start", "message_update", "message_end"].includes(String(nested.type)) &&
        text(payload.id)
      ) {
        this.updateLiveMessage(String(payload.id), nested);
      }
    } else {
      return;
    }
    this.publish();
  };

  private onExit = (): void => {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.error = "OMP process stopped";
    for (const agent of this.agents.values()) {
      agent.canSteer = false;
      agent.canCancel = false;
      if (agent.status === "running" || agent.status === "pending") agent.status = "stopped";
    }
    this.publish();
  };

  async select(id: string): Promise<void> {
    this.requireAgent(id);
    const generation = this.generation;
    this.selectedId = id;
    this.publish();
    try {
      await this.getTranscript(id);
      if (generation !== this.generation) return;
      this.error = undefined;
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = errorText(error);
      throw error;
    } finally {
      this.publish();
    }
  }

  async steer(id: string, message: string): Promise<void> {
    const agent = this.requireAgent(id);
    if (agent.kind === "advisor") throw new Error("Advisor transcripts are read-only");
    if (!agent.canSteer) throw new Error("Only a running worker can be steered");
    if (!message.trim()) throw new Error("Steering message must not be empty");
    successful(
      await this.client.request({ type: "steer_subagent", subagentId: id, message }, 30_000),
      "steer_subagent",
    );
    await this.refresh();
  }

  async cancel(id: string): Promise<void> {
    const agent = this.requireAgent(id);
    if (agent.kind === "advisor") throw new Error("Advisor transcripts are read-only");
    if (!agent.canCancel) throw new Error("Only a running worker can be cancelled");
    successful(
      await this.client.request({ type: "cancel_subagent", subagentId: id }, 30_000),
      "cancel_subagent",
    );
    await this.refresh();
  }

  private requireAgent(id: string): InspectorAgent {
    if (this.disposed) throw new Error("Inspection service disposed");
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    return agent;
  }

  async getTranscript(id: string): Promise<unknown[]> {
    const agent = this.requireAgent(id);
    const current = this.transcriptRequests.get(id);
    if (current) return current;
    const generation = this.generation;
    const request = this.readTranscript(agent)
      .then((cache) => {
        if (this.disposed || generation !== this.generation) return [];
        this.transcripts.set(id, cache);
        this.reconcileLiveMessages(id);
        const lastAssistant = [...cache.messages]
          .reverse()
          .map(record)
          .find((message) => message.role === "assistant" && text(message.model));
        const currentAgent = this.agents.get(id);
        if (lastAssistant && currentAgent)
          currentAgent.model = text(lastAssistant.provider)
            ? `${lastAssistant.provider}/${lastAssistant.model}`
            : String(lastAssistant.model);
        return this.visibleMessages(id);
      })
      .finally(() => {
        if (this.transcriptRequests.get(id) === request) this.transcriptRequests.delete(id);
      });
    this.transcriptRequests.set(id, request);
    return request;
  }

  private messageIdentity(message: RecordValue): string | undefined {
    const identity = text(message.id) ?? text(message.toolCallId);
    if (identity) return `${message.role}:${identity}`;
    if (typeof message.timestamp === "number" || typeof message.timestamp === "string")
      return `${message.role}:${message.timestamp}`;
    return undefined;
  }

  private updateLiveMessage(id: string, event: RecordValue): void {
    if (!this.agents.has(id)) this.upsertWorker({ id, status: "running" });
    const eventMessage = record(event.message);
    const partial = record(record(event.assistantMessageEvent).partial);
    const message = Object.keys(eventMessage).length > 1 ? eventMessage : partial;
    if (!text(message.role)) return;
    const messages = this.liveMessages.get(id) ?? [];
    const identity = this.messageIdentity(message);
    let item = identity ? messages.find((value) => value.identity === identity) : undefined;
    if (!item && event.type !== "message_start")
      item = [...messages]
        .reverse()
        .find((value) => !value.ended && value.message.role === message.role);
    if (!item) {
      item = { key: ++this.nextLiveKey, identity, message, ended: false };
      messages.push(item);
    }
    item.message = message;
    item.identity ??= identity;
    item.ended = event.type === "message_end";
    this.liveMessages.set(id, messages);
    this.reconcileLiveMessages(id);
  }

  private reconcileLiveMessages(id: string): void {
    const live = this.liveMessages.get(id);
    if (!live) return;
    const persisted = this.transcripts.get(id)?.messages ?? [];
    const identities = new Set(
      persisted.map((message) => this.messageIdentity(record(message))).filter(Boolean),
    );
    const pending = live.filter((item) =>
      item.identity
        ? !identities.has(item.identity)
        : !persisted.some((message) => JSON.stringify(message) === JSON.stringify(item.message)),
    );
    if (pending.length) this.liveMessages.set(id, pending);
    else this.liveMessages.delete(id);
  }

  private visibleMessages(id: string): unknown[] {
    const finalized = this.transcripts.get(id)?.messages ?? [];
    const live = this.liveMessages.get(id) ?? [];
    const agent = this.agents.get(id);
    return [
      ...finalized,
      ...live.map((item) =>
        item.ended || !agent?.canCancel ? item.message : { ...item.message, streaming: true },
      ),
    ];
  }

  private async readTranscript(agent: InspectorAgent): Promise<TranscriptCache> {
    const previous = this.transcripts.get(agent.id) ?? { messages: [], nextByte: 0 };
    if (agent.kind === "worker") {
      try {
        const data = successful(
          await this.client.request(
            { type: "get_subagent_messages", subagentId: agent.id, fromByte: previous.nextByte },
            30_000,
          ),
          "get_subagent_messages",
        );
        const messages = Array.isArray(data.messages) ? data.messages : [];
        const nextByte =
          typeof data.nextByte === "number" &&
          Number.isSafeInteger(data.nextByte) &&
          data.nextByte >= 0
            ? data.nextByte
            : undefined;
        if (nextByte === undefined)
          throw new Error("OMP returned an invalid subagent transcript cursor");
        const reset =
          data.reset === true ||
          (text(data.sessionFile) !== undefined &&
            previous.sessionFile !== undefined &&
            text(data.sessionFile) !== previous.sessionFile);
        return {
          messages: reset ? [...messages] : [...previous.messages, ...messages],
          nextByte,
          sessionFile: text(data.sessionFile),
        };
      } catch (error) {
        // On resume OMP's in-memory child registry is empty. Only a verified
        // file discovered in this primary session's own directory may fall back.
        if (!this.diskFiles.has(agent.id)) throw error;
      }
    }
    const owned = this.diskFiles.get(agent.id);
    if (!owned || !(await this.isOwnedFile(owned.file, owned.directory)))
      throw new Error("Transcript file is outside this session");
    const stat = await fs.stat(owned.file);
    const reset = previous.sessionFile !== owned.file || previous.nextByte > stat.size;
    const from = reset ? 0 : previous.nextByte;
    const messages = reset ? [] : [...previous.messages];
    let nextByte = from;
    let lineParts: Buffer[] = [];
    let lineBytes = 0;
    if (from < stat.size) {
      const stream = createReadStream(owned.file, { start: from, end: stat.size - 1 });
      for await (const chunk of stream) {
        const bytes = chunk as Buffer;
        let start = 0;
        for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
          const tail = bytes.subarray(start, end);
          const line = (
            lineParts.length ? Buffer.concat([...lineParts, tail], lineBytes + tail.length) : tail
          )
            .toString("utf8")
            .trim();
          if (line) {
            const entry = record(JSON.parse(line));
            if (entry.type === "message" && entry.message !== undefined)
              messages.push(entry.message);
          }
          nextByte += lineBytes + end - start + 1;
          lineParts = [];
          lineBytes = 0;
          start = end + 1;
        }
        if (start < bytes.length) {
          lineParts.push(bytes.subarray(start));
          lineBytes += bytes.length - start;
        }
      }
    }
    return { messages, nextByte, sessionFile: owned.file };
  }

  private async isOwnedFile(file: string, directory: string): Promise<boolean> {
    try {
      const rootDirectory = sessionDirectory(this.sessionFile);
      if (!rootDirectory) return false;
      const relative = path.relative(rootDirectory, directory);
      if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) return false;
      let ancestor = rootDirectory;
      if (!(await fs.lstat(ancestor)).isDirectory()) return false;
      // Recheck the whole owned path when reading: an ancestor may have been
      // replaced by a link since the initial saved-agent discovery.
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        ancestor = path.join(ancestor, segment);
        if (!(await fs.lstat(ancestor)).isDirectory()) return false;
      }
      if (!(await fs.lstat(file)).isFile()) return false;
      const [realRoot, realDirectory, realFile] = await Promise.all([
        fs.realpath(rootDirectory),
        fs.realpath(directory),
        fs.realpath(file),
      ]);
      const realRelative = path.relative(realRoot, realDirectory);
      return (
        path.dirname(realFile) === realDirectory &&
        !path.isAbsolute(realRelative) &&
        !realRelative.split(path.sep).includes("..")
      );
    } catch {
      return false;
    }
  }

  private async validSessionHeader(file: string): Promise<boolean> {
    const handle = await fs.open(file, "r");
    try {
      const bytes = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      let start = 0;
      let end = bytes.subarray(0, bytesRead).indexOf(10);
      if (end < 0) return false;
      let header = record(
        JSON.parse(
          bytes
            .subarray(0, end)
            .toString("utf8")
            .replace(/^\uFEFF/, ""),
        ),
      );
      // OMP v3 files can begin with an editor-visible title prelude before
      // the actual session header. Message-first files remain ineligible.
      if (header.type === "title") {
        start = end + 1;
        end = bytes.subarray(0, bytesRead).indexOf(10, start);
        if (end < 0) return false;
        header = record(JSON.parse(bytes.subarray(start, end).toString("utf8")));
      }
      return header.type === "session" && Boolean(text(header.id));
    } catch {
      return false;
    } finally {
      await handle.close();
    }
  }

  private async discoverSavedAgents(): Promise<void> {
    const directory = sessionDirectory(this.sessionFile);
    if (!directory) return;
    await this.discoverSessionDirectory(directory, undefined, this.generation, new Set());
  }

  private async discoverSessionDirectory(
    directory: string,
    parentId: string | undefined,
    generation: number,
    visited: Set<string>,
    parentDirectory?: string,
  ): Promise<void> {
    if (this.disposed || generation !== this.generation) return;
    let dirents: string[];
    try {
      if (!(await fs.lstat(directory)).isDirectory()) return;
      const realDirectory = await fs.realpath(directory);
      // A worker owns only its session-file stem directly beneath its owner's
      // directory. Never follow directory links or walk arbitrary descendants.
      if (parentDirectory && path.dirname(realDirectory) !== (await fs.realpath(parentDirectory)))
        return;
      if (visited.has(realDirectory)) return;
      visited.add(realDirectory);
      dirents = await fs.readdir(directory);
    } catch (error) {
      if (record(error).code === "ENOENT") return;
      throw error;
    }
    const workers: { id: string; file: string }[] = [];
    for (const name of dirents) {
      if (this.disposed || generation !== this.generation) return;
      if (!name.endsWith(".jsonl") || isAdvisorName(name)) continue;
      const id = name.slice(0, -6);
      if (!id || id === "." || id === "..") continue;
      const file = path.join(directory, name);
      if (!(await this.isOwnedFile(file, directory)) || !(await this.validSessionHeader(file)))
        continue;
      if (this.disposed || generation !== this.generation) return;
      this.diskFiles.set(id, { file, directory });
      if (!this.agents.has(id))
        this.upsertWorker({ id, parentId, status: "recorded", sessionFile: file });
      else this.agents.get(id)!.sessionFile ??= file;
      this.agents.get(id)!.parentId = parentId;
      workers.push({ id, file });
    }
    await this.discoverAdvisors(directory, parentId, generation);
    for (const worker of workers) {
      const childDirectory = sessionDirectory(worker.file)!;
      await this.discoverSessionDirectory(
        childDirectory,
        worker.id,
        generation,
        visited,
        directory,
      );
    }
  }

  private async discoverAdvisors(
    directory: string,
    parentId: string | undefined,
    generation: number,
  ): Promise<void> {
    let names: string[];
    try {
      if (!(await fs.lstat(directory)).isDirectory()) return;
      names = await fs.readdir(directory);
    } catch (error) {
      if (record(error).code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      if (this.disposed || generation !== this.generation) return;
      if (!isAdvisorName(name)) continue;
      const file = path.join(directory, name);
      if (!(await this.isOwnedFile(file, directory)) || !(await this.validSessionHeader(file)))
        continue;
      if (this.disposed || generation !== this.generation) return;
      const id = `advisor:${parentId ?? "primary"}:${name}`;
      this.diskFiles.set(id, { file, directory });
      this.agents.set(id, {
        id,
        name: name === "__advisor.jsonl" ? "Advisor" : `Advisor ${name.slice(10, -6)}`,
        kind: "advisor",
        parentId,
        status: "recorded",
        sessionFile: file,
        model: this.agents.get(id)?.model,
        canSteer: false,
        canCancel: false,
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.client.off("event", this.onEvent);
    this.client.off("exit", this.onExit);
  }
}
