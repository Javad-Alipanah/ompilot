import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";

class FakeClient extends EventEmitter {
  static created: FakeClient[] = [];
  isReady = true;
  isRunning = true;
  responses: Array<{ id: string; answer: unknown }> = [];

  constructor(private readonly options: { resumeSessionId?: string }) {
    super();
    FakeClient.created.push(this);
  }

  async start() {
    if (this.options.resumeSessionId === "missing-session") {
      this.emit("stderr", "Session not found");
    }
    this.emit("ready");
  }

  exit() {
    this.isReady = false;
    this.isRunning = false;
    this.emit("exit", 1);
  }

  respondExtensionUi(id: string, answer: unknown) {
    this.responses.push({ id, answer });
  }

  async dispose() {
    this.isReady = false;
    this.isRunning = false;
  }
}

mock.module("vscode", () => ({
  ConfigurationTarget: { Workspace: 2 },
  EventEmitter: class {
    private readonly emitter = new EventEmitter();
    event = (listener: () => void) => {
      this.emitter.on("change", listener);
      return { dispose: () => this.emitter.off("change", listener) };
    };
    fire() { this.emitter.emit("change"); }
    dispose() { this.emitter.removeAllListeners(); }
  },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
}));
mock.module("../src/omp/rpcClient", () => ({ OmpRpcClient: FakeClient }));
mock.module("../src/omp/inspectionService", () => ({
  InspectionService: class { async start() {} dispose() {} },
}));

const { SessionManager } = await import("../src/omp/sessionManager");
const sessions: InstanceType<typeof SessionManager>[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.dispose()));
  mock.restore();
  FakeClient.created = [];
});

async function startSession(resumeSessionId?: string) {
  const session = new SessionManager(() => "/tmp/omp-question-lifecycle-test");
  sessions.push(session);
  const internal = session as any;
  internal.readConfig = (overrides: object) => ({ cwd: "/tmp/omp-question-lifecycle-test", ...overrides });
  internal.onSessionReady = async () => {};
  await session.start({ resumeSessionId, continueLastSession: false });
  return { session, internal, client: FakeClient.created.at(-1)! };
}

function enqueueQuestion(client: FakeClient, id: string) {
  client.emit("event", {
    type: "extension_ui_request", id, method: "confirm", title: `Confirm ${id}`,
    message: "Continue?", timeout: 60_000,
  });
}

test("current process exit clears every pending question and deadline without answering the dead process", async () => {
  const { session, internal, client } = await startSession();
  enqueueQuestion(client, "first");
  enqueueQuestion(client, "second");
  const deadlines = [...internal.uiQuestionTimers.values()];
  expect(deadlines).toHaveLength(2);
  expect(session.getUiQuestion()?.id).toBe("first");
  const clearDeadline = spyOn(globalThis, "clearTimeout");
  let changes = 0;
  session.onDidChange(() => { changes++; });

  client.exit();

  expect(session.getUiQuestion()).toBeNull();
  expect(internal.pendingUiQuestions).toHaveLength(0);
  expect(internal.uiQuestionTimers.size).toBe(0);
  for (const deadline of deadlines) expect(clearDeadline).toHaveBeenCalledWith(deadline);
  expect(changes).toBeGreaterThan(0);
  expect(session.getStatus().state).toBe("error");
  expect(client.responses).toEqual([]);
});

for (const branch of ["stopped", "stale resume"] as const) {
  test(`current process exit clears questions before the ${branch} status branch`, async () => {
    const { session, internal, client } = await startSession(
      branch === "stale resume" ? "missing-session" : undefined,
    );
    enqueueQuestion(client, "waiting");
    if (branch === "stopped") internal.setStatus({ state: "stopped" });
    const status = session.getStatus();

    client.exit();

    expect(session.getUiQuestion()).toBeNull();
    expect(internal.uiQuestionTimers.size).toBe(0);
    expect(session.getStatus()).toEqual(status);
    expect(client.responses).toEqual([]);
  });
}

test("a replaced client's exit cannot clear the current process's questions or deadlines", async () => {
  const { session, internal, client: oldClient } = await startSession();
  await session.start({ resumeSessionId: undefined, continueLastSession: false });
  const client = FakeClient.created.at(-1)!;
  enqueueQuestion(client, "current");
  const question = session.getUiQuestion();
  const deadline = internal.uiQuestionTimers.get("current");
  const clearDeadline = spyOn(globalThis, "clearTimeout");

  oldClient.exit();

  expect(session.getUiQuestion()).toBe(question);
  expect(internal.uiQuestionTimers.get("current")).toBe(deadline);
  expect(clearDeadline).not.toHaveBeenCalledWith(deadline);
  expect(session.getStatus().state).toBe("ready");
  expect(client.responses).toEqual([]);
  expect(oldClient.responses).toEqual([]);
});

test("a recoverable client error keeps the current question answerable", async () => {
  const { session, internal, client } = await startSession();
  enqueueQuestion(client, "recoverable");
  const question = session.getUiQuestion();

  client.emit("error", new Error("Temporary transport failure"));

  expect(session.getUiQuestion()).toBe(question);
  expect(internal.uiQuestionTimers.size).toBe(1);
  session.answerUiQuestion("recoverable", { confirmed: true });
  expect(client.responses).toEqual([{ id: "recoverable", answer: { confirmed: true } }]);
});
