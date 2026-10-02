const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

function setup() {
  const provider = fs.readFileSync(path.join(__dirname, "../src/chat/chatViewProvider.ts"), "utf8");
  const html = provider.slice(provider.indexOf("<!DOCTYPE html>"), provider.indexOf("</html>") + 7)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const sent = [];
  let acquireCount = 0;
  dom.window.acquireVsCodeApi = () => {
    acquireCount += 1;
    return { postMessage: (message) => sent.push(message) };
  };
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.eval(fs.readFileSync(path.join(__dirname, "../media/chat.js"), "utf8"));
  const receive = (data) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data }));
  const ready = (status = "ready", activeTabId = "tab-a") => receive({
    type: "ready", activeTabId, status: { state: status }, tabs: [{ id: activeTabId, title: "Main chat", status, busy: status === "busy" }], messages: [],
  });
  return { dom, sent, ready, receive, doc: dom.window.document, acquired: () => acquireCount };
}

test("main chat shares the one webview API and current active tab with the inspector", () => {
  const ui = setup();
  assert.ok(ui.dom.window.ompWorkbench, "The inspector needs the main chat bridge");
  ui.ready();
  assert.equal(ui.dom.window.ompWorkbench.currentTabId, "tab-a");
  ui.dom.window.ompWorkbench.postMessage({ type: "inspectAgents", tabId: "tab-a" });
  assert.equal(ui.sent.at(-1).type, "inspectAgents");
  assert.doesNotMatch(ui.dom.window.ompWorkbench.renderMarkdown("<img src=x onerror=alert(1)>"), /<img/);
  ui.dom.window.eval(fs.readFileSync(path.join(__dirname, "../media/agents.js"), "utf8"));
  assert.equal(ui.acquired(), 1);
  ui.receive({ type: "tabs", activeTabId: "tab-b", tabs: [{ id: "tab-b", title: "Second", status: "ready" }] });
  assert.equal(ui.dom.window.ompWorkbench.currentTabId, "tab-b");
});

test("profile and config controls show the active profile and block restart while another tab works", () => {
  const ui = setup();
  ui.receive({ type: "ready", activeTabId: "tab-a", profile: "audn", status: { state: "ready" }, tabs: [{ id: "tab-a", busy: false }, { id: "tab-b", busy: true }], messages: [] });
  assert.match(ui.doc.querySelector("#profileLabel").textContent, /audn/);
  assert.equal(ui.doc.querySelector("#profileBtn").disabled, true);
  assert.equal(ui.doc.querySelector("#applyOmpConfigBtn").disabled, true);
  ui.doc.querySelector("#ompConfigBtn").click();
  assert.equal(ui.sent.at(-1).type, "openOmpConfig");
  ui.ready("ready");
  ui.doc.querySelector("#profileBtn").click();
  assert.equal(ui.sent.at(-1).type, "pickProfile");
  ui.doc.querySelector("#applyOmpConfigBtn").click();
  assert.equal(ui.sent.at(-1).type, "applyOmpConfig");
});

test("composer drafts stay in their chat instead of leaking into another profile's new tabs", () => {
  const ui = setup();
  ui.ready("ready", "tab-a");
  const input = ui.doc.querySelector("#input");
  input.textContent = "Private draft for profile A";
  ui.ready("ready", "tab-b");
  assert.equal(input.textContent, "");
  input.textContent = "Draft for profile B";
  ui.ready("ready", "tab-a");
  assert.equal(input.textContent, "Private draft for profile A");
  ui.ready("ready", "new-profile-tab");
  assert.equal(input.textContent, "");
});

test("busy main chat offers immediate steering while Enter continues to queue", () => {
  const ui = setup();
  ui.ready("busy");
  const steer = ui.doc.querySelector("#steerMainBtn");
  assert.ok(steer, "A busy main agent needs an explicit steering control");
  assert.equal(steer.hidden, false);
  const input = ui.doc.querySelector("#input");
  input.textContent = "Focus on the public API";
  input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  steer.click();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.sent.at(-1))), { type: "steerMain", message: "Focus on the public API", tabId: "tab-a" });
  input.textContent = "Then update documentation";
  input.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  assert.equal(ui.sent.at(-1).type, "send");
  assert.equal(ui.sent.at(-1).text, "Then update documentation");
  ui.ready("ready");
  assert.equal(steer.hidden, true);
});

test("steering acknowledgement clears only the matching current-tab composer draft", () => {
  const ui = setup();
  ui.ready("busy");
  const input = ui.doc.querySelector("#input");
  input.textContent = "Review the tests";
  ui.receive({ type: "steeringAccepted", tabId: "tab-b", message: "Review the tests" });
  assert.equal(input.textContent, "Review the tests");
  ui.receive({ type: "steeringAccepted", tabId: "tab-a", message: "Old draft" });
  assert.equal(input.textContent, "Review the tests");
  ui.receive({ type: "steeringAccepted", tabId: "tab-a", message: "Review the tests" });
  assert.equal(input.textContent, "");
});

test("choosing a dirty current-file mention attaches the live buffer rather than a disk chip", async () => {
  const ui = setup();
  ui.ready();
  const input = ui.doc.querySelector("#input");
  input.textContent = "@";
  const range = ui.doc.createRange();
  range.selectNodeContents(input);
  range.collapse(false);
  ui.dom.window.getSelection().removeAllRanges();
  ui.dom.window.getSelection().addRange(range);
  input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 100));
  const search = ui.sent.findLast(message => message.type === "searchFiles");
  assert.ok(search);
  ui.receive({ type: "fileResults", requestId: search.requestId, files: [{ path: "draft.ts", fsPath: "/project/draft.ts", label: "Current file", kind: "file", attach: true }] });
  ui.doc.querySelector(".suggest-item").dispatchEvent(new ui.dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  ui.doc.querySelector(".suggest-item").click();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.sent.at(-1))), { type: "attachPaths", paths: ["/project/draft.ts"] });
  assert.equal(input.querySelector(".mention-chip"), null);
});

function askQuestion(ui, questions) {
  ui.ready("busy");
  ui.receive({ type: "uiQuestion", question: { id: "ask-1", method: "ask", createdAt: Date.now(), questions } });
}

test("structured ask submits one ordered answer per question with single and multiple selections", () => {
  const ui = setup();
  askQuestion(ui, [
    { id: "color", header: "Color", question: "Choose a color", options: [{ label: "Blue", description: "Cool tone", preview: "Blue preview" }, { label: "Green" }], recommended: 0 },
    { id: "checks", question: "Choose checks", options: [{ label: "Build" }, { label: "Tests" }], multi: true },
  ]);
  const color = ui.doc.querySelector('[data-ask-question-id="color"]');
  const checks = ui.doc.querySelector('[data-ask-question-id="checks"]');
  assert.ok(color, "Each structured question needs its own accessible answer group");
  assert.ok(checks);
  assert.match(color.textContent, /Cool tone/);
  assert.match(color.textContent, /Blue preview/);
  assert.match(color.textContent, /Recommended/);
  color.querySelector('input[value="Blue"]').click();
  checks.querySelector('input[value="Build"]').click();
  checks.querySelector('input[value="Tests"]').click();
  ui.doc.querySelector('[data-action="submit-ask"]').click();
  const reply = ui.sent.findLast((message) => message.type === "answerUiQuestion");
  assert.deepEqual(JSON.parse(JSON.stringify(reply.answers)), [
    { id: "color", selectedOptions: ["Blue"] }, { id: "checks", selectedOptions: ["Build", "Tests"] },
  ]);
});

test("structured ask always offers a custom answer and keeps single-select answers exclusive", () => {
  const ui = setup();
  askQuestion(ui, [{ id: "color", question: "Choose a color", options: [{ label: "Blue" }, { label: "Green" }] }]);
  const group = ui.doc.querySelector('[data-ask-question-id="color"]');
  assert.ok(group, "Structured ask must render choices and free text");
  group.querySelector('input[value="Blue"]').click();
  const custom = group.querySelector("textarea");
  custom.value = "Purple instead";
  custom.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  ui.doc.querySelector('[data-action="submit-ask"]').click();
  const reply = ui.sent.findLast((message) => message.type === "answerUiQuestion");
  assert.deepEqual(JSON.parse(JSON.stringify(reply.answers)), [{ id: "color", selectedOptions: [], customInput: "Purple instead" }]);
});

test("structured ask does not submit partial answers and safely renders option metadata", () => {
  const ui = setup();
  const hostile = '<img src=x onerror="alert(1)">';
  askQuestion(ui, [{ id: "one", question: "First", options: [{ label: hostile, description: hostile, preview: hostile }] },
    { id: "two", question: "Second", options: [] }]);
  const button = ui.doc.querySelector('[data-action="submit-ask"]');
  assert.ok(button, "Structured ask must validate the complete answer set");
  ui.doc.querySelector('[data-ask-question-id="one"] input').click();
  assert.equal(button.disabled, true);
  button.click();
  assert.equal(ui.sent.some((message) => message.type === "answerUiQuestion"), false);
  assert.equal(ui.doc.querySelector("#uiQuestion img"), null);
  const custom = ui.doc.querySelector('[data-ask-question-id="two"] textarea');
  custom.value = "Second answer";
  custom.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  assert.equal(button.disabled, false);
  ui.doc.querySelector('#uiQuestion [data-action="cancel"]').click();
  assert.equal(ui.sent.at(-1).cancelled, true);
  assert.equal(ui.sent.at(-1).id, "ask-1");
});

test("main chat state updates preserve a structured ask's focused custom-answer draft", () => {
  const ui = setup();
  const question = { id: "ask-1", method: "ask", createdAt: 100, questions: [
    { id: "scope", question: "Choose a scope", options: [{ label: "Frontend" }, { label: "Backend" }], multi: true },
  ] };
  ui.ready("busy");
  ui.receive({ type: "uiQuestion", question });
  const input = ui.doc.querySelector("#uiQuestion textarea");
  assert.ok(input, "An ask needs a custom-answer field");
  input.value = "Shared types too";
  input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  input.focus();
  input.setSelectionRange(2, 4);
  ui.doc.querySelector('#uiQuestion input[value="Frontend"]').click();
  input.focus();
  ui.receive({ type: "ready", activeTabId: "tab-a", status: { state: "busy" }, messages: [], uiQuestion: question });
  assert.equal(ui.doc.activeElement, input);
  assert.equal(input.value, "Shared types too");
  assert.equal(input.selectionStart, 2);
  ui.doc.querySelector('[data-action="submit-ask"]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.sent.at(-1).answers)), [
    { id: "scope", selectedOptions: ["Frontend"], customInput: "Shared types too" },
  ]);
});
