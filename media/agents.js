(() => {
  const root = document.getElementById("agent-inspector");
  const bridge = window.ompWorkbench;
  if (!root || !bridge) return;

  const tabs = new Map();
  let tabId = "";
  let state;
  let renderedAgentId = "";
  let transcriptSignature = "";
  let rosterRequested = false;
  const rows = new Map();

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function button(text, action, title) {
    const node = element("button", "inspector-button", text);
    node.type = "button";
    node.dataset.action = action;
    if (title) node.title = title;
    return node;
  }

  function currentTabId() {
    return String(bridge.currentTabId || "");
  }

  function post(message) {
    const current = currentTabId();
    // A tab switch must never redirect a control belonging to the previous tab.
    if (!current || current !== tabId) return;
    bridge.postMessage(Object.assign({}, message, { tabId: current }));
  }

  function newState() {
    return {
      agents: [],
      notices: [],
      selectedId: "",
      transcript: null,
      error: "",
      dismissedError: "",
      loading: false,
      drafts: new Map(),
      transcriptViews: new Map(),
    };
  }

  const shell = element("details", "inspector-shell");
  shell.open = true;
  const summary = element("summary", "inspector-summary");
  summary.append(element("span", "inspector-title", "Agent inspector"));
  const count = element("span", "inspector-count", "No agents");
  summary.append(count);
  const body = element("div", "inspector-body");
  const toolbar = element("div", "inspector-toolbar");
  toolbar.setAttribute("role", "group");
  toolbar.setAttribute("aria-label", "Agent and workflow controls");
  toolbar.append(
    button("Refresh", "refresh", "Refresh workers, advisors, and the selected transcript"),
    button("Advisor on", "advisor-on"),
    button("Advisor off", "advisor-off"),
    button("Advisor status", "advisor-status"),
    button("Arm prewalk", "prewalk"),
    button("Review changes", "review", "Open the workspace changes in the editor"),
  );
  const errorEl = element("div", "inspector-error");
  errorEl.setAttribute("role", "alert");
  errorEl.hidden = true;
  const errorText = element("span", "inspector-error-text");
  errorEl.append(errorText, button("Dismiss", "dismiss-error", "Dismiss this inspector error"));
  const notices = element("div", "inspector-notices");
  notices.setAttribute("aria-label", "Prewalk and advisor notices");
  const layout = element("div", "inspector-layout");
  const rosterPanel = element("details", "inspector-roster-panel");
  rosterPanel.open = true;
  rosterPanel.append(element("summary", "inspector-subheading", "Workers & advisors"));
  const roster = element("div", "inspector-roster");
  roster.setAttribute("role", "group");
  roster.setAttribute("aria-label", "Worker hierarchy and advisors");
  rosterPanel.append(roster);
  const viewer = element("section", "inspector-viewer");
  viewer.setAttribute("aria-label", "Selected agent transcript");
  const viewerHeading = element("div", "inspector-viewer-heading");
  const agentName = element("strong", "inspector-agent-name", "Select an agent");
  const agentMeta = element("div", "inspector-agent-meta");
  const headingText = element("div", "inspector-heading-text");
  headingText.append(agentName, agentMeta);
  const transcriptActions = element("div", "inspector-transcript-actions");
  transcriptActions.setAttribute("role", "group");
  transcriptActions.setAttribute("aria-label", "Transcript display and export controls");
  const collapseButton = button(
    "Minimize",
    "toggle-transcript",
    "Minimize the selected transcript",
  );
  collapseButton.setAttribute("aria-controls", "inspector-selected-transcript");
  const copyButton = button("Copy", "copy-transcript", "Copy the complete raw transcript as JSON");
  const exportButton = button("Export", "export", "Export the complete selected transcript");
  transcriptActions.append(collapseButton, copyButton, exportButton);
  viewerHeading.append(headingText, transcriptActions);
  const transcriptEl = element("div", "inspector-transcript");
  transcriptEl.id = "inspector-selected-transcript";
  transcriptEl.dataset.role = "transcript";
  transcriptEl.tabIndex = 0;
  transcriptEl.setAttribute("role", "region");
  transcriptEl.setAttribute("aria-label", "Transcript messages");
  const controls = element("div", "inspector-controls");
  viewer.append(viewerHeading, transcriptEl, controls);
  layout.append(rosterPanel, viewer);
  body.append(toolbar, errorEl, notices, layout);
  shell.append(summary, body);
  root.replaceChildren(shell);

  function syncTab() {
    const next = currentTabId();
    if (next === tabId && state) return false;
    tabId = next;
    if (!tabs.has(next)) tabs.set(next, newState());
    state = tabs.get(next);
    renderedAgentId = "";
    transcriptSignature = "";
    rosterRequested = false;
    render();
    return true;
  }

  function selectedAgent() {
    return state.agents.find((agent) => agent.id === state.selectedId);
  }

  function selectedTranscriptView() {
    if (!state.selectedId) return { collapsed: false, scrollTop: 0 };
    let view = state.transcriptViews.get(state.selectedId);
    if (!view) {
      view = { collapsed: false, scrollTop: 0 };
      state.transcriptViews.set(state.selectedId, view);
    }
    return view;
  }

  function statusClass(status) {
    const value = String(status || "unknown").toLowerCase();
    if (/error|fail/.test(value)) return "error";
    if (/complete|done|finished/.test(value)) return "completed";
    if (/run|busy|working/.test(value)) return "running";
    return "idle";
  }

  function renderRoster() {
    const byId = new Map(state.agents.map((agent) => [agent.id, agent]));
    const visible = new Set();
    const ordered = [];
    function visit(agent, depth) {
      if (visible.has(agent.id)) return;
      visible.add(agent.id);
      ordered.push({ agent, depth });
      for (const child of state.agents) {
        if (child.parentId === agent.id && child.kind !== "advisor") visit(child, depth + 1);
      }
    }
    for (const agent of state.agents) {
      if (agent.kind === "advisor" || !agent.parentId || !byId.has(agent.parentId)) visit(agent, 0);
    }
    // Broken/cyclic parent links are still inspectable.
    for (const agent of state.agents) visit(agent, 0);
    for (const [id, row] of rows) {
      if (!byId.has(id)) {
        row.remove();
        rows.delete(id);
      }
    }
    if (ordered.length === 0) {
      roster.replaceChildren(
        element("p", "inspector-empty", "No workers or advisors reported for this chat."),
      );
      rows.clear();
      return;
    }
    roster.querySelectorAll(".inspector-empty").forEach((node) => {
      node.remove();
    });
    ordered.forEach(({ agent, depth }, index) => {
      let row = rows.get(agent.id);
      if (!row) {
        row = button("", "select");
        row.className = "inspector-agent";
        row.dataset.agentId = agent.id;
        row.append(
          element("span", "inspector-agent-label"),
          element("span", "inspector-agent-detail"),
        );
        rows.set(agent.id, row);
      }
      row.style.setProperty("--agent-depth", String(Math.min(depth, 12)));
      row.classList.toggle("selected", agent.id === state.selectedId);
      row.setAttribute("aria-pressed", String(agent.id === state.selectedId));
      const name = String(agent.name || agent.id);
      const status = String(agent.status || "unknown");
      const kind = agent.kind === "advisor" ? "Advisor" : "Worker";
      const parent = byId.get(agent.parentId);
      row.setAttribute(
        "aria-label",
        `${name}, ${kind}, ${status}${agent.model ? `, ${agent.model}` : ""}${parent ? `, child of ${parent.name || parent.id}` : ""}`,
      );
      row.title = `${kind}: ${name}${agent.sessionFile ? `\nSession: ${agent.sessionFile}` : ""}`;
      row.firstElementChild.textContent = name;
      row.lastElementChild.textContent = `${kind} · ${status}${agent.model ? ` · ${agent.model}` : ""}`;
      row.dataset.status = statusClass(status);
      if (roster.children[index] !== row) roster.insertBefore(row, roster.children[index] || null);
    });
  }

  function pretty(value) {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
  }

  function rawBlock(label, value, key) {
    const details = element("details", "inspector-raw");
    details.dataset.blockKey = key;
    details.append(element("summary", "", label), element("pre", "", pretty(value)));
    return details;
  }

  function markdown(text) {
    const bubble = element("div", "bubble inspector-message-text");
    // The main chat renderer escapes source text and only emits its own markdown DOM.
    if (typeof bridge.renderMarkdown === "function")
      bubble.innerHTML = bridge.renderMarkdown(String(text));
    else bubble.textContent = String(text);
    return bubble;
  }

  function messageNode(raw, index) {
    const message =
      raw && typeof raw === "object" && raw.message && typeof raw.message === "object"
        ? raw.message
        : raw;
    const value = message && typeof message === "object" ? message : { content: message };
    const role = String(value.role || value.type || "message");
    const toolResult = /^(tool|toolResult|tool_result)$/i.test(role);
    const article = element("article", "inspector-message");
    const heading = element(
      "div",
      "inspector-message-heading",
      `${index + 1} · ${role}${value.toolName ? ` · ${value.toolName}` : ""}`,
    );
    const stamp = value.timestamp ?? value.createdAt;
    if (stamp !== undefined) {
      const time = element("span", "inspector-message-time", String(stamp));
      const date = new Date(stamp);
      if (!Number.isNaN(date.getTime())) time.textContent = date.toLocaleString();
      heading.append(time);
    }
    article.append(heading);
    const key = `${index}:${value.id || value.toolCallId || "message"}`;
    const content = value.content ?? value.parts ?? value.text;
    if (toolResult) {
      article.append(
        rawBlock("Tool output", content ?? value.output ?? value.result ?? value, `${key}:output`),
      );
    } else {
      const parts = Array.isArray(content) ? content : [content];
      parts.forEach((part, partIndex) => {
        const partKey = `${key}:part:${partIndex}`;
        if (typeof part === "string") {
          article.append(markdown(part));
          return;
        }
        if (!part || typeof part !== "object") {
          if (part != null) article.append(rawBlock("Content", part, partKey));
          return;
        }
        const kind = String(part.type || part.kind || "");
        if (kind === "text") article.append(markdown(part.text || ""));
        else if (kind === "thinking" || kind === "reasoning")
          article.append(
            rawBlock("Thinking", part.thinking ?? part.text ?? part.reasoning ?? part, partKey),
          );
        else if (/^(toolCall|tool_call|tool_use|tool)$/.test(kind)) {
          const tool = element("div", "inspector-tool");
          tool.append(element("strong", "", `Tool · ${part.name || part.toolName || "unknown"}`));
          tool.append(
            rawBlock(
              "Arguments",
              part.arguments ?? part.input ?? part.inputPreview ?? {},
              `${partKey}:arguments`,
            ),
          );
          if (
            part.output !== undefined ||
            part.result !== undefined ||
            part.outputPreview !== undefined
          ) {
            tool.append(
              rawBlock(
                "Tool output",
                part.output ?? part.result ?? part.outputPreview,
                `${partKey}:output`,
              ),
            );
          }
          article.append(tool);
        } else article.append(rawBlock(kind || "Content", part, partKey));
      });
      if (value.thinking !== undefined)
        article.append(rawBlock("Thinking", value.thinking, `${key}:thinking`));
      if (Array.isArray(value.tool_calls)) {
        value.tool_calls.forEach((call, callIndex) => {
          article.append(
            rawBlock(
              `Tool · ${call.function?.name || call.name || "unknown"} · Arguments`,
              call.function?.arguments ?? call,
              `${key}:call:${callIndex}`,
            ),
          );
        });
      }
    }
    const rawDetails = rawBlock("Full raw message", raw, `${key}:raw`);
    rawDetails.dataset.rawMessage = String(index);
    article.append(rawDetails);
    return article;
  }

  function renderTranscript() {
    const transcript = state.transcript?.agentId === state.selectedId ? state.transcript : null;
    const signature = JSON.stringify([
      state.selectedId,
      transcript?.messages ?? null,
      state.loading,
    ]);
    if (signature === transcriptSignature) return;
    const sameAgent = renderedAgentId === state.selectedId;
    const view = selectedTranscriptView();
    const scrollTop = view.collapsed ? view.scrollTop : transcriptEl.scrollTop;
    const nearBottom =
      !view.collapsed && transcriptEl.scrollHeight - transcriptEl.clientHeight - scrollTop < 60;
    const openBlocks = new Set();
    transcriptEl.querySelectorAll("details[open]").forEach((details) => {
      openBlocks.add(details.dataset.blockKey);
    });
    const focusKey = transcriptEl.contains(document.activeElement)
      ? document.activeElement.closest("[data-block-key]")?.dataset.blockKey
      : null;
    const fragment = document.createDocumentFragment();
    if (!state.selectedId)
      fragment.append(
        element(
          "p",
          "inspector-empty",
          "Select a worker or advisor to explore its complete transcript.",
        ),
      );
    else if (!transcript)
      fragment.append(
        element(
          "p",
          "inspector-empty",
          state.loading
            ? "Reading the selected transcript…"
            : "No transcript has been received. Refresh to read it.",
        ),
      );
    else if (!transcript.messages?.length)
      fragment.append(element("p", "inspector-empty", "This transcript has no messages."));
    else
      transcript.messages.forEach((message, index) => {
        fragment.append(messageNode(message, index));
      });
    transcriptEl.replaceChildren(fragment);
    if (sameAgent) {
      transcriptEl.querySelectorAll("details").forEach((details) => {
        details.open = openBlocks.has(details.dataset.blockKey);
        if (focusKey === details.dataset.blockKey) details.querySelector("summary").focus();
      });
      transcriptEl.scrollTop = nearBottom && scrollTop > 0 ? transcriptEl.scrollHeight : scrollTop;
    } else transcriptEl.scrollTop = 0;
    if (!view.collapsed) view.scrollTop = transcriptEl.scrollTop;
    renderedAgentId = state.selectedId;
    transcriptSignature = signature;
  }

  function renderControls(agent) {
    const readOnly = agent?.kind === "advisor" || state.transcript?.readOnly === true;
    const canSteer = agent && !readOnly && agent.canSteer === true;
    const canCancel = agent && !readOnly && agent.canCancel === true;
    const signature = `${tabId}:${agent?.id || ""}:${readOnly}:${Boolean(canSteer)}:${Boolean(canCancel)}`;
    if (controls.dataset.signature === signature) return;
    controls.dataset.signature = signature;
    controls.replaceChildren();
    if (!agent) return;
    if (readOnly) {
      controls.append(
        element(
          "p",
          "inspector-readonly",
          agent.kind === "advisor"
            ? "Read-only advisor · inspect and export its conversation."
            : "This transcript is read-only.",
        ),
      );
      return;
    }
    if (canSteer) {
      const label = element("label", "inspector-steer-label", "Steer this worker");
      const input = element("textarea", "inspector-steer-input");
      input.dataset.role = "steering-input";
      input.rows = 2;
      input.placeholder = "Send a direction to this worker…";
      input.value = state.drafts.get(agent.id) || "";
      label.append(input);
      const send = button("Send direction", "steer");
      send.disabled = !input.value.trim();
      input.addEventListener("input", () => {
        state.drafts.set(agent.id, input.value);
        send.disabled = !input.value.trim();
      });
      controls.append(label, send);
    }
    if (canCancel)
      controls.append(button("Cancel worker", "cancel", "Cancel this worker's active task"));
    if (!canSteer && !canCancel)
      controls.append(
        element(
          "p",
          "inspector-readonly",
          "This worker is not accepting direction or cancellation.",
        ),
      );
  }

  function renderNotices() {
    const signature = JSON.stringify(state.notices);
    if (notices.dataset.signature === signature) return;
    notices.dataset.signature = signature;
    notices.replaceChildren();
    notices.hidden = !state.notices.length;
    if (!state.notices.length) return;
    const history = element("details", "inspector-notice-history");
    history.append(
      element(
        "summary",
        "",
        `${state.notices.length} workflow notice${state.notices.length === 1 ? "" : "s"}`,
      ),
    );
    const list = element("ol", "");
    state.notices.forEach((notice) => {
      const row = element("li", "");
      row.append(
        element("strong", "", `${notice.source || "Workflow"}: `),
        document.createTextNode(String(notice.message || "")),
      );
      if (notice.timestamp !== undefined) row.title = String(notice.timestamp);
      list.append(row);
    });
    history.append(list);
    const latest = state.notices[state.notices.length - 1];
    const latestEl = element(
      "p",
      "inspector-notice-latest",
      `${latest.source || "Workflow"}: ${latest.message || ""}`,
    );
    latestEl.setAttribute("role", "status");
    notices.append(latestEl, history);
  }

  function render() {
    if (!state) return;
    const workers = state.agents.filter((agent) => agent.kind !== "advisor").length;
    const advisors = state.agents.length - workers;
    count.textContent = `${workers} worker${workers === 1 ? "" : "s"} · ${advisors} advisor${advisors === 1 ? "" : "s"}`;
    toolbar.querySelectorAll("button").forEach((node) => {
      node.disabled = !tabId;
    });
    errorText.textContent = state.error || "";
    errorEl.hidden = !state.error;
    renderNotices();
    renderRoster();
    const agent = selectedAgent();
    agentName.textContent = agent ? String(agent.name || agent.id) : "Select an agent";
    agentMeta.textContent = agent
      ? `${agent.kind === "advisor" ? "Advisor" : "Worker"} · ${agent.status || "unknown"}${agent.model ? ` · ${agent.model}` : ""}`
      : "";
    agentMeta.title = agent?.sessionFile || "";
    const view = selectedTranscriptView();
    transcriptEl.hidden = view.collapsed;
    collapseButton.hidden = !agent;
    collapseButton.disabled = !agent;
    collapseButton.textContent = view.collapsed ? "Expand" : "Minimize";
    collapseButton.setAttribute("aria-expanded", String(!view.collapsed));
    collapseButton.setAttribute(
      "aria-label",
      `${view.collapsed ? "Expand" : "Minimize"} transcript for ${agent?.name || agent?.id || "selected agent"}`,
    );
    exportButton.disabled = !agent;
    copyButton.disabled = !agent || state.transcript?.agentId !== state.selectedId;
    renderTranscript();
    renderControls(agent);
  }

  root.addEventListener("click", (event) => {
    const target = event.target.closest("button[data-action]");
    if (!target || !root.contains(target) || target.disabled) return;
    if (syncTab()) {
      post({ type: "inspectAgents" });
      return;
    }
    const action = target.dataset.action;
    const agent = selectedAgent();
    if (action === "dismiss-error") {
      state.dismissedError = state.error;
      state.error = "";
      render();
    } else if (action === "select") {
      const id = target.dataset.agentId;
      if (!state.agents.some((item) => item.id === id)) return;
      if (state.selectedId !== id) {
        state.selectedId = id;
        state.transcript = null;
      }
      state.loading = true;
      render();
      post({ type: "inspectAgent", id });
    } else if (action === "refresh") {
      post({ type: "inspectAgents" });
      if (agent) post({ type: "inspectAgent", id: agent.id });
    } else if (action.startsWith("advisor-"))
      post({ type: "advisorAction", action: action.slice(8) });
    else if (action === "prewalk") post({ type: "prewalkAction" });
    else if (action === "review") post({ type: "reviewChanges" });
    else if (action === "toggle-transcript" && agent) {
      const view = selectedTranscriptView();
      if (!view.collapsed) view.scrollTop = transcriptEl.scrollTop;
      view.collapsed = !view.collapsed;
      render();
      if (!view.collapsed) transcriptEl.scrollTop = view.scrollTop;
    } else if (action === "export" && agent) post({ type: "exportAgentTranscript", id: agent.id });
    else if (action === "copy-transcript" && state.transcript?.agentId === state.selectedId) {
      post({
        type: "copy",
        text: pretty({
          agentId: state.selectedId,
          readOnly: state.transcript.readOnly,
          messages: state.transcript.messages,
        }),
      });
    } else if (
      action === "cancel" &&
      agent?.kind === "worker" &&
      agent.canCancel &&
      !state.transcript?.readOnly
    )
      post({ type: "cancelAgent", id: agent.id });
    else if (
      action === "steer" &&
      agent?.kind === "worker" &&
      agent.canSteer &&
      !state.transcript?.readOnly
    ) {
      const input = controls.querySelector("textarea");
      const message = input?.value.trim();
      if (message) post({ type: "steerAgent", id: agent.id, message });
    } else if (action === "copy-code") {
      const encoded = target.closest(".md-code")?.querySelector(".md-pre")?.dataset.code;
      if (encoded) post({ type: "copy", text: decodeURIComponent(encoded) });
    } else if (action === "insert-code") {
      const encoded = target.closest(".md-code")?.querySelector(".md-pre")?.dataset.code;
      if (encoded) post({ type: "insert", text: decodeURIComponent(encoded) });
    } else if (action === "open-file") {
      const path = target.dataset.path;
      if (path) post({ type: "openFile", path });
    }
  });

  root.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-href], a[href]");
    if (link && root.contains(link)) {
      event.preventDefault();
      post({ type: "openExternal", url: link.dataset.href || link.getAttribute("href") });
    }
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    const changed = syncTab();
    if (
      (message.type === "ready" && !rosterRequested) ||
      (changed && ["tabs", "config"].includes(message.type))
    ) {
      rosterRequested = Boolean(tabId);
      post({ type: "inspectAgents" });
      if (state.selectedId) post({ type: "inspectAgent", id: state.selectedId });
    }
    if (message.type !== "inspection" || !message.snapshot) return;
    const snapshot = message.snapshot;
    if (!tabId || snapshot.tabId !== tabId) return;
    if (Array.isArray(snapshot.agents))
      state.agents = snapshot.agents.filter((agent) => agent && typeof agent.id === "string");
    if (Array.isArray(snapshot.notices)) state.notices = snapshot.notices;
    // Main-chat streaming updates can immediately follow a failed inspector action.
    // Keep its error reviewable until the user explicitly dismisses it.
    if (
      typeof snapshot.error === "string" &&
      snapshot.error &&
      snapshot.error !== state.dismissedError
    )
      state.error = snapshot.error;
    if (!snapshot.error) state.dismissedError = "";
    if (!state.selectedId && snapshot.selectedId) state.selectedId = snapshot.selectedId;
    if (state.selectedId && !selectedAgent()) {
      state.selectedId = "";
      state.transcript = null;
      state.loading = false;
    }
    if (snapshot.transcript && snapshot.transcript.agentId === state.selectedId) {
      state.transcript = snapshot.transcript;
      state.loading = false;
    }
    if (state.error) state.loading = false;
    render();
  });

  syncTab();
})();
