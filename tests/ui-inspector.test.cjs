const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const scriptPath = path.join(__dirname, "../media/agents.js");

function setup(tabId = "tab-a") {
  assert.ok(fs.existsSync(scriptPath), "The agent inspector script must exist");
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM('<div id="agent-inspector"></div>', {
    runScripts: "outside-only",
    url: "https://webview.test/",
  });
  const sent = [];
  const bridge = {
    postMessage: (message) => sent.push(message),
    renderMarkdown: (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    currentTabId: tabId,
  };
  dom.window.ompWorkbench = bridge;
  dom.window.eval(fs.readFileSync(scriptPath, "utf8"));
  const receive = (data) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data }));
  const snapshot = (value = {}) => receive({ type: "inspection", snapshot: {
    tabId: bridge.currentTabId,
    agents: [],
    notices: [],
    ...value,
  } });
  const click = (selector) => {
    const element = dom.window.document.querySelector(selector);
    assert.ok(element, `Missing ${selector}`);
    element.click();
  };
  return { dom, sent, bridge, receive, snapshot, click, doc: dom.window.document };
}

const worker = (overrides = {}) => ({
  id: "worker-1", name: "Implement tests", kind: "worker", status: "running", model: "gpt-test",
  canSteer: true, canCancel: true, ...overrides,
});

test("requests the roster when the main chat becomes ready", () => {
  const ui = setup();
  ui.receive({ type: "ready", activeTabId: "tab-a" });
  assert.deepEqual(JSON.parse(JSON.stringify(ui.sent.at(-1))), { type: "inspectAgents", tabId: "tab-a" });
});

test("shows nested workers and read-only advisor controls", () => {
  const ui = setup();
  ui.snapshot({ agents: [worker(), worker({ id: "child", name: "Child", parentId: "worker-1" }),
    worker({ id: "advisor", name: "Reviewer", kind: "advisor", canSteer: true, canCancel: true })] });
  const child = ui.doc.querySelector('[data-agent-id="child"]');
  assert.match(child.textContent, /Child/);
  assert.match(child.getAttribute("aria-label"), /Implement tests/);
  ui.click('[data-agent-id="advisor"]');
  ui.snapshot({ agents: [worker({ id: "advisor", name: "Reviewer", kind: "advisor" })], selectedId: "advisor",
    transcript: { agentId: "advisor", readOnly: true, messages: [{ role: "assistant", content: "Advice" }] } });
  assert.match(ui.doc.body.textContent, /Read.only advisor/);
  assert.equal(ui.doc.querySelector('[data-action="steer"]'), null);
  assert.equal(ui.doc.querySelector('[data-action="cancel"]'), null);
});

test("renders tool arguments, output, thinking and full raw messages safely", () => {
  const ui = setup();
  const hostile = '<img src=x onerror="window.compromised=true">';
  ui.snapshot({ agents: [worker()], selectedId: "worker-1", transcript: {
    agentId: "worker-1", readOnly: false,
    messages: [{ role: "assistant", content: [{ type: "text", text: hostile },
      { type: "thinking", thinking: "Think carefully" },
      { type: "toolCall", name: "exec", arguments: { cmd: hostile } }] },
    { role: "toolResult", toolName: "exec", content: [{ type: "text", text: "Complete output" }] }],
  } });
  assert.equal(ui.doc.querySelector("img"), null);
  assert.match(ui.doc.body.textContent, /Think carefully/);
  assert.match(ui.doc.body.textContent, /Complete output/);
  assert.match(ui.doc.body.textContent, /Arguments/);
  assert.match(ui.doc.body.textContent, /Full raw message/);
  assert.match(ui.doc.body.textContent, /onerror/);
});

test("scopes all inspector actions to the active tab and respects worker capabilities", () => {
  const ui = setup();
  ui.snapshot({ agents: [worker()], selectedId: "worker-1", transcript: { agentId: "worker-1", readOnly: false, messages: [] } });
  const input = ui.doc.querySelector('[data-role="steering-input"]');
  input.value = "Keep the API compatible";
  input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  ui.click('[data-action="steer"]');
  ui.click('[data-action="cancel"]');
  ui.click('[data-action="export"]');
  ui.click('[data-action="advisor-on"]');
  ui.click('[data-action="advisor-off"]');
  ui.click('[data-action="advisor-status"]');
  ui.click('[data-action="prewalk"]');
  ui.click('[data-action="review"]');
  assert.ok(ui.sent.every((message) => message.tabId === "tab-a"));
  assert.deepEqual(JSON.parse(JSON.stringify(ui.sent.find((message) => message.type === "steerAgent"))),
    { type: "steerAgent", id: "worker-1", message: "Keep the API compatible", tabId: "tab-a" });
  ui.snapshot({ agents: [worker({ canSteer: false, canCancel: false })] });
  assert.equal(ui.doc.querySelector('[data-action="steer"]'), null);
  assert.equal(ui.doc.querySelector('[data-action="cancel"]'), null);
});

test("preserves focused steering drafts, transcript scroll and open raw blocks on roster refresh", () => {
  const ui = setup();
  const transcript = { agentId: "worker-1", readOnly: false, messages: [{ id: "m1", role: "assistant", content: "Working" }] };
  ui.snapshot({ agents: [worker()], selectedId: "worker-1", transcript });
  const input = ui.doc.querySelector('[data-role="steering-input"]');
  input.value = "Unsent direction";
  input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  input.focus();
  input.setSelectionRange(3, 7);
  const transcriptEl = ui.doc.querySelector('[data-role="transcript"]');
  transcriptEl.scrollTop = 48;
  const raw = ui.doc.querySelector('[data-raw-message]');
  raw.open = true;
  ui.snapshot({ agents: [worker({ status: "completed" })], transcript });
  assert.equal(ui.doc.activeElement, input);
  assert.equal(input.value, "Unsent direction");
  assert.equal(input.selectionStart, 3);
  assert.equal(transcriptEl.scrollTop, 48);
  assert.equal(ui.doc.querySelector('[data-raw-message]').open, true);
});

test("rejects stale tab data and clears controls immediately when the active tab changes", () => {
  const ui = setup();
  ui.snapshot({ agents: [worker()], selectedId: "worker-1" });
  ui.bridge.currentTabId = "tab-b";
  ui.receive({ type: "tabs", activeTabId: "tab-b" });
  ui.snapshot({ tabId: "tab-a", agents: [worker({ name: "Stale worker" })], selectedId: "worker-1" });
  assert.doesNotMatch(ui.doc.body.textContent, /Stale worker/);
  assert.equal(ui.doc.querySelector('[data-action="cancel"]'), null);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.sent.at(-1))), { type: "inspectAgents", tabId: "tab-b" });
});

test("surfaces host errors and notices and handles cyclic parent links without losing workers", () => {
  const ui = setup();
  ui.snapshot({ agents: [worker({ parentId: "child" }), worker({ id: "child", name: "Child", parentId: "worker-1" })],
    notices: [{ source: "prewalk", message: "Prewalk armed", timestamp: 123 }, { source: "advisor", message: "Advisor enabled", timestamp: 124 }],
    error: "Session unavailable" });
  assert.equal(ui.doc.querySelectorAll("[data-agent-id]").length, 2);
  assert.match(ui.doc.querySelector('[role="alert"]').textContent, /Session unavailable/);
  assert.match(ui.doc.body.textContent, /Prewalk armed/);
  assert.match(ui.doc.body.textContent, /Advisor enabled/);
});

test("repeated upstream ready snapshots do not start a refresh feedback loop", () => {
  const ui = setup();
  ui.receive({ type: "ready", activeTabId: "tab-a" });
  ui.receive({ type: "ready", activeTabId: "tab-a" });
  ui.receive({ type: "ready", activeTabId: "tab-a" });
  assert.equal(ui.sent.filter((message) => message.type === "inspectAgents").length, 1);
});

test("copy includes every raw transcript field and remains tab scoped", () => {
  const ui = setup();
  ui.snapshot({ agents: [worker()], selectedId: "worker-1", transcript: { agentId: "worker-1", readOnly: false,
    messages: [{ role: "assistant", content: "Done", extraProviderField: { retained: true } }] } });
  ui.click('[data-action="copy-transcript"]');
  const copy = ui.sent.find((message) => message.type === "copy");
  assert.equal(copy.tabId, "tab-a");
  assert.match(copy.text, /extraProviderField/);
  assert.match(copy.text, /retained/);
});

test("steering drafts stay with their own chat when worker IDs repeat across tabs", () => {
  const ui = setup();
  ui.snapshot({ agents: [worker()], selectedId: "worker-1" });
  const input = ui.doc.querySelector('[data-role="steering-input"]');
  input.value = "Only for the first chat";
  input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  ui.bridge.currentTabId = "tab-b";
  // A tab's roster can arrive before its ready/config payload.
  ui.snapshot({ agents: [worker()], selectedId: "worker-1" });
  assert.equal(ui.doc.querySelector('[data-role="steering-input"]').value, "");
  ui.bridge.currentTabId = "tab-a";
  ui.snapshot({ agents: [worker()], selectedId: "worker-1" });
  assert.equal(ui.doc.querySelector('[data-role="steering-input"]').value, "Only for the first chat");
});

test("an inspector action error remains visible through passive refresh until dismissed", () => {
  const ui = setup();
  ui.snapshot({ error: "Cancellation failed" });
  ui.snapshot();
  assert.equal(ui.doc.querySelector('[role="alert"]').hidden, false);
  assert.match(ui.doc.querySelector('[role="alert"]').textContent, /Cancellation failed/);
  ui.click('[data-action="dismiss-error"]');
  assert.equal(ui.doc.querySelector('[role="alert"]').hidden, true);
});

test("the selected advisor transcript can minimize while copy and export stay available", () => {
  const ui = setup();
  const advisor = worker({ id: "advisor", name: "Reviewer", kind: "advisor", canSteer: false, canCancel: false });
  ui.snapshot({ agents: [advisor], selectedId: advisor.id, transcript: {
    agentId: advisor.id, readOnly: true, messages: [{ role: "assistant", content: "Review complete" }],
  } });
  const toggle = ui.doc.querySelector('[data-action="toggle-transcript"]');
  assert.ok(toggle, "The selected transcript needs its own collapse button");
  assert.equal(toggle.tagName, "BUTTON");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.match(toggle.getAttribute("aria-label"), /Reviewer/);
  const transcript = ui.doc.getElementById(toggle.getAttribute("aria-controls"));
  assert.equal(transcript, ui.doc.querySelector('[data-role="transcript"]'));
  ui.click('[data-action="copy-transcript"]');
  assert.equal(transcript.hidden, false, "Copy must not toggle the transcript");
  toggle.click();
  assert.equal(transcript.hidden, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.textContent, "Expand");
  assert.equal(ui.doc.querySelector('[data-action="copy-transcript"]').closest("[hidden]"), null);
  assert.equal(ui.doc.querySelector('[data-action="export"]').closest("[hidden]"), null);
  ui.click('[data-action="copy-transcript"]');
  ui.click('[data-action="export"]');
  assert.equal(transcript.hidden, true, "Copy and Export must leave the collapsed state unchanged");
  assert.equal(ui.sent.at(-1).type, "exportAgentTranscript");
  toggle.click();
  assert.equal(transcript.hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
});

test("transcript collapse choices survive refresh and belong to their own agent and tab", () => {
  const ui = setup();
  const first = worker({ id: "advisor", name: "Reviewer", kind: "advisor", canSteer: false, canCancel: false });
  const second = worker({ id: "worker-2", name: "Second worker" });
  const transcript = (id, text) => ({ agentId: id, readOnly: id === first.id, messages: [{ role: "assistant", content: text }] });
  ui.snapshot({ agents: [first, second], selectedId: first.id, transcript: transcript(first.id, "First review") });
  ui.click('[data-action="toggle-transcript"]');
  ui.snapshot({ agents: [first, second], selectedId: first.id, transcript: transcript(first.id, "Updated review") });
  assert.equal(ui.doc.querySelector('[data-role="transcript"]').hidden, true);
  ui.click('[data-agent-id="worker-2"]');
  ui.snapshot({ agents: [first, second], selectedId: second.id, transcript: transcript(second.id, "Worker transcript") });
  assert.equal(ui.doc.querySelector('[data-role="transcript"]').hidden, false, "A new selection starts expanded");
  ui.click('[data-agent-id="advisor"]');
  ui.snapshot({ agents: [first, second], selectedId: first.id, transcript: transcript(first.id, "Updated review") });
  assert.equal(ui.doc.querySelector('[data-role="transcript"]').hidden, true, "Returning to an agent restores its choice");
  ui.bridge.currentTabId = "tab-b";
  ui.snapshot({ agents: [first], selectedId: first.id, transcript: transcript(first.id, "Other chat review") });
  assert.equal(ui.doc.querySelector('[data-role="transcript"]').hidden, false, "Repeated IDs in another tab start expanded");
  ui.bridge.currentTabId = "tab-a";
  ui.snapshot({ agents: [first, second], selectedId: first.id, transcript: transcript(first.id, "Updated review") });
  assert.equal(ui.doc.querySelector('[data-role="transcript"]').hidden, true, "Returning to the original tab restores collapse");
});

test("collapsed transcript updates preserve scroll, open raw blocks, and steering drafts", () => {
  const ui = setup();
  const initial = { agentId: "worker-1", readOnly: false, messages: [{ id: "m1", role: "assistant", content: "Working" }] };
  ui.snapshot({ agents: [worker()], selectedId: "worker-1", transcript: initial });
  const input = ui.doc.querySelector('[data-role="steering-input"]');
  input.value = "Unsent direction";
  input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  input.focus();
  input.setSelectionRange(3, 7);
  const transcriptEl = ui.doc.querySelector('[data-role="transcript"]');
  // A hidden browser viewport can report zero scroll offsets and ignore writes.
  let visibleScrollTop = 48;
  Object.defineProperty(transcriptEl, "scrollTop", {
    get: () => transcriptEl.hidden ? 0 : visibleScrollTop,
    set: value => { if (!transcriptEl.hidden) visibleScrollTop = value; },
  });
  Object.defineProperty(transcriptEl, "scrollHeight", { get: () => transcriptEl.hidden ? 0 : 200 });
  Object.defineProperty(transcriptEl, "clientHeight", { get: () => transcriptEl.hidden ? 0 : 100 });
  ui.doc.querySelector('[data-raw-message]').open = true;
  ui.click('[data-action="toggle-transcript"]');
  ui.snapshot({ agents: [worker()], transcript: { ...initial, messages: [
    { id: "m1", role: "assistant", content: "Still working" },
    { id: "m2", role: "assistant", content: "Another update" },
  ] } });
  assert.equal(ui.doc.querySelector('[data-role="steering-input"]'), input);
  assert.equal(input.value, "Unsent direction");
  assert.equal(input.selectionStart, 3);
  assert.equal(ui.doc.querySelector('[data-action="cancel"]').closest("[hidden]"), null);
  ui.click('[data-action="toggle-transcript"]');
  assert.equal(transcriptEl.scrollTop, 48);
  assert.equal(ui.doc.querySelector('[data-raw-message="0"]').open, true);
  assert.match(transcriptEl.textContent, /Another update/);
});
