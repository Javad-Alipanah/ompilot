const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

function setup(t) {
  const provider = fs.readFileSync(path.join(__dirname, "../src/chat/chatViewProvider.ts"), "utf8");
  const html = provider.slice(provider.indexOf("<!DOCTYPE html>"), provider.indexOf("</html>") + 7)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const sent = [];
  dom.window.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message) });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  dom.window.setTimeout = (callback, delay = 0) => {
    const id = ++timerId;
    timers.set(id, { callback, at: now + delay });
    return id;
  };
  dom.window.clearTimeout = id => timers.delete(id);
  dom.window.eval(fs.readFileSync(path.join(__dirname, "../media/chat.js"), "utf8"));
  const doc = dom.window.document;
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: {
    type: "ready", activeTabId: "tab-a", status: { state: "busy" },
    tabs: [{ id: "tab-a", status: "busy", busy: true }], messages: [],
  } }));
  const files = { types: ["Files"], files: [], items: [{ kind: "file" }] };
  const drag = (type, transfer = files, relatedTarget = null, target = doc.querySelector("#input")) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { dataTransfer: { value: transfer }, relatedTarget: { value: relatedTarget } });
    target.dispatchEvent(event);
    return event;
  };
  const advance = milliseconds => {
    now += milliseconds;
    for (const [id, timer] of timers) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  return { dom, doc, sent, drag, advance, overlay: doc.querySelector("#dropOverlay") };
}

test("repeated dragover events cannot strand the attachment overlay after leaving", t => {
  const ui = setup(t);
  ui.drag("dragenter");
  for (let i = 0; i < 20; i++) ui.drag("dragover");
  assert.equal(ui.overlay.hidden, false);
  ui.drag("dragleave");
  assert.equal(ui.overlay.hidden, true);
});

test("ordinary text, URL and editor-selection drags do not obscure the chat", t => {
  const ui = setup(t);
  for (const type of ["text/plain", "text/uri-list", "application/vnd.code.editor"]) {
    const transfer = { types: [type], files: [], items: [{ kind: "string" }] };
    assert.equal(ui.drag("dragenter", transfer).defaultPrevented, false);
    assert.equal(ui.drag("dragover", transfer).defaultPrevented, false);
    assert.equal(ui.overlay.hidden, true);
  }
});

test("moving between elements during a file drag keeps the overlay until the drag leaves", t => {
  const ui = setup(t);
  ui.drag("dragenter");
  ui.drag("dragleave", undefined, ui.doc.querySelector("#messages"));
  assert.equal(ui.overlay.hidden, false);
  ui.drag("dragleave");
  assert.equal(ui.overlay.hidden, true);
});

test("Escape dismisses a stuck drop overlay without stopping the agent or clearing a draft", t => {
  const ui = setup(t);
  const input = ui.doc.querySelector("#input");
  input.textContent = "Keep this draft";
  ui.drag("dragenter");
  input.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(ui.overlay.hidden, true);
  assert.equal(input.textContent, "Keep this draft");
  assert.equal(ui.sent.some(message => ["abort", "stop", "restart", "send"].includes(message.type)), false);
});

test("the drop overlay has an accessible dismiss control", t => {
  const ui = setup(t);
  ui.drag("dragenter");
  const dismiss = ui.overlay.querySelector("button");
  assert.ok(dismiss, "A drop overlay must be dismissible without a keyboard");
  assert.match(dismiss.getAttribute("aria-label"), /dismiss/i);
  dismiss.click();
  assert.equal(ui.overlay.hidden, true);
});

test("cancelled drags are cleared on drag end, focus loss, visibility loss or normal interaction", t => {
  const ui = setup(t);
  for (const type of ["dragend", "blur", "pointerdown"]) {
    ui.drag("dragenter");
    ui.dom.window.dispatchEvent(new ui.dom.window.Event(type));
    assert.equal(ui.overlay.hidden, true, type);
  }
  ui.drag("dragenter");
  Object.defineProperty(ui.doc, "hidden", { configurable: true, value: true });
  ui.doc.dispatchEvent(new ui.dom.window.Event("visibilitychange"));
  assert.equal(ui.overlay.hidden, true);
});

test("a missing browser leave event expires the overlay while active dragover refreshes it", t => {
  const ui = setup(t);
  ui.drag("dragenter");
  ui.advance(900);
  assert.equal(ui.overlay.hidden, false);
  ui.drag("dragover");
  ui.advance(900);
  assert.equal(ui.overlay.hidden, false);
  ui.advance(101);
  assert.equal(ui.overlay.hidden, true);
});

test("an actual file drop still attaches paths and removes the overlay immediately", t => {
  const ui = setup(t);
  ui.drag("dragenter");
  const event = ui.drag("drop", { types: ["Files"], files: [{ path: "/tmp/example.txt" }] });
  assert.equal(event.defaultPrevented, true);
  assert.equal(ui.overlay.hidden, true);
  assert.equal(ui.sent.at(-1).type, "attachPaths");
  assert.deepEqual([...ui.sent.at(-1).paths], ["/tmp/example.txt"]);
});
