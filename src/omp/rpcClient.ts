import { type ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import { RpcFrameDecoder } from "./rpcFrames";
import type { AssistantMessageEvent, OmpClientOptions, OmpRpcEvent } from "./types";

export interface OmpRpcClientEvents {
  ready: [];
  event: [OmpRpcEvent];
  messageUpdate: [AssistantMessageEvent];
  stderr: [string];
  exit: [number | null];
  error: [Error];
}

interface PendingRequest {
  command: string;
  resolve: (event: OmpRpcEvent) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OmpRpcClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private ready = false;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly decoder = new RpcFrameDecoder();

  constructor(private readonly options: OmpClientOptions) {
    super();
  }

  get isReady(): boolean {
    return this.ready;
  }

  get isRunning(): boolean {
    return Boolean(this.proc && !this.proc.killed && this.proc.exitCode === null && !this.stopping);
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this.startProcess();
    try {
      await this.starting;
    } catch (error) {
      await this.dispose();
      throw error;
    } finally {
      this.starting = undefined;
    }
  }

  private async startProcess(): Promise<void> {
    this.decoder.reset();
    const rpcMode = (this.options as OmpClientOptions & { rpcMode?: string }).rpcMode || "rpc-ui";

    const args = ["--mode", rpcMode, "--cwd", this.options.cwd];
    if (this.options.profile) args.push("--profile", this.options.profile);
    if (this.options.model) {
      args.push("--model", this.options.model);
    }
    if (this.options.thinking) {
      args.push("--thinking", this.options.thinking);
    }
    if (this.options.approvalMode) {
      args.push("--approval-mode", this.options.approvalMode);
    }
    if (this.options.autoApprove) {
      args.push("--auto-approve");
    }
    if (this.options.resumeSessionId) {
      args.push("--resume", this.options.resumeSessionId);
    } else if (this.options.continueLastSession) {
      args.push("--continue");
    }
    if (this.options.titleExtensionPath) {
      args.push("--extension", this.options.titleExtensionPath);
    }
    if (this.options.extraArgs?.length) {
      args.push(...this.options.extraArgs);
    }

    // Opt into omp setTitle / title UI events so the chat host can show
    // agent-generated session names on tabs. Generation itself is restored by
    // the optional title extension above (RPC disables it by default).
    const env = {
      ...process.env,
      PI_RPC_EMIT_TITLE: process.env.PI_RPC_EMIT_TITLE || "1",
    };

    this.proc = spawn(this.options.ompPath, args, {
      cwd: this.options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const proc = this.proc;
    const onError = (err: Error) => {
      this.ready = false;
      this.rejectPending(err);
      // EventEmitter's special `error` event must never crash a host that has
      // only subscribed to stderr / exit. Startup still rejects independently.
      if (this.listenerCount("error")) this.emit("error", err);
      else this.emit("stderr", err.message);
    };
    proc.on("error", onError);
    proc.stdin.on("error", onError);

    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.ready = false;
      this.rejectPending(new Error(`omp exited (code ${code ?? "null"})`));
      this.decoder.reset();
      this.emit("exit", code);
    });

    const readyPromise = this.waitForReady(20_000);
    // waitForReady has installed its error listener before a spawn failure can fire.
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      if (this.proc !== proc || this.stopping) return;
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let event: OmpRpcEvent;
      try {
        if (Buffer.byteLength(line, "utf8") + 1 > 1024 * 1024) {
          throw new Error("OMP RPC physical frame exceeded the transport limit");
        }
        const decoded = this.decoder.push(JSON.parse(trimmed));
        if (!decoded) return;
        event = decoded;
      } catch (error) {
        this.decoder.reset();
        const err = new Error(
          `Invalid OMP RPC frame: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.rejectPending(err);
        this.emit("stderr", err.message);
        return;
      }

      if (event.type === "ready") {
        const versions = event.supportedProtocolVersions;
        const negotiation =
          Array.isArray(versions) && versions.includes(2)
            ? this.request({ type: "negotiate_protocol", protocolVersion: 2 })
            : Promise.resolve(undefined);
        void negotiation
          .then(async (response) => {
            if (this.proc !== proc || this.stopping) return;
            if (response?.success === false)
              throw new Error(String(response.error ?? "Protocol negotiation failed"));
            // RPC UI exposes structured multi-question dialogs only when the host
            // opts in. Legacy runtimes can retain their ordinary select/input UI.
            const ask = await this.request({ type: "set_ask_dialog", enabled: true });
            if (ask.success === false && !/unknown|unsupported/i.test(String(ask.error))) {
              throw new Error(String(ask.error ?? "Could not enable OMP questions"));
            }
            if (this.proc !== proc || this.stopping) return;
            this.ready = true;
            this.emit("ready");
          })
          .catch(onError);
      }

      if (event.type === "response") {
        this.resolveResponse(event);
      }

      if (event.type === "message_update") {
        const assistantEvent =
          (event.assistantMessageEvent as AssistantMessageEvent | undefined) ??
          (event.event as AssistantMessageEvent | undefined);
        if (assistantEvent) {
          this.emit("messageUpdate", assistantEvent);
        }
      }

      this.emit("event", event);
    });
    rl.on("close", () => {
      if (this.proc !== proc) return;
      try {
        this.decoder.finish();
      } catch (error) {
        this.rejectPending(error instanceof Error ? error : new Error(String(error)));
      }
    });

    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) {
        this.emit("stderr", text);
      }
    });

    await readyPromise;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private waitForReady(timeoutMs: number): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`omp exited before ready (code ${code ?? "null"})`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for omp RPC ready"));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.off("ready", onReady);
        this.off("error", onError);
        this.off("exit", onExit);
      };

      this.on("ready", onReady);
      this.on("error", onError);
      this.on("exit", onExit);
    });
  }

  send(command: Record<string, unknown>): void {
    if (!this.proc?.stdin.writable || this.stopping) {
      throw new Error("omp RPC process is not running");
    }
    const json = JSON.stringify(command);
    if (Buffer.byteLength(json, "utf8") + 1 > 1024 * 1024)
      throw new Error("OMP RPC command exceeded the transport limit");
    this.proc.stdin.write(`${json}\n`);
  }

  /**
   * omp sometimes omits `id` on error responses (e.g. transport-limit /
   * unknown-command). Fall back to matching the oldest pending request with
   * the same command name so callers fail fast instead of timing out.
   */
  private resolveResponse(event: OmpRpcEvent): void {
    if (event.id != null) {
      const id = String(event.id);
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(event);
        return;
      }
      // A stale or unknown ID must never complete another request.
      return;
    }

    const command = typeof event.command === "string" ? event.command : undefined;
    if (!command || event.success !== false) {
      return;
    }
    for (const [id, pending] of this.pending) {
      if (pending.command !== command) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve(event);
      return;
    }
  }

  request(command: Record<string, unknown>, timeoutMs = 10_000): Promise<OmpRpcEvent> {
    if (!this.proc?.stdin.writable) {
      return Promise.reject(new Error("omp RPC process is not running"));
    }
    const id = String(this.nextRequestId++);
    const commandName = String(command.type ?? "unknown");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${commandName} response`));
      }, timeoutMs);
      this.pending.set(id, { command: commandName, resolve, reject, timer });
      try {
        this.send({ ...command, id });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async getState(): Promise<Record<string, unknown>> {
    const response = await this.request({ type: "get_state" });
    if (response.success === false) {
      throw new Error(String(response.error ?? "get_state failed"));
    }
    return (response.data as Record<string, unknown>) ?? {};
  }

  /**
   * Prefer paged history when omp supports it; otherwise use monolithic
   * get_messages. Large sessions on older omp can still exceed the 1 MiB
   * frame limit — callers should fall back to reading sessionFile.
   */
  async getMessages(): Promise<unknown[]> {
    const paged = await this.request({ type: "get_messages_page", limit: 64 }, 30_000);
    if (paged.success !== false) {
      const all: unknown[] = [];
      let data = (paged.data as Record<string, unknown> | undefined) ?? {};
      let messages = Array.isArray(data.messages) ? data.messages : [];
      all.push(...messages);
      let cursor = data.nextCursor;
      const seenCursors = new Set<string>();
      while (typeof cursor === "string" && cursor) {
        if (seenCursors.has(cursor))
          throw new Error("OMP returned a repeated messages page cursor");
        seenCursors.add(cursor);
        const next = await this.request({ type: "get_messages_page", cursor, limit: 64 }, 30_000);
        if (next.success === false) {
          throw new Error(String(next.error ?? "get_messages_page failed"));
        }
        data = (next.data as Record<string, unknown> | undefined) ?? {};
        messages = Array.isArray(data.messages) ? data.messages : [];
        all.push(...messages);
        cursor = data.nextCursor;
      }
      return all;
    }

    const pageError = String(paged.error ?? "get_messages_page failed");
    if (!/unknown command/i.test(pageError)) {
      throw new Error(pageError);
    }

    const response = await this.request({ type: "get_messages" }, 30_000);
    if (response.success === false) {
      throw new Error(String(response.error ?? "get_messages failed"));
    }
    const data = (response.data as Record<string, unknown> | undefined) ?? {};
    return Array.isArray(data.messages) ? data.messages : [];
  }

  prompt(message: string): void {
    this.send({ type: "prompt", message });
  }

  /** Answer an omp `extension_ui_request` (confirm / select / input / editor). */
  respondExtensionUi(
    id: string,
    response:
      | { confirmed: boolean }
      | { value: string }
      | { cancelled: true; timedOut?: boolean }
      | { answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }> },
  ): void {
    this.send({ type: "extension_ui_response", id, ...response });
  }

  abort(): void {
    try {
      this.send({ type: "abort" });
    } catch {
      // ignore if process already gone
    }
  }

  async dispose(): Promise<void> {
    if (this.stopping) return this.stopping;
    const proc = this.proc;
    this.ready = false;
    this.rejectPending(new Error("OMP RPC client disposed"));
    if (!proc) return;
    this.stopping = new Promise<void>((resolve) => {
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        proc.off("exit", finish);
        resolve();
      };
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        forceTimer = setTimeout(() => {
          proc.kill("SIGKILL");
          finish();
        }, 800);
      }, 800);
      proc.once("exit", finish);
      // OMP's input EOF drains RPC work and performs session shutdown.
      // There is no `shutdown` RPC command.
      if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) finish();
      else proc.stdin.end();
    });
    try {
      await this.stopping;
    } finally {
      if (this.proc === proc) this.proc = undefined;
      this.decoder.reset();
      this.stopping = undefined;
    }
  }
}
