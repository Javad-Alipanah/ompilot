import { afterEach, expect, mock, test } from "bun:test";

mock.module("vscode", () => ({
  ConfigurationTarget: { Workspace: 2 },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
}));

const { SessionManager } = await import("../src/omp/sessionManager");
const { TabManager } = await import("../src/omp/tabManager");
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => { await Promise.all(cleanup.splice(0).map(dispose => dispose())); });

function session() {
  const session = new SessionManager(() => "/tmp/omp-command-catalog-test");
  cleanup.push(async () => { (session as any).client = undefined; await session.dispose(); });
  return session;
}

test("session queries its connected process catalog without sending a prompt", async () => {
  const current = session();
  const commands = [{ name: "skill:profile/run", description: "Profile skill", source: "skill" }];
  const calls: string[] = [];
  (current as any).client = {
    isRunning: true,
    isReady: true,
    getCommands: async () => { calls.push("getCommands"); return commands; },
    prompt: () => { throw new Error("Catalog lookup must not prompt the model"); },
  };
  expect(typeof (current as any).getAvailableCommands).toBe("function");
  expect(await current.getAvailableCommands()).toEqual(commands);
  expect(calls).toEqual(["getCommands"]);
});

test("session catalog results cannot escape from a replaced OMP process", async () => {
  const current = session();
  let release!: (commands: unknown[]) => void;
  const pending = new Promise<unknown[]>(resolve => { release = resolve; });
  (current as any).client = { isRunning: true, isReady: true, getCommands: () => pending };
  expect(typeof (current as any).getAvailableCommands).toBe("function");
  const catalog = current.getAvailableCommands();
  await Promise.resolve();
  (current as any).client = { isRunning: true, isReady: true };
  release([{ name: "skill:old-profile/run", source: "skill" }]);
  await expect(catalog).rejects.toThrow(/session changed/i);
});

test("session reports a connection ending between startup and catalog lookup", async () => {
  const current = session();
  current.ensureStarted = async () => {};
  await expect(current.getAvailableCommands()).rejects.toThrow(/not connected/i);
});

test("tab catalog lookup follows the active tab instead of sharing a workspace cache", async () => {
  const tabs = new TabManager(() => "/tmp/omp-command-tabs-test");
  cleanup.push(() => tabs.dispose());
  const first = tabs.active();
  const firstCommands = [{ name: "skill:first/run", source: "skill" as const }];
  const secondCommands = [{ name: "skill:second/run", source: "skill" as const }];
  first.getAvailableCommands = async () => firstCommands;
  expect(typeof (tabs as any).getAvailableCommands).toBe("function");
  expect(await tabs.getAvailableCommands()).toEqual(firstCommands);
  tabs.createTab(true);
  tabs.active().getAvailableCommands = async () => secondCommands;
  expect(await tabs.getAvailableCommands()).toEqual(secondCommands);
  await expect(first.getAvailableCommands()).resolves.toEqual(firstCommands);
});
