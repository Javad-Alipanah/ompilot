import { beforeEach, expect, mock, test } from "bun:test";
let mode = "Agent";

mock.module("vscode", () => ({
  ConfigurationTarget: { Workspace: 2 },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === "mode" ? mode : fallback }) },
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
}));

const { SessionManager } = await import("../src/omp/sessionManager");
let session: InstanceType<typeof SessionManager>;
let internal: any;

beforeEach(async () => {
  mode = "Agent";
  session = new SessionManager(() => "/tmp/omp-workbench-test");
  internal = session;
  internal.client = { isReady: true, prompt() {} };
  session.ensureStarted = async () => {};
  await session.send("Inspect the project");
  internal.handleEvent({ type: "agent_start" });
});

test("an asynchronous agent_end does not mark the parent ready", () => {
  internal.handleEvent({ type: "agent_end", isTerminal: false, messages: [] });
  expect(session.getStatus().state).toBe("busy");
});

test("session_settled completes the turn after background work", () => {
  internal.handleEvent({ type: "session_settled" });
  expect(session.getStatus().state).toBe("ready");
});

test("notices are visible in the parent transcript", () => {
  internal.handleEvent({ type: "notice", source: "prewalk", message: "Switched to implementation model", level: "info" });
  expect(session.getMessages().some((message) => message.parts.some((part) => part.kind === "text" && part.text.includes("Switched to implementation model")))).toBe(true);
});

test("a finalized assistant snapshot preserves tool cards and their full output", () => {
  internal.handleEvent({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "sample.ts" } });
  internal.handleEvent({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: "line\n".repeat(500) + "FINAL_LINE" });
  internal.handleEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Read complete" }] } });
  const tool = session.getMessages().flatMap(message => message.parts).find(part => part.kind === "tool");
  expect(tool?.kind === "tool" && tool.outputPreview).toContain("FINAL_LINE");
});

test("structured ask questions remain pending and reply with option labels", () => {
  const responses: unknown[] = [];
  internal.client.respondExtensionUi = (id: string, answer: unknown) => responses.push({ id, ...answer as object });
  internal.handleEvent({ type: "extension_ui_request", id: "ask-1", method: "ask", questions: [
    { id: "color", question: "Choose a color", options: [{ label: "Blue" }, { label: "Green" }], recommended: 0 },
  ] });
  expect(session.getUiQuestion()?.method).toBe("ask");
  session.answerUiQuestion("ask-1", { answers: [{ id: "color", selectedOptions: ["Blue"] }] });
  expect(responses.at(-1)).toEqual({ id: "ask-1", answers: [{ id: "color", selectedOptions: ["Blue"] }] });
  expect(session.getUiQuestion()).toBeNull();
});

test("a terminal run end still waits for pending background work", async () => {
  internal.client.getState = async () => ({ isStreaming: false, hasPendingAsyncWork: true, isSettled: false });
  internal.handleEvent({ type: "agent_end", isTerminal: true });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(session.getStatus().state).toBe("busy");
});

test("a local advisor status command displays its command output", () => {
  internal.handleEvent({ type: "command_output", command: "advisor", text: "Advisor enabled" });
  expect(session.getMessages().some(message => message.parts.some(part => part.kind === "text" && part.text.includes("Advisor enabled")))).toBe(true);
});

test("accepted main steering is preserved in the live transcript", async () => {
  internal.client.request = async () => ({ success: true });
  await session.steer("Please inspect the tests first");
  expect(session.getMessages().at(-1)?.parts).toEqual([{ kind: "text", text: "Please inspect the tests first" }]);
});

test("a stale history read cannot overwrite a new live prompt", async () => {
  let release!: (messages: unknown[]) => void;
  internal.messages = [];
  internal.client.getMessages = () => new Promise(resolve => { release = resolve; });
  const restore = internal.hydrateMessagesFromSession();
  await session.send("New live prompt");
  release([{ role: "user", content: "Old history" }]);
  await restore;
  expect(session.getMessages().some(message => message.parts.some(part => part.kind === "text" && part.text === "New live prompt"))).toBe(true);
  expect(session.getMessages().some(message => message.parts.some(part => part.kind === "text" && part.text === "Old history"))).toBe(false);
});

test("a stale state read cannot update a replacement session", async () => {
  let release!: (state: unknown) => void;
  internal.client.getState = () => new Promise(resolve => { release = resolve; });
  const refresh = session.refreshSessionState();
  internal.client = { isReady: true };
  release({ sessionId: "obsolete", model: { id: "obsolete" } });
  await refresh;
  expect(session.getSessionId()).toBeUndefined();
  expect(internal.sessionModel).toBeNull();
});

test("abort fallback cannot release queued work while OMP is still busy", async () => {
  let prompts = 0;
  internal.client.abort = () => {};
  internal.client.prompt = () => { prompts++; };
  internal.client.getState = async () => ({ hasPendingAsyncWork: true, isSettled: false });
  await session.send("Queued next prompt");
  session.abort();
  await new Promise(resolve => setTimeout(resolve, 550));
  expect(session.getStatus().state).toBe("busy");
  expect(prompts).toBe(0);
  internal.handleEvent({ type: "session_settled" });
  expect(prompts).toBe(1);
});

test("prewalk model changes refresh the current model immediately", async () => {
  internal.client.getState = async () => ({ model: { id: "implementation", name: "Implementation model" } });
  internal.handleEvent({ type: "model_changed" });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(session.getModelLabel()).toBe("Implementation model");
});

test("workflow commands keep attachment drafts and exact command text", async () => {
  internal.status = { state: "ready" };
  let prompt = "";
  internal.client.prompt = (text: string) => { prompt = text; };
  session.addAttachment({ kind: "text", label: "Unsaved draft", path: "draft.ts", content: "const draft = true" });
  await session.send("/advisor on", { includeAttachments: false });
  expect(prompt).toBe("/advisor on");
  expect(session.getAttachments()).toHaveLength(1);
});

test("empty dirty buffers are attached inline instead of reading stale disk content", () => {
  session.addAttachment({ kind: "text", label: "Empty draft", path: "draft.ts", content: "" });
  expect(internal.composePrompt("Review this")).toContain("File: draft.ts\n```\n\n```");
  expect(internal.composePrompt("Review this")).not.toContain("@draft.ts");
});

test("Ask and Plan express intent while slash commands retain exact semantics", () => {
  mode = "Ask";
  expect(internal.composePrompt("Explain this")).toContain("Mode: Ask.");
  mode = "Plan";
  expect(internal.composePrompt("Design this")).toContain("Mode: Plan.");
  expect(internal.composePrompt("/prewalk")).toBe("/prewalk");
});

test("disposing a chat prevents it from launching a replacement OMP process", async () => {
  internal.client.dispose = async () => {};
  await session.dispose();
  await expect(SessionManager.prototype.ensureStarted.call(session)).rejects.toThrow(/closed/);
  await expect(session.start()).rejects.toThrow(/closed/);
});
