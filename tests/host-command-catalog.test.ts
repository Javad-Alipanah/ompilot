import { expect, mock, test } from "bun:test";
mock.module("vscode", () => ({
  ConfigurationTarget: { Workspace: 2 },
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
}));
const { ChatViewProvider } = await import("../src/chat/chatViewProvider");

function fixture() {
  const command = { name: "skill:example/review", source: "skill", description: "Review code" };
  const state = { tab: "tab-a", profile: "profile-a", calls: 0 };
  const session = { getAvailableCommands: async () => { state.calls++; return [command]; } };
  let activeSession: unknown = session;
  const frames: any[] = [];
  const provider: any = Object.create(ChatViewProvider.prototype);
  provider.sessions = { getActiveId: () => state.tab, active: () => activeSession };
  provider.profileContext = () => ({ key: state.profile });
  provider.post = (message: any) => frames.push(message);
  return { provider, frames, state, session, command, replaceSession: () => { activeSession = {}; } };
}

test("slash catalog replies carry their originating tab and request id", async () => {
  const f = fixture();
  await f.provider.onMessage({ type: "getSlashCommands", tabId: "tab-a", requestId: 7 });
  expect(f.frames).toEqual([{ type: "slashCommands", tabId: "tab-a", requestId: 7, commands: [f.command] }]);
});

test("a request from an inactive tab cannot query the active profile", async () => {
  const f = fixture();
  await f.provider.onMessage({ type: "getSlashCommands", tabId: "tab-other", requestId: 7 });
  expect(f.state.calls).toBe(0);
  expect(f.frames).toHaveLength(0);
});

test("a catalog reply is discarded if its profile changes while awaiting OMP", async () => {
  const f = fixture();
  f.session.getAvailableCommands = async () => { f.state.profile = "profile-b"; return [f.command]; };
  await f.provider.onMessage({ type: "getSlashCommands", tabId: "tab-a", requestId: 7 });
  expect(f.frames).toHaveLength(0);
});

test("a catalog reply is discarded if its tab session was replaced", async () => {
  const f = fixture();
  f.session.getAvailableCommands = async () => { f.replaceSession(); return [f.command]; };
  await f.provider.onMessage({ type: "getSlashCommands", tabId: "tab-a", requestId: 7 });
  expect(f.frames).toHaveLength(0);
});

test("discovery failure is a scoped catalog error rather than a failed chat", async () => {
  const f = fixture();
  f.session.getAvailableCommands = async () => { throw new Error("Discovery failed"); };
  await f.provider.onMessage({ type: "getSlashCommands", tabId: "tab-a", requestId: 7 });
  expect(f.frames).toEqual([{ type: "slashCommands", tabId: "tab-a", requestId: 7, commands: [], error: "Discovery failed" }]);
});
