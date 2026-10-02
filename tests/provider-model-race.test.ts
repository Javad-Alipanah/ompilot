import { expect, mock, test } from "bun:test";

let onPersist = () => {};
mock.module("vscode", () => ({
  ConfigurationTarget: { Workspace: 2 },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback, update: async () => { await Promise.resolve(); onPersist(); } }) },
  window: { showQuickPick: async () => ({ selector: "provider/model" }) },
}));
const { ChatViewProvider } = await import("../src/chat/chatViewProvider");

function fixture() {
  const state = { tab: "tab-a", profile: "profile-a", busy: false, restarts: 0 };
  const provider: any = Object.create(ChatViewProvider.prototype);
  provider.sessions = {
    getTabs: () => [{ busy: state.busy, status: state.busy ? "busy" : "ready" }],
    getActiveId: () => state.tab,
    active: () => ({ getAvailableModels: async () => [{ id: "model", selector: "provider/model", provider: "provider" }] }),
    restart: async () => { state.restarts++; },
  };
  provider.profileContext = () => ({ key: state.profile, profile: state.profile });
  provider.post = () => {};
  provider.postState = () => {};
  return { provider, state };
}

test("model persistence cannot restart a different active tab", async () => {
  const { provider, state } = fixture();
  onPersist = () => { state.tab = "tab-b"; };
  await provider.pickModelAndApply();
  expect(state.restarts).toBe(0);
});

test("model persistence cannot restart a newly selected profile", async () => {
  const { provider, state } = fixture();
  onPersist = () => { state.profile = "profile-b"; };
  await provider.pickModelAndApply();
  expect(state.restarts).toBe(0);
});

test("model persistence cannot interrupt work that started while saving", async () => {
  const { provider, state } = fixture();
  onPersist = () => { state.busy = true; };
  await expect(provider.pickModelAndApply()).rejects.toThrow(/saving the model choice/);
  expect(state.restarts).toBe(0);
});
