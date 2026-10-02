const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

function setup(t, inspector = false) {
  const provider = fs.readFileSync(path.join(__dirname, "../src/chat/chatViewProvider.ts"), "utf8");
  const html = provider.slice(provider.indexOf("<!DOCTYPE html>"), provider.indexOf("</html>") + 7)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const sent = [];
  dom.window.acquireVsCodeApi = () => ({ postMessage: (message) => sent.push(message) });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.eval(fs.readFileSync(path.join(__dirname, "../media/chat.js"), "utf8"));
  if (inspector) dom.window.eval(fs.readFileSync(path.join(__dirname, "../media/agents.js"), "utf8"));
  const receive = (data) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data }));
  const ready = (messages, showThinking = true) => receive({ type: "ready", activeTabId: "thinking-tab", status: { state: "busy" }, tabs: [], messages, showThinking });
  return { dom, sent, receive, ready, doc: dom.window.document };
}

const assistant = (parts, streaming = true, id = "a1") => ({ id, role: "assistant", createdAt: 1_790_000_000_000, streaming, parts });
const thinking = (text, streaming = true) => ({ kind: "thinking", text, streaming });
const bodies = (ui) => [...ui.doc.querySelectorAll("#messages pre.thinking-body")].map((node) => node.textContent);

test("main thinking streams into its own block and preserves a manual collapse across updates", (t) => {
  const ui = setup(t);
  ui.ready([assistant([thinking("")])]);
  const block = ui.doc.querySelector("#messages .thinking");
  assert.ok(block.classList.contains("live"));
  assert.equal(block.open, true);
  assert.match(block.querySelector("summary").textContent, /Thinking/);
  block.open = false;
  block.dispatchEvent(new ui.dom.window.Event("toggle"));
  ui.receive({ type: "messages", messages: [assistant([thinking("Consider the boundary")])] });
  assert.equal(ui.doc.querySelector("#messages .thinking"), block);
  assert.deepEqual(bodies(ui), ["Consider the boundary"]);
  assert.equal(block.open, false);
  ui.receive({ type: "messages", messages: [assistant([thinking("Consider the boundary", false), { kind: "text", text: "Answer" }], false)] });
  const final = ui.doc.querySelector("#messages .thinking");
  assert.equal(final.open, false);
  assert.equal(final.classList.contains("live"), false);
  assert.deepEqual(bodies(ui), ["Consider the boundary"]);
});

test("showThinking switches every prior and streaming block immediately without deleting content", (t) => {
  const ui = setup(t);
  const messages = [assistant([thinking("Earlier reasoning", false)], false, "old"), assistant([thinking("Live reasoning")])];
  ui.ready(messages);
  assert.deepEqual(bodies(ui), ["Earlier reasoning", "Live reasoning"]);
  ui.receive({ type: "config", showThinking: false });
  assert.deepEqual(bodies(ui), [], "A visibility change must invalidate the streaming patch path");
  ui.receive({ type: "messages", messages: [messages[0], assistant([thinking("Live reasoning updated")])] });
  assert.deepEqual(bodies(ui), []);
  ui.receive({ type: "config", showThinking: true });
  assert.deepEqual(bodies(ui), ["Earlier reasoning", "Live reasoning updated"]);
});

test("separate thinking blocks keep their own text when an assistant resumes thinking", (t) => {
  const ui = setup(t);
  const parts = [thinking("First conclusion", false), { kind: "text", text: "Interim answer" }, thinking("Second pass")];
  ui.ready([assistant(parts)]);
  const blocks = [...ui.doc.querySelectorAll("#messages .thinking")];
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].classList.contains("live"), false);
  assert.equal(blocks[1].classList.contains("live"), true);
  ui.receive({ type: "messages", messages: [assistant([parts[0], parts[1], thinking("Second pass expanded")])] });
  assert.deepEqual(bodies(ui), ["First conclusion", "Second pass expanded"]);
  assert.equal(ui.doc.querySelectorAll("#messages .thinking").length, 2);
});

test("restored main thinking preserves its full text and renders untrusted content as text", (t) => {
  const ui = setup(t);
  const content = '<img src=x onerror="window.compromised=true">\n' + "🧠 reason\n".repeat(2_000) + "FINAL_THINKING_MARKER";
  ui.ready([assistant([{ ...thinking(content, false), durationMs: 3_500 }, { kind: "text", text: "Final answer" }], false)]);
  assert.deepEqual(bodies(ui), [content]);
  assert.equal(ui.doc.querySelector("#messages img"), null);
  assert.match(ui.doc.querySelector("#messages .thinking summary").textContent, /Thought/);
  ui.receive({ type: "config", showThinking: false });
  assert.deepEqual(bodies(ui), []);
  ui.receive({ type: "config", showThinking: true });
  assert.deepEqual(bodies(ui), [content]);
});

test("worker and advisor thinking remains expandable, complete and copyable across transcript refreshes", (t) => {
  const ui = setup(t, true);
  ui.ready([]);
  const agent = (kind) => ({ id: kind, name: kind, kind, status: "running", canSteer: kind === "worker", canCancel: kind === "worker" });
  const content = '<script>window.compromised=true</script>\n' + "🧠 worker reasoning\n".repeat(1_000) + "FINAL_WORKER_MARKER";
  for (const kind of ["worker", "advisor"]) {
    if (kind === "advisor") ui.doc.querySelector('[data-agent-id="advisor"]').click();
    const message = { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: content }, { type: "text", text: "Answer" }] };
    const snapshot = (raw) => ui.receive({ type: "inspection", snapshot: { tabId: "thinking-tab", agents: [agent("worker"), agent("advisor")], selectedId: kind, notices: [], transcript: { agentId: kind, readOnly: kind === "advisor", messages: [raw] } } });
    snapshot({ ...message, streaming: true });
    let block = [...ui.doc.querySelectorAll('#agent-inspector details')].find((node) => node.firstElementChild?.textContent === "Thinking");
    assert.ok(block);
    assert.equal(block.querySelector("pre").textContent, content);
    block.open = true;
    snapshot({ ...message, content: [{ type: "thinking", thinking: content + " UPDATED" }, message.content[1]] });
    block = [...ui.doc.querySelectorAll('#agent-inspector details')].find((node) => node.firstElementChild?.textContent === "Thinking");
    assert.equal(block.open, true);
    assert.equal(block.querySelector("pre").textContent, content + " UPDATED");
    assert.equal(ui.doc.querySelector("#agent-inspector script"), null);
    ui.doc.querySelector('#agent-inspector [data-action="copy-transcript"]').click();
    const copy = ui.sent.findLast((entry) => entry.type === "copy");
    assert.equal(JSON.parse(copy.text).messages[0].content[0].thinking, content + " UPDATED");
    if (kind === "advisor") assert.equal(ui.doc.querySelector('#agent-inspector [data-action="steer"]'), null);
  }
});
