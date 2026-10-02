const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

function setup() {
  const provider = fs.readFileSync(path.join(__dirname, "../src/chat/chatViewProvider.ts"), "utf8");
  const html = provider.slice(provider.indexOf("<!DOCTYPE html>"), provider.indexOf("</html>") + 7).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const sent = [];
  dom.window.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message) });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.eval(fs.readFileSync(path.join(__dirname, "../media/chat.js"), "utf8"));
  const doc = dom.window.document;
  const input = doc.querySelector("#input");
  const receive = data => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data }));
  const ready = (tab = "tab-a", status = "ready") => receive({ type: "ready", activeTabId: tab, status: { state: status }, tabs: [{ id: tab, status, busy: status === "busy" }], messages: [] });
  const type = (text, offset = text.length) => {
    input.textContent = text;
    input.focus();
    const range = doc.createRange();
    range.setStart(input.firstChild, offset);
    range.collapse(true);
    dom.window.getSelection().removeAllRanges();
    dom.window.getSelection().addRange(range);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const request = () => sent.findLast(message => message.type === "getSlashCommands");
  const catalog = (commands, extra = {}) => {
    const current = request();
    assert.ok(current, "Typing / must request the active OMP catalog");
    receive({ type: "slashCommands", requestId: current.requestId, tabId: current.tabId, commands, ...extra });
  };
  const key = value => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  ready();
  return { dom, doc, input, sent, receive, ready, type, request, catalog, key };
}

const skill = { name: "skill:agents/graphify-windows", description: "Explore the knowledge graph", source: "skill" };

test("typing / discovers OMP skills and commands for the active tab", () => {
  const ui = setup();
  ui.type("/");
  assert.equal(ui.doc.querySelector("#suggest").hidden, false);
  assert.equal(ui.request()?.tabId, "tab-a");
  ui.catalog([skill, { name: "advisor", source: "builtin", description: "Configure advisor" }]);
  assert.match(ui.doc.querySelector("#suggestList").textContent, /\/skill:agents\/graphify-windows/);
  assert.match(ui.doc.querySelector("#suggestList").textContent, /Explore the knowledge graph/);
});

test("skill completion matches a short name and inserts its exact invocation without running it", () => {
  const ui = setup();
  ui.type("/graphify");
  ui.catalog([skill]);
  const before = ui.sent.length;
  ui.key("Tab");
  assert.equal(ui.input.textContent, "/skill:agents/graphify-windows ");
  assert.equal(ui.sent.length, before, "Choosing a skill must leave room for task arguments");
  assert.equal(ui.doc.querySelector("#suggest").hidden, true);
  ui.key("Enter");
  assert.equal(ui.sent.at(-1).type, "send");
  assert.equal(ui.sent.at(-1).text.trim(), "/skill:agents/graphify-windows");
});

test("completion before existing arguments respects the real contenteditable caret", () => {
  const ui = setup();
  ui.type("/Ship existing task", 5);
  ui.catalog([{ name: "ShipRelease", description: "Release template", source: "custom" }]);
  ui.doc.querySelector("#suggestList .suggest-item").click();
  assert.equal(ui.input.textContent, "/ShipRelease existing task");
  ui.key("Enter");
  assert.equal(ui.sent.at(-1).text, "/ShipRelease existing task");
});

test("a late catalog response cannot expose another profile's skills", () => {
  const ui = setup();
  ui.type("/");
  const old = ui.request();
  assert.ok(old);
  ui.ready("tab-b");
  assert.equal(ui.doc.querySelector("#suggest").hidden, true);
  ui.type("/");
  ui.receive({ type: "slashCommands", tabId: old.tabId, requestId: old.requestId, commands: [skill] });
  assert.doesNotMatch(ui.doc.querySelector("#suggestList").textContent, /graphify/);
  ui.catalog([{ name: "skill:profile-b", source: "skill" }]);
  assert.match(ui.doc.querySelector("#suggestList").textContent, /profile-b/);
  assert.doesNotMatch(ui.doc.querySelector("#suggestList").textContent, /graphify/);
});

test("runtime commands retain their own names when an IDE shortcut has the same name", () => {
  const ui = setup();
  ui.type("/model");
  ui.catalog([{ name: "model", source: "builtin", description: "OMP model command" }]);
  const labels = [...ui.doc.querySelectorAll(".suggest-title")].map(item => item.textContent);
  assert.ok(labels.includes("/model"));
  assert.ok(labels.includes("/ide:model"));
  ui.key("Tab");
  assert.equal(ui.input.textContent, "/model ");
  assert.equal(ui.sent.at(-1).type, "getSlashCommands");
});

test("catalog failure stays visible without disabling ordinary command submission", () => {
  const ui = setup();
  ui.type("/skill:known");
  ui.catalog([], { error: "Catalog unavailable" });
  assert.equal(ui.doc.querySelector("#suggest").hidden, false);
  assert.match(ui.doc.querySelector("#suggest").textContent, /Catalog unavailable/);
  ui.key("Enter");
  assert.equal(ui.sent.at(-1).type, "send");
  assert.equal(ui.sent.at(-1).text, "/skill:known");
});

test("typing slash after prose discovers commands without changing the draft", () => {
  const ui = setup();
  ui.type("Please investigate using /");
  assert.equal(ui.request()?.tabId, "tab-a");
  ui.catalog([skill]);
  assert.equal(ui.doc.querySelector("#suggest").hidden, false);
  assert.match(ui.doc.querySelector("#suggestList").textContent, /graphify-windows/);
  assert.equal(ui.input.textContent, "Please investigate using /");
});

test("inline skill completion preserves prose before the token and arguments after the caret", () => {
  const ui = setup();
  const prefix = "Please investigate using ";
  ui.type(prefix + "/graphify the architecture", prefix.length + 9);
  ui.catalog([skill]);
  const before = ui.sent.length;
  ui.key("Tab");
  assert.equal(ui.input.textContent, prefix + "/skill:agents/graphify-windows the architecture");
  assert.equal(ui.sent.length, before, "Completion must not run or send an inline skill");
  ui.key("Enter");
  assert.equal(ui.sent.at(-1).text, prefix + "/skill:agents/graphify-windows the architecture");
});

test("inline completion uses the token at the caret when a prompt has earlier slash tokens", () => {
  const ui = setup();
  const prefix = "Compare /skill:earlier with ";
  ui.type(prefix + "/graphify");
  ui.catalog([skill]);
  ui.doc.querySelector("#suggestList .suggest-item").click();
  assert.equal(ui.input.textContent, prefix + "/skill:agents/graphify-windows ");
});

test("inline completion replaces the whole slash token when editing within its name", () => {
  const ui = setup();
  const prefix = "Please use ";
  ui.type(prefix + "/graphify for this task", prefix.length + 4);
  ui.catalog([skill]);
  ui.key("Tab");
  assert.equal(ui.input.textContent, prefix + "/skill:agents/graphify-windows for this task");
});

test("completion inside a slash name retains adjacent prose punctuation", () => {
  const ui = setup();
  for (const suffix of [", then continue", ".", ") then continue"]) {
    const prefix = "Please use ";
    ui.type(prefix + "/graphify" + suffix, prefix.length + 4);
    ui.catalog([skill]);
    ui.key("Tab");
    assert.equal(ui.input.textContent, prefix + "/skill:agents/graphify-windows " + suffix);
  }
});

test("slash completion on a later contenteditable line preserves the full multiline prompt", () => {
  const ui = setup();
  ui.input.innerHTML = "<div>Investigate the project.</div><div>Use /graphify for this task</div>";
  const range = ui.doc.createRange();
  range.setStart(ui.input.lastChild.firstChild, 13);
  range.collapse(true);
  ui.dom.window.getSelection().removeAllRanges();
  ui.dom.window.getSelection().addRange(range);
  ui.input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  ui.catalog([skill]);
  ui.key("Tab");
  ui.key("Enter");
  assert.equal(ui.sent.at(-1).text, "Investigate the project.\nUse /skill:agents/graphify-windows for this task");
});

test("slashes within URLs, paths and fractions do not open command completion", () => {
  const ui = setup();
  for (const text of ["Read https://example.com/commands", "Check src/commands", "Use C:/tools/commands", "Read ./commands", "Read ../commands", "Compute 3/4"]) {
    ui.type(text);
    assert.equal(ui.request(), undefined, text);
    assert.equal(ui.doc.querySelector("#suggest").hidden, true, text);
  }
});

test("late command discovery cannot reopen a popup after the queue menu takes focus", () => {
  const ui = setup();
  ui.receive({ type: "ready", activeTabId: "tab-a", status: { state: "busy" }, tabs: [{ id: "tab-a", busy: true }], messages: [{ id: "queued-1", role: "user", queued: true, parts: [{ kind: "text", text: "Next task" }] }] });
  ui.type("/");
  const pending = ui.request();
  ui.doc.querySelector("#queueToggle").click();
  assert.equal(ui.doc.querySelector("#queueMenu").hidden, false);
  ui.receive({ ...pending, type: "slashCommands", commands: [skill] });
  assert.equal(ui.doc.querySelector("#queueMenu").hidden, false);
  assert.equal(ui.doc.querySelector("#suggest").hidden, true);
});

test("Enter waits for runtime discovery instead of choosing a matching IDE shortcut", () => {
  const ui = setup();
  ui.type("/model");
  const before = ui.sent.length;
  ui.key("Enter");
  assert.equal(ui.sent.length, before);
  assert.equal(ui.input.textContent, "/model");
  ui.catalog([{ name: "model", source: "builtin" }]);
  ui.key("Tab");
  assert.equal(ui.input.textContent, "/model ");
});

test("Escape dismisses an empty or failed discovery popup", () => {
  const ui = setup();
  ui.type("/nothing-matches");
  ui.catalog([], { error: "Catalog unavailable" });
  assert.equal(ui.doc.querySelector("#suggest").hidden, false);
  ui.key("Escape");
  assert.equal(ui.doc.querySelector("#suggest").hidden, true);
  assert.equal(ui.input.textContent, "/nothing-matches");
});

test("skill completion keeps uploaded image chips and their attachment state", () => {
  const ui = setup();
  const text = "Inspect this image using /graphify";
  ui.type(text);
  ui.receive({ type: "inlineImage", attachment: { id: "image-a", kind: "image", label: "Example", previewDataUrl: "data:image/png;base64,AA==" } });
  const range = ui.doc.createRange();
  range.setStart(ui.input.firstChild, text.length);
  range.collapse(true);
  ui.dom.window.getSelection().removeAllRanges();
  ui.dom.window.getSelection().addRange(range);
  ui.input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  ui.catalog([skill]);
  ui.key("Tab");
  assert.match(ui.input.textContent, /^Inspect this image using \/skill:agents\/graphify-windows /);
  assert.ok(ui.input.querySelector('.image-chip[data-attachment-id="image-a"]'));
  ui.input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  assert.equal(ui.sent.some(message => message.type === "removeAttachment" && message.id === "image-a"), false);
});

test("nested contenteditable paragraphs keep the caret before existing command arguments", () => {
  const ui = setup();
  ui.input.innerHTML = "<div>/Ship existing task</div>";
  const range = ui.doc.createRange();
  range.setStart(ui.input.firstChild.firstChild, 5);
  range.collapse(true);
  ui.dom.window.getSelection().removeAllRanges();
  ui.dom.window.getSelection().addRange(range);
  ui.input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  ui.catalog([{ name: "ShipRelease", source: "custom" }]);
  ui.key("Tab");
  assert.equal(ui.input.textContent, "/ShipRelease existing task");
});
