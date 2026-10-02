import { afterEach, expect, mock, test } from "bun:test";

mock.module("vscode", () => ({
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
}));

const { TabManager } = await import("../src/omp/tabManager");
const managers: InstanceType<typeof TabManager>[] = [];
const releaseGates: Array<() => void> = [];
const pending: Promise<unknown>[] = [];

test("switching profiles saves the previous tabs and restores only the selected profile", async () => {
  let oldState: any;
  const tabs = new TabManager(() => "/tmp/omp-profile-test", { get: () => undefined, set: state => { oldState = state; } }, { profile: "default" });
  managers.push(tabs);
  const internal = tabs as any;
  internal.tabSessionIds.set(tabs.getActiveId(), "default-session");
  const prototype = Object.getPrototypeOf(tabs.active());
  const ensure = prototype.ensureStarted;
  prototype.ensureStarted = async () => {};
  try {
    let targetState: any = { sessionIds: ["audn-session"], titles: ["Profile chat"], activeIndex: 0 };
    await tabs.switchRuntime({ get: () => targetState, set: state => { targetState = state; } }, { profile: "audn" });
    expect(oldState.sessionIds).toEqual(["default-session"]);
    expect(tabs.getOpenOmpSessionIds()).toEqual(new Set(["audn-session"]));
    expect(tabs.getRuntimeOptions().profile).toBe("audn");
    expect((tabs.active() as any).runtimeOptions.profile).toBe("audn");
  } finally { prototype.ensureStarted = ensure; }
});

test("profile switching rejects busy work without losing its session", async () => {
  const tabs = manager();
  const id = tabs.getActiveId();
  (tabs.active() as any).status = { state: "busy" };
  await expect(tabs.switchRuntime({ get: () => undefined, set() {} }, { profile: "audn" })).rejects.toThrow(/Stop|settle/);
  expect(tabs.getActiveId()).toBe(id);
});

function manager() {
  const value = new TabManager(() => "/tmp/omp-tab-lifecycle-test");
  managers.push(value);
  return value;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  releaseGates.push(release);
  return { promise, release };
}

afterEach(async () => {
  releaseGates.splice(0).forEach(release => release());
  await Promise.allSettled(pending.splice(0));
  await Promise.all(managers.splice(0).map(value => value.dispose()));
});

test("closing an active tab redirects new messages before its OMP shutdown completes", async () => {
  const tabs = manager();
  const internal = tabs as any;
  const closingId = tabs.getActiveId();
  const survivingId = tabs.createTab(false);
  const closing = internal.tabs.get(closingId).session;
  const surviving = internal.tabs.get(survivingId).session;
  const shutdown = gate();
  const received: string[] = [];
  let activeWhenShutdownStarted = "";
  closing.dispose = async () => {
    activeWhenShutdownStarted = tabs.getActiveId();
    await shutdown.promise;
  };
  closing.send = async () => { throw new Error("Message reached the closing session"); };
  surviving.ensureStarted = async () => {};
  surviving.send = async (message: string) => { received.push(message); };
  let notified = 0;
  internal._onDidChange.fire = () => { notified++; };
  const close = tabs.closeTab(closingId);
  pending.push(close);
  expect(tabs.getActiveId()).toBe(survivingId);
  expect(tabs.getTabs().map(tab => tab.id)).toEqual([survivingId]);
  expect(activeWhenShutdownStarted).toBe(survivingId);
  expect(notified).toBeGreaterThan(0);
  await tabs.send("Continue in the remaining tab");
  expect(received).toEqual(["Continue in the remaining tab"]);
  shutdown.release();
  await close;
});

test("closing the last tab creates a usable replacement while old shutdown is pending", async () => {
  const tabs = manager();
  const internal = tabs as any;
  const closingId = tabs.getActiveId();
  const shutdown = gate();
  internal.tabs.get(closingId).session.dispose = async () => { await shutdown.promise; };
  const create = tabs.createTab.bind(tabs);
  let replacementStarted = false;
  tabs.createTab = (...args) => {
    const id = create(...args);
    internal.tabs.get(id).session.ensureStarted = async () => { replacementStarted = true; };
    return id;
  };
  const close = tabs.closeTab(closingId);
  pending.push(close);
  expect(tabs.getActiveId()).not.toBe(closingId);
  expect(tabs.getActiveId()).not.toBe("");
  expect(tabs.getTabs()).toHaveLength(1);
  expect(replacementStarted).toBe(true);
  shutdown.release();
  await close;
});

test("two concurrent closes dispose the same tab only once", async () => {
  const tabs = manager();
  const internal = tabs as any;
  const closingId = tabs.getActiveId();
  const remainingId = tabs.createTab(false);
  internal.tabs.get(remainingId).session.ensureStarted = async () => {};
  const shutdown = gate();
  let closes = 0;
  internal.tabs.get(closingId).session.dispose = async () => { closes++; await shutdown.promise; };
  const first = tabs.closeTab(closingId);
  const second = tabs.closeTab(closingId);
  pending.push(first, second);
  let secondSettled = false;
  void second.then(() => { secondSettled = true; });
  await Promise.resolve();
  expect(secondSettled).toBe(true);
  expect(closes).toBe(1);
  shutdown.release();
  await Promise.all([first, second]);
});

test("extension shutdown starts all tab process disposals concurrently", async () => {
  const tabs = manager();
  const internal = tabs as any;
  const ids = [tabs.getActiveId(), tabs.createTab(false)];
  const shutdown = gate();
  const started: string[] = [];
  for (const id of ids) internal.tabs.get(id).session.dispose = async () => { started.push(id); await shutdown.promise; };
  const disposal = tabs.dispose();
  pending.push(disposal);
  expect(started).toEqual(ids);
  expect(tabs.getActiveId()).toBe("");
  shutdown.release();
  await disposal;
});

test("extension shutdown also waits for an already closing tab", async () => {
  const tabs = manager();
  const internal = tabs as any;
  const closingId = tabs.getActiveId();
  const remainingId = tabs.createTab(false);
  internal.tabs.get(remainingId).session.ensureStarted = async () => {};
  const shutdown = gate();
  internal.tabs.get(closingId).session.dispose = async () => { await shutdown.promise; };
  const close = tabs.closeTab(closingId);
  pending.push(close);
  const disposal = tabs.dispose();
  pending.push(disposal);
  let settled = false;
  void disposal.then(() => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  shutdown.release();
  await Promise.all([close, disposal]);
  expect(settled).toBe(true);
});
