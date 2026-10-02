/**
 * Bounded live OMP RPC test. Run with Bun; no dependency installation is needed.
 * Example (WSL): bun scripts/smoke-omp.ts --omp=/home/you/.bun/bin/omp
 *   --workspace=/mnt/c/.../work/omp-smoke --output=/mnt/c/.../work/verification/live
 * Uses only sessions it creates. Logs omit prompts, message bodies, system prompts,
 * tools schemas, credentials, and private existing history. OMP config is not edited.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readFile, readdir, stat, writeFile, appendFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";

type Frame = Record<string, any>;
const options = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, "").split("=");
  return [key, value.join("=") || "true"];
}));
const workspace = resolve(options.workspace || "work/omp-smoke");
const output = resolve(options.output || "work/verification/live");
const omp = options.omp || "omp";
const scenario = options.scenario || "worker";
const timeoutMs = Number(options.timeout || 120_000);
const followMs = Math.min(Number(options["follow-ms"] || 0), 60_000);
const allowedScenarios = new Set(["handshake", "worker", "interaction", "prewalk", "cancel"]);
if (!allowedScenarios.has(scenario)) throw new Error("Unknown smoke scenario");

function safeText(text: string): string {
  return text.replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/(authorization\s*[:=]\s*|bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|key|code|secret)=)[^&\s]+/gi, "$1[REDACTED]");
}

function sanitized(value: any, key = ""): any {
  if (/^(systemPrompt|dumpTools|apiKey|accessToken|refreshToken|authorization|headers|request|accountAccess)$/i.test(key)) return "[OMITTED]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (["text", "thinking", "task", "assignment", "message", "arguments", "prefill", "delta", "code", "content"].includes(key)) return { characters: value.length };
    return safeText(value).slice(0, 800);
  }
  if (Array.isArray(value)) return value.map((item) => sanitized(item, key));
  if (typeof value === "object") {
    if (key === "model") return { id: value.id, provider: value.provider, name: value.name };
    if (Array.isArray(value.commands)) return { commands: value.commands.filter((command: Frame) => ["advisor", "prewalk", "plan"].includes(command.name)).map((command: Frame) => ({ name: command.name, source: command.source, subcommands: command.subcommands?.map((subcommand: Frame) => subcommand.name) })) };
    if (value.role && value.content) {
      return { role: value.role, content: Array.isArray(value.content) ? value.content.map((part: any) => ({ type: part.type, name: part.name, id: part.id, characters: (part.text || part.thinking || "").length, argumentKeys: part.arguments && Object.keys(part.arguments) })) : { characters: String(value.content).length }, toolName: value.toolName, toolCallId: value.toolCallId, stopReason: value.stopReason, isError: value.isError, synthetic: value.synthetic, attribution: value.attribution };
    }
    return Object.fromEntries(Object.entries(value).map(([k, item]) => [k, sanitized(item, k)]));
  }
  return value;
}

class RpcClient {
  process: ChildProcessWithoutNullStreams;
  frames: Frame[] = [];
  ready: Promise<Frame>;
  private serial = 0;
  private waiters: Array<{ predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private chunks?: { id: string; count: number; bytes: number; parts: Buffer[]; next: number };
  private writes = Promise.resolve();
  private closed = false;
  private logPath: string;
  uiMethods = new Set<string>();
  childFiles = new Map<string, string>();
  eventTypes = new Set<string>();
  protocolNoise = 0;
  stderrLines = 0;
  observer?: (frame: Frame) => void;
  readonly stderrPath: string;

  constructor(private name: string, args: string[]) {
    this.logPath = join(output, `${runId}-${name}.protocol.ndjson`);
    this.stderrPath = join(output, `${runId}-${name}.stderr.ndjson`);
    this.writes = Promise.all([writeFile(this.logPath, ""), writeFile(this.stderrPath, "")]).then(() => undefined);
    this.process = spawn(omp, args, { cwd: workspace, stdio: "pipe", detached: process.platform !== "win32", env: { ...process.env, NO_COLOR: "1" } });
    this.ready = this.wait((frame) => frame.type === "ready", 25_000);
    const stdout = createInterface({ input: this.process.stdout });
    stdout.on("line", (line) => {
      try {
        const parsed = JSON.parse(line);
        let frame = parsed;
        if (parsed.type === "rpc_chunk") {
          if (!Number.isSafeInteger(parsed.byteLength) || parsed.byteLength > 64 * 1024 * 1024 || parsed.count > 256) throw new Error("Invalid chunk limit");
          if (!this.chunks) this.chunks = { id: parsed.chunkId, count: parsed.count, bytes: parsed.byteLength, parts: [], next: 0 };
          const pending = this.chunks;
          if (pending.id !== parsed.chunkId || pending.next !== parsed.index || pending.count !== parsed.count) throw new Error("Invalid chunk sequence");
          pending.parts.push(Buffer.from(parsed.data, "base64")); pending.next++;
          if (pending.next !== pending.count) return;
          const payload = Buffer.concat(pending.parts);
          if (payload.length !== pending.bytes) throw new Error("Invalid chunk size");
          this.chunks = undefined; frame = JSON.parse(payload.toString("utf8"));
        }
        this.receive(frame);
      } catch (error) {
        this.protocolNoise++;
        this.log("stdout", { unparsedLineBytes: Buffer.byteLength(line), error: safeText(String(error)) });
      }
    });
    const stderr = createInterface({ input: this.process.stderr });
    stderr.on("line", (line) => {
      this.stderrLines++;
      // Only local smoke diagnostics are persisted, never arbitrary provider dumps.
      this.writes = this.writes.then(() => appendFile(this.stderrPath, JSON.stringify({ at: Date.now(), bytes: Buffer.byteLength(line), classification: /error|fail|warn/i.test(line) ? "diagnostic" : "other" }) + "\n"));
    });
    this.process.on("error", (error) => this.fail(new Error(safeText(error.message))));
    this.process.on("exit", (code, signal) => { this.closed = true; this.fail(new Error(`OMP exited (${code}, ${signal})`)); });
  }

  log(direction: string, frame: Frame): void {
    const line = JSON.stringify({ at: Date.now(), direction, frame: sanitized(frame) }) + "\n";
    this.writes = this.writes.then(() => appendFile(this.logPath, line));
  }

  private receive(frame: Frame): void {
    this.frames.push(frame); this.eventTypes.add(frame.type); this.log("in", frame);
    const payload = frame.payload;
    if (payload?.sessionFile && (payload.id || payload.progress?.id)) this.childFiles.set(payload.id || payload.progress.id, payload.sessionFile);
    for (const waiter of [...this.waiters]) if (waiter.predicate(frame)) {
      clearTimeout(waiter.timer); this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(frame);
    }
    if (frame.type === "extension_ui_request") {
      this.uiMethods.add(frame.method);
      if (frame.method === "ask" && frame.questions.every((question: Frame) => /smoke|color/i.test(question.question))) this.send({ type: "extension_ui_response", id: frame.id, answers: frame.questions.map((question: Frame) => ({ id: question.id, selectedOptions: [question.options[question.recommended ?? 0].label] })) });
      else if (frame.method === "select" && /^Allow tool: write\nPath: (?:rpc-ui-smoke|prewalk-smoke)\.txt\n/.test(frame.title)) this.send({ type: "extension_ui_response", id: frame.id, value: "Approve" });
      else if (["ask", "select", "confirm", "input", "editor"].includes(frame.method)) this.send({ type: "extension_ui_response", id: frame.id, cancelled: true });
    }
    this.observer?.(frame);
  }

  private fail(error: Error): void {
    for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
  }

  wait(predicate: (frame: Frame) => boolean, timeout = timeoutMs, since = 0): Promise<Frame> {
    const existing = this.frames.slice(since).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveWait, reject) => {
      const waiter = { predicate, resolve: resolveWait, reject, timer: setTimeout(() => { this.waiters = this.waiters.filter((item) => item !== waiter); reject(new Error(`Timed out waiting for ${this.name} frame`)); }, timeout) };
      this.waiters.push(waiter);
    });
  }

  send(command: Frame): void { this.log("out", command); this.process.stdin.write(JSON.stringify(command) + "\n"); }

  request(type: string, data: Frame = {}, timeout = timeoutMs): Promise<Frame> {
    const id = `${this.name}-${++this.serial}`;
    const result = this.wait((frame) => frame.type === "response" && frame.id === id, timeout, this.frames.length);
    this.send({ id, type, ...data }); return result;
  }

  async prompt(message: string): Promise<Frame> {
    const id = `${this.name}-prompt-${++this.serial}`;
    const since = this.frames.length;
    const acceptance = this.wait((frame) => frame.type === "response" && frame.id === id, timeoutMs, since);
    this.send({ id, type: "prompt", message });
    const ack = await acceptance;
    if (!ack.success) throw new Error(`Prompt rejected: ${safeText(ack.error)}`);
    // 18.4.10 discards ordinary local slash tickets; only agent invocations
    // owe prompt_result. abort_and_prompt local completion is different.
    if (ack.data?.agentInvoked === false) return { type: "local_prompt_complete", id, agentInvoked: false, status: "completed", sessionSettled: true };
    const result = await this.wait((frame) => frame.type === "prompt_result" && frame.id === id, timeoutMs, since);
    if (!result.sessionSettled) await this.wait((frame) => frame.type === "session_settled", timeoutMs, since);
    return result;
  }

  async stop(): Promise<void> {
    if (!this.closed) {
      await this.request("abort", {}, 5_000).catch(() => undefined);
      this.process.stdin.end();
      const exit = new Promise<void>((resolveExit) => this.process.once("exit", () => resolveExit()));
      await Promise.race([exit, new Promise<void>((resolveWait) => setTimeout(resolveWait, 4_000))]);
      if (!this.closed) {
        try { if (process.platform !== "win32" && this.process.pid) process.kill(-this.process.pid, "SIGTERM"); else this.process.kill("SIGTERM"); } catch {}
        await Promise.race([exit, new Promise<void>((resolveWait) => setTimeout(resolveWait, 2_000))]);
      }
      if (!this.closed) try { if (process.platform !== "win32" && this.process.pid) process.kill(-this.process.pid, "SIGKILL"); else this.process.kill("SIGKILL"); } catch {}
    }
    await this.writes;
  }
}

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function safeState(frame: Frame): Frame {
  const state = frame.data || {};
  return { sessionFile: state.sessionFile, sessionId: state.sessionId, messageCount: state.messageCount, isSettled: state.isSettled, hasPendingAsyncWork: state.hasPendingAsyncWork, model: state.model && { id: state.model.id, provider: state.model.provider }, thinkingLevel: state.thinkingLevel };
}
async function sidecars(sessionFile: string): Promise<Frame[]> {
  const root = sessionFile.replace(/\.jsonl$/, "");
  const result: Frame[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 4) return;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await visit(path, depth + 1); continue; }
      if (!/^__advisor(?:\.[a-zA-Z0-9_-]+)?\.jsonl$/.test(entry.name)) continue;
      const metadata = await stat(path); if (metadata.size > 16 * 1024 * 1024) continue;
      const entries = (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      result.push({ path, bytes: metadata.size, entryTypes: [...new Set(entries.map((entry) => entry.type))], messages: entries.filter((entry) => entry.type === "message").map((entry) => ({ role: entry.message.role, synthetic: entry.message.synthetic, attribution: entry.message.attribution, contentParts: Array.isArray(entry.message.content) ? entry.message.content.map((part: Frame) => part.type) : [], toolName: entry.message.toolName })) });
    }
  }
  await visit(root, 0); return result;
}

await mkdir(workspace, { recursive: true }); await mkdir(output, { recursive: true });
const runId = `${Date.now()}-${scenario}`;
const sessionDir = join(workspace, "sessions", runId);
await mkdir(sessionDir, { recursive: true });
await writeFile(join(workspace, "SMOKE.txt"), "This isolated directory contains only live RPC smoke artifacts.\n");
const args = ["--mode", "rpc-ui", "--no-title", "--session-dir", sessionDir, "--max-time", "240"];
if (["interaction", "prewalk"].includes(scenario)) args.push("--approval-mode", "always-ask");
if (scenario === "interaction") {
  // Existing per-tool allow grants override every approval mode. A disposable
  // process overlay exercises a write approval without changing stored config.
  const overlay = join(sessionDir, "smoke-approval.yml");
  await writeFile(overlay, "tools:\n  approval:\n    write: prompt\n");
  args.push("--config", overlay);
}
const report: Frame = { runId, scenario, workspace, sessionDir, started: new Date().toISOString(), assertions: [], prompts: [], resumed: false };
const clients: RpcClient[] = [];
let activeChildControl: Promise<void> | undefined;
try {
  const client = new RpcClient("initial", args); clients.push(client);
  report.ready = await client.ready;
  assert(report.ready.supportedProtocolVersions.includes(2), "OMP does not support RPC v2");
  const negotiation = await client.request("negotiate_protocol", { protocolVersion: 2 });
  assert(negotiation.success && negotiation.data.protocolVersion === 2, "Protocol negotiation failed");
  report.assertions.push("RPC v2 ready/negotiation and request correlation");
  const subscription = await client.request("set_subagent_subscription", { level: "events" });
  assert(subscription.success, "Subagent event subscription failed");
  assert((await client.request("set_ask_dialog", { enabled: true })).success, "Ask dialog opt-in failed");
  await client.request("set_auto_retry", { enabled: false });
  report.initialState = safeState(await client.request("get_state"));
  const sessionFile = report.initialState.sessionFile;
  assert(typeof sessionFile === "string", "Missing isolated session file");
  const owned = relative(sessionDir, sessionFile);
  assert(owned && !owned.startsWith("..") && !isAbsolute(owned), "OMP session escaped the smoke directory");
  const roster = await client.request("get_subagents");
  assert(roster.success && Array.isArray(roster.data.subagents), "Invalid roster response");
  report.initialRoster = roster.data;
  const commands = await client.request("get_available_commands");
  report.commands = commands.data.commands.filter((command: Frame) => ["advisor", "prewalk", "plan"].includes(command.name));
  report.prompts.push(await client.prompt("/advisor status"));
  report.prompts.push(await client.prompt("/prewalk status"));
  report.commandOutputs = client.frames.filter((frame) => frame.type === "command_output").map((frame) => safeText(frame.text || "").slice(0, 2_000));

  if (["worker", "cancel"].includes(scenario)) {
    client.observer = (frame) => {
      if (activeChildControl || frame.type !== "subagent_lifecycle" || frame.payload.status !== "started") return;
      const id = frame.payload.id;
      activeChildControl = (async () => {
        const liveRoster = await client.request("get_subagents");
        report.liveRoster = sanitized(liveRoster.data);
        const steer = await client.request("steer_subagent", { subagentId: id, message: "Protocol smoke steering: include STEER_ACK in your final response. Keep the assigned tiny scope." }, 30_000);
        report.steer = sanitized(steer);
        if (scenario === "cancel") {
          report.cancel = await client.request("cancel_subagent", { subagentId: id });
          // The test ends at the control round trip. Abort only our own parent
          // so its optional follow-up/advisor work cannot extend the test.
          report.parentAbort = await client.request("abort");
        }
      })().catch((error) => { report.controlError = safeText(String(error)); });
    };
    const prompt = scenario === "worker"
      ? "This is a bounded RPC protocol smoke test in a disposable directory. Use the task tool to spawn exactly one task subagent named rpc-smoke. Assign it: read SMOKE.txt, then report CHILD_ACK in one sentence; do not write any files, inspect other directories, or delegate. Do not answer yourself before spawning it. Await its result, then report PARENT_ACK plus its answer. No repository analysis or broader work."
      : "This is a bounded cancellation protocol test in a disposable directory. Use the task tool to spawn two independent task subagents concurrently: rpc-cancel reads SMOKE.txt and reports CHILD_ACK; rpc-control independently reads SMOKE.txt and reports CONTROL_ACK. Neither may inspect other directories, change files or delegate. The host will cancel one child immediately. Await both results, then stop after one sentence. No broader work.";
    report.prompts.push(await client.prompt(prompt));
    if (activeChildControl) await activeChildControl;
    if (scenario === "cancel") {
      assert(report.cancel?.success && report.cancel?.data?.cancelled === true, "Running child cancellation failed");
      report.assertions.push("Real running child cancel acknowledgement");
    }
    assert(client.childFiles.size > 0, "No real child lifecycle observed");
    report.children = [];
    for (const [id, file] of client.childFiles) {
      const full = await client.request("get_subagent_messages", { subagentId: id, fromByte: 0 });
      assert(full.success && full.data.messages.length > 0, "Child full transcript retrieval failed");
      const tail = await client.request("get_subagent_messages", { subagentId: id, fromByte: full.data.nextByte });
      assert(tail.success && tail.data.messages.length === 0, "Child byte cursor failed");
      report.children.push({ id, sessionFile: file, fromByte: full.data.fromByte, nextByte: full.data.nextByte, entries: full.data.entries.length, roles: full.data.messages.map((message: Frame) => message.role), contentParts: full.data.messages.map((message: Frame) => Array.isArray(message.content) ? message.content.map((part: Frame) => part.type) : []), steeringRecorded: full.data.messages.some((message: Frame) => message.role === "user" && JSON.stringify(message.content).includes("Protocol smoke steering")) });
    }
    report.assertions.push("Real child lifecycle, complete persisted transcript, incremental cursor");
  } else if (scenario === "interaction") {
    report.prompts.push(await client.prompt("This is a bounded UI protocol smoke in a disposable directory. Call the ask tool with one question: Choose smoke color, options Blue and Green, recommended Blue. After the host responds, use the write tool to create only rpc-ui-smoke.txt containing UI_ACK and the chosen color. Do not inspect other directories or perform other work. End with one sentence."));
    report.uiMethods = [...client.uiMethods];
    report.writeResult = await readFile(join(workspace, "rpc-ui-smoke.txt"), "utf8").catch(() => null);
    assert(client.uiMethods.has("ask"), "No structured ask dialog observed");
    assert(client.uiMethods.has("confirm") || client.uiMethods.has("select"), "No approval dialog observed");
    assert(report.writeResult?.includes("UI_ACK"), "Approved isolated write did not happen");
    report.assertions.push("Structured ask answer and tool approval round trip");
  } else if (scenario === "prewalk") {
    report.prompts.push(await client.prompt("This is a bounded prewalk protocol smoke test. Plan the single isolated write using the todo_write tool with one phase and one pending task. Then use write to create only prewalk-smoke.txt containing PREWALK_ACK. Mark that todo complete. Do not inspect other directories or perform other work. End with one sentence."));
    report.writeResult = await readFile(join(workspace, "prewalk-smoke.txt"), "utf8").catch(() => null);
    report.assertions.push("Prewalk configured smoke attempted; inspect notices for actual handoff");
  }

  report.parentMessages = sanitized((await client.request("get_messages")).data);
  report.finalState = safeState(await client.request("get_state"));
  if (followMs > 0) {
    const until = Date.now() + followMs;
    report.follow = [];
    while (Date.now() < until) {
      report.follow.push({ at: Date.now(), state: safeState(await client.request("get_state")), advisors: await sidecars(sessionFile) });
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(2_000, until - Date.now())));
    }
  }
  report.advisors = await sidecars(sessionFile);
  report.notices = client.frames.filter((frame) => frame.type === "notice" || (frame.type === "extension_ui_request" && ["notify", "setStatus"].includes(frame.method))).map((frame) => ({ type: frame.type, source: frame.source, level: frame.level, method: frame.method, message: safeText(frame.message || frame.statusText || ""), notifyType: frame.notifyType, statusKey: frame.statusKey }));
  if (report.notices.some((notice: Frame) => notice.source === "prewalk" && notice.message.startsWith("Prewalk: switched"))) report.assertions.push("Configured prewalk switched model after first write and emitted a notice");
  await client.stop();

  const resumed = new RpcClient("resumed", [...args, "--resume", sessionFile]); clients.push(resumed);
  await resumed.ready;
  await resumed.request("negotiate_protocol", { protocolVersion: 2 });
  report.resumeState = safeState(await resumed.request("get_state"));
  assert(report.resumeState.sessionId === report.initialState.sessionId, "Resumed a different session");
  const replay = await resumed.request("get_messages");
  report.resumeMessageCount = replay.data.messages.length;
  assert(report.resumeMessageCount >= report.parentMessages.messages.length, "Parent transcript replay lost messages");
  report.resumeRoster = (await resumed.request("get_subagents")).data;
  report.resumeChildren = [];
  for (const child of report.children || []) {
    const rpc = await resumed.request("get_subagent_messages", { sessionFile: child.sessionFile });
    const content = await readFile(child.sessionFile, "utf8");
    const entries = content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    report.resumeChildren.push({ id: child.id, rpcSuccess: rpc.success, rpcError: rpc.error, persistedMessages: entries.filter((entry) => entry.type === "message").length });
  }
  report.resumed = true; report.assertions.push("Own parent session resume and persisted replay");
  await resumed.stop();
  report.success = true;
} catch (error) {
  report.success = false; report.error = safeText(String(error));
  for (const client of clients) report.lastFrames = client.frames.slice(-4).map((frame) => sanitized(frame));
} finally {
  await Promise.allSettled(clients.map((client) => client.stop()));
  report.clients = clients.map((client) => ({ eventTypes: [...client.eventTypes], uiMethods: [...client.uiMethods], protocolNoise: client.protocolNoise, stderrLines: client.stderrLines, exitCode: client.process.exitCode, signalCode: client.process.signalCode }));
  report.finished = new Date().toISOString();
  await writeFile(join(output, `${runId}.report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ success: report.success, scenario, assertions: report.assertions, error: report.error, report: join(output, `${runId}.report.json`) }));
  if (!report.success) process.exitCode = 1;
}
