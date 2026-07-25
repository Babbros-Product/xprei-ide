// @ts-check
// Webview UI script. Renders messages and streams assistant deltas.
(function () {
  const vscode = window.xprei; // host transport shim — see bridge.js

  const messagesEl = /** @type {HTMLElement} */ (document.getElementById("messages"));
  const form = /** @type {HTMLFormElement} */ (document.getElementById("composer"));
  const input = /** @type {HTMLTextAreaElement} */ (document.getElementById("input"));
  const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById("sendBtn"));
  const stopBtn = /** @type {HTMLButtonElement} */ (document.getElementById("stopBtn"));
  const resetBtn = /** @type {HTMLButtonElement} */ (document.getElementById("resetBtn"));
  const modelPicker = /** @type {HTMLElement} */ (document.getElementById("modelPicker"));
  const modelTrigger = /** @type {HTMLButtonElement} */ (document.getElementById("modelTrigger"));
  const modelTriggerLabel = /** @type {HTMLElement} */ (document.getElementById("modelTriggerLabel"));
  const modelPopup = /** @type {HTMLElement} */ (document.getElementById("modelPopup"));
  const modelSearch = /** @type {HTMLInputElement} */ (document.getElementById("modelSearch"));
  const modelList = /** @type {HTMLElement} */ (document.getElementById("modelList"));
  const modeBtns = /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll(".modeBtn"));
  const gearBtn = /** @type {HTMLButtonElement} */ (document.getElementById("gearBtn"));
  const addModelBtn = /** @type {HTMLButtonElement} */ (document.getElementById("addModelBtn"));
  const settingsPanel = /** @type {HTMLElement} */ (document.getElementById("settingsPanel"));
  const providerList = /** @type {HTMLElement} */ (document.getElementById("providerList"));
  const addProviderForm = /** @type {HTMLFormElement} */ (document.getElementById("addProviderForm"));
  const cfgKind = /** @type {HTMLSelectElement} */ (document.getElementById("cfgKind"));
  const cfgLabel = /** @type {HTMLInputElement} */ (document.getElementById("cfgLabel"));
  const cfgBaseUrl = /** @type {HTMLInputElement} */ (document.getElementById("cfgBaseUrl"));
  const cfgModel = /** @type {HTMLInputElement} */ (document.getElementById("cfgModel"));
  const cfgApiKey = /** @type {HTMLInputElement} */ (document.getElementById("cfgApiKey"));
  const cfgApiKeyField = /** @type {HTMLElement} */ (document.getElementById("cfgApiKeyField"));
  const newChatBtn = /** @type {HTMLButtonElement} */ (document.getElementById("newChatBtn"));
  const historyBtn = /** @type {HTMLButtonElement} */ (document.getElementById("historyBtn"));
  const historyPanel = /** @type {HTMLElement} */ (document.getElementById("historyPanel"));
  const sessionList = /** @type {HTMLElement} */ (document.getElementById("sessionList"));

  let mode = "plan";

  let streamingEl = null;
  let streamingText = "";
  let busy = false;

  const ROLE_LABELS = {
    user: "You",
    assistant: "xpreiIDE",
    error: "Error",
    "agent-thought": "Thinking",
    "agent-tool": "Tool call",
    "agent-obs": "Result",
  };

  // Returns the message *body* element — callers (streaming deltas) append
  // text there, not to the outer row, so the role label stays put. `rich`
  // parses fenced code blocks into blocks with Copy/Insert/Apply actions
  // (Copilot/Claude-chat style); plain text otherwise.
  function addMessage(role, text, rich) {
    const el = document.createElement("div");
    el.className = "msg " + role;
    const label = ROLE_LABELS[role];
    if (label) {
      const labelEl = document.createElement("div");
      labelEl.className = "msgRole";
      labelEl.textContent = label;
      el.appendChild(labelEl);
    }
    const body = document.createElement("div");
    body.className = "msgBody";
    if (rich) renderRich(body, text);
    else body.textContent = text;
    el.appendChild(body);
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return body;
  }

  const CODE_BLOCK_RE = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;

  // Splits `text` on fenced code blocks, rendering each as a widget with
  // Copy/Insert/Apply actions and everything else as plain text.
  function renderRich(body, text) {
    body.textContent = "";
    let lastIndex = 0;
    let match;
    let any = false;
    CODE_BLOCK_RE.lastIndex = 0;
    while ((match = CODE_BLOCK_RE.exec(text))) {
      any = true;
      if (match.index > lastIndex) {
        body.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      body.appendChild(buildCodeBlock(match[1], match[2].replace(/\n$/, "")));
      lastIndex = CODE_BLOCK_RE.lastIndex;
    }
    if (!any) {
      body.textContent = text;
      return;
    }
    if (lastIndex < text.length) {
      body.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function buildCodeBlock(lang, code) {
    const wrap = document.createElement("div");
    wrap.className = "codeBlock";

    const header = document.createElement("div");
    header.className = "codeBlockHeader";
    const langEl = document.createElement("span");
    langEl.className = "codeBlockLang";
    langEl.textContent = lang || "code";
    header.appendChild(langEl);

    const actions = document.createElement("div");
    actions.className = "codeBlockActions";
    const mk = (label, action) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "codeBlockBtn";
      b.textContent = label;
      b.addEventListener("click", () => vscode.postMessage({ type: action, text: code }));
      return b;
    };
    actions.appendChild(mk("Copy", "copyToClipboard"));
    actions.appendChild(mk("Insert", "insertAtCursor"));
    actions.appendChild(mk("Apply", "applyEdit"));
    header.appendChild(actions);
    wrap.appendChild(header);

    const pre = document.createElement("pre");
    const codeEl = document.createElement("code");
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    wrap.appendChild(pre);

    return wrap;
  }

  function setBusy(value) {
    busy = value;
    sendBtn.disabled = value;
    stopBtn.disabled = !value;
  }

  let lastPointer = "";
  /** @type {{providerId:string, providerLabel:string, model:string, active?:boolean}[]} */
  let modelItems = [];
  let highlightIndex = -1; // index into the currently-rendered .modelOption nodes

  // Update the composer trigger button to reflect the active model.
  function refreshTriggerLabel() {
    const active = modelItems.find((i) => i.providerId + "::" + i.model === lastPointer);
    if (active) {
      modelTriggerLabel.textContent = active.model;
      modelTrigger.title = active.providerLabel + " / " + active.model;
    } else if (modelItems.length === 0) {
      modelTriggerLabel.textContent = "No models";
      modelTrigger.title = "Add a provider (＋)";
    } else {
      modelTriggerLabel.textContent = "Select model";
      modelTrigger.title = "Select model";
    }
  }

  function renderModels(items) {
    modelItems = items || [];
    if (!lastPointer) {
      const active = modelItems.find((i) => i.active);
      if (active) lastPointer = active.providerId + "::" + active.model;
    }
    refreshTriggerLabel();
    if (isPopupOpen()) renderModelList(modelSearch.value);
  }

  // Build the filtered, grouped option list inside the popup.
  function renderModelList(filter) {
    modelList.innerHTML = "";
    highlightIndex = -1;
    const q = (filter || "").trim().toLowerCase();
    if (modelItems.length === 0) {
      const empty = document.createElement("div");
      empty.className = "modelEmpty";
      empty.textContent = "No models — add a provider (＋)";
      modelList.appendChild(empty);
      return;
    }
    let lastGroup = "";
    let shown = 0;
    for (const item of modelItems) {
      const pointer = item.providerId + "::" + item.model;
      if (q && !item.model.toLowerCase().includes(q) && !item.providerLabel.toLowerCase().includes(q)) {
        continue;
      }
      if (item.providerLabel !== lastGroup) {
        lastGroup = item.providerLabel;
        const header = document.createElement("div");
        header.className = "modelGroupHeader";
        header.textContent = item.providerLabel;
        modelList.appendChild(header);
      }
      const opt = document.createElement("div");
      opt.className = "modelOption";
      opt.setAttribute("role", "option");
      opt.dataset.pointer = pointer;
      if (pointer === lastPointer) {
        opt.classList.add("selected");
        opt.setAttribute("aria-selected", "true");
      }
      const check = document.createElement("span");
      check.className = "modelCheck";
      check.textContent = pointer === lastPointer ? "✓" : "";
      const name = document.createElement("span");
      name.className = "modelName";
      name.textContent = item.model;
      opt.appendChild(check);
      opt.appendChild(name);
      opt.addEventListener("click", () => selectModel(pointer));
      opt.addEventListener("mousemove", () => setHighlight(indexOfOption(opt)));
      modelList.appendChild(opt);
      shown++;
    }
    if (shown === 0) {
      const none = document.createElement("div");
      none.className = "modelEmpty";
      none.textContent = "No matches";
      modelList.appendChild(none);
    }
  }

  function optionNodes() {
    return /** @type {HTMLElement[]} */ ([...modelList.querySelectorAll(".modelOption")]);
  }
  function indexOfOption(node) {
    return optionNodes().indexOf(node);
  }
  function setHighlight(i) {
    const nodes = optionNodes();
    highlightIndex = i;
    nodes.forEach((n, idx) => n.classList.toggle("highlighted", idx === i));
    if (i >= 0 && nodes[i]) nodes[i].scrollIntoView({ block: "nearest" });
  }
  function moveHighlight(delta) {
    const nodes = optionNodes();
    if (nodes.length === 0) return;
    let i = highlightIndex + delta;
    if (i < 0) i = nodes.length - 1;
    if (i >= nodes.length) i = 0;
    setHighlight(i);
  }

  function selectModel(pointer) {
    if (!pointer) return;
    lastPointer = pointer;
    refreshTriggerLabel();
    closePopup();
    vscode.postMessage({ type: "selectModel", pointer });
  }

  function isPopupOpen() {
    return !modelPopup.classList.contains("hidden");
  }
  function openPopup() {
    if (modelItems.length === 0) {
      openSettingsPanel();
      return;
    }
    modelPopup.classList.remove("hidden");
    modelTrigger.setAttribute("aria-expanded", "true");
    modelSearch.value = "";
    renderModelList("");
    // Highlight the currently-selected option so keyboard nav starts there.
    const nodes = optionNodes();
    const sel = nodes.findIndex((n) => n.dataset.pointer === lastPointer);
    setHighlight(sel >= 0 ? sel : (nodes.length ? 0 : -1));
    modelSearch.focus();
  }
  function closePopup() {
    modelPopup.classList.add("hidden");
    modelTrigger.setAttribute("aria-expanded", "false");
  }
  function togglePopup() {
    isPopupOpen() ? closePopup() : openPopup();
  }

  modelTrigger.addEventListener("click", togglePopup);
  modelSearch.addEventListener("input", () => renderModelList(modelSearch.value));
  modelSearch.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveHighlight(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveHighlight(-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const nodes = optionNodes();
      if (highlightIndex >= 0 && nodes[highlightIndex]) selectModel(nodes[highlightIndex].dataset.pointer || "");
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePopup();
      modelTrigger.focus();
    }
  });
  // Close when focus/click leaves the picker.
  document.addEventListener("click", (e) => {
    if (isPopupOpen() && !modelPicker.contains(/** @type {Node} */ (e.target))) closePopup();
  });

  function openSettingsPanel() {
    historyPanel.classList.add("hidden");
    settingsPanel.classList.remove("hidden");
    vscode.postMessage({ type: "getProviders" });
  }

  function openHistoryPanel() {
    settingsPanel.classList.add("hidden");
    historyPanel.classList.remove("hidden");
  }

  addModelBtn.addEventListener("click", openSettingsPanel);

  newChatBtn.addEventListener("click", () => {
    if (busy) return;
    vscode.postMessage({ type: "newChat" });
  });

  historyBtn.addEventListener("click", () => {
    const opening = historyPanel.classList.contains("hidden");
    if (opening) openHistoryPanel();
    else historyPanel.classList.add("hidden");
  });

  function renderSessions(items) {
    sessionList.innerHTML = "";
    for (const s of items) {
      const row = document.createElement("div");
      row.className = "sessionRow" + (s.active ? " active" : "");
      const label = document.createElement("span");
      label.textContent = s.title;
      row.appendChild(label);
      row.addEventListener("click", () => {
        if (busy || s.active) return;
        vscode.postMessage({ type: "switchSession", id: s.id });
        historyPanel.classList.add("hidden");
      });
      sessionList.appendChild(row);
    }
  }

  modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      mode = btn.dataset.mode || "plan";
      modeBtns.forEach((b) => b.classList.toggle("active", b === btn));
    });
  });

  // Composer text-macros for the same quick-action prompts as the right-click
  // menu (/fix, /tests, ...) — expanded client-side before send, no round trip.
  const SLASH_COMMANDS = {
    "/explain": "Explain this code.",
    "/fix": "Find and fix the bug(s) in this code. Show the corrected code and explain the fix.",
    "/tests": "Write unit tests for this code, covering the main cases and edge cases.",
    "/comments": "Add clear, concise comments to this code explaining non-obvious parts. Show the commented version.",
    "/refactor": "Refactor this code for clarity and maintainability, without changing its behavior. Show the refactored version and explain the changes.",
  };

  function expandSlashCommand(raw) {
    const m = raw.match(/^\s*(\/[a-zA-Z]+)\s*([\s\S]*)$/);
    if (!m) return raw;
    const template = SLASH_COMMANDS[m[1].toLowerCase()];
    if (!template) return raw;
    return m[2].trim() ? template + "\n\n" + m[2].trim() : template;
  }

  function submit() {
    if (busy) return;
    const text = expandSlashCommand(input.value.trim());
    if (!text) return;
    const body = addMessage("user", text);
    addTurnActions(body, "user");
    input.value = "";
    setBusy(true);
    vscode.postMessage({ type: "send", text, mode });
  }

  // "Edit & resend" (user turns) / "Regenerate" (assistant turns) — only
  // meaningful on the latest Plan-mode exchange, since extension-side history
  // only tracks Plan turns (agent runs live in the DOM only).
  function isLastOfKind(row, selector) {
    const all = messagesEl.querySelectorAll(selector);
    return all.length > 0 && all[all.length - 1] === row;
  }

  function addTurnActions(body, role) {
    const row = body.closest(".msg");
    if (!row) return;
    const bar = document.createElement("div");
    bar.className = "turnActions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "turnActionBtn";
    if (role === "user") {
      btn.textContent = "Edit & resend";
      btn.addEventListener("click", () => editAndResend(row, body.textContent || ""));
    } else {
      btn.textContent = "Regenerate";
      btn.addEventListener("click", () => regenerate(row));
    }
    bar.appendChild(btn);
    row.appendChild(bar);
  }

  function editAndResend(row, text) {
    if (busy || !isLastOfKind(row, ".msg.user")) return;
    let node = row;
    while (node) {
      const next = node.nextSibling;
      node.remove();
      node = next;
    }
    input.value = text;
    input.focus();
    vscode.postMessage({ type: "editLastUser" });
  }

  function regenerate(row) {
    if (busy || !isLastOfKind(row, ".msg.assistant")) return;
    row.remove();
    setBusy(true);
    vscode.postMessage({ type: "regenerate" });
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  gearBtn.addEventListener("click", () => {
    const opening = settingsPanel.classList.contains("hidden");
    if (opening) openSettingsPanel();
    else settingsPanel.classList.add("hidden");
  });

  cfgKind.addEventListener("change", () => {
    cfgApiKeyField.classList.toggle("hidden", cfgKind.value === "ollama");
  });

  function renderProviders(items) {
    providerList.innerHTML = "";
    for (const cfg of items) {
      const row = document.createElement("div");
      row.className = "providerRow";
      const info = document.createElement("span");
      info.textContent = cfg.label + " (" + cfg.kind + ") — " + cfg.baseUrl;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "removeProvider", id: cfg.id });
      });
      row.appendChild(info);
      row.appendChild(removeBtn);
      providerList.appendChild(row);
    }
  }

  addProviderForm.addEventListener("submit", (e) => {
    e.preventDefault();
    vscode.postMessage({
      type: "saveProvider",
      cfg: {
        kind: cfgKind.value,
        label: cfgLabel.value.trim(),
        baseUrl: cfgBaseUrl.value.trim(),
        model: cfgModel.value.trim(),
      },
      apiKey: cfgApiKey.value,
    });
    cfgLabel.value = "";
    cfgBaseUrl.value = "";
    cfgModel.value = "";
    cfgApiKey.value = "";
  });

  stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  resetBtn.addEventListener("click", () => {
    messagesEl.innerHTML = "";
    vscode.postMessage({ type: "reset" });
  });

  vscode.onMessage((msg) => {
    switch (msg.type) {
      case "restore": {
        const restored = addMessage(msg.role, msg.text, msg.role === "assistant");
        if (msg.role === "user" || msg.role === "assistant") addTurnActions(restored, msg.role);
        break;
      }
      case "info":
        addMessage("info", msg.text);
        break;
      case "start":
        streamingText = "";
        streamingEl = addMessage("assistant", "");
        break;
      case "delta":
        if (streamingEl) {
          streamingText += msg.text;
          streamingEl.textContent += msg.text;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        break;
      case "done":
        if (streamingEl) {
          renderRich(streamingEl, streamingText);
          addTurnActions(streamingEl, "assistant");
        }
        streamingEl = null;
        setBusy(false);
        break;
      case "error":
        addMessage("error", msg.text);
        streamingEl = null;
        setBusy(false);
        break;
      case "agent":
        handleAgent(msg);
        break;
      case "models":
        renderModels(msg.items);
        break;
      case "providers":
        renderProviders(msg.items);
        break;
      case "sessions":
        renderSessions(msg.items);
        break;
      case "clearTranscript":
        messagesEl.innerHTML = "";
        streamingEl = null;
        streamingText = "";
        break;
      case "seed":
        mode = "plan";
        modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === "plan"));
        input.value = msg.text;
        submit();
        break;
    }
  });

  // Render one agent-loop event as a labeled transcript entry.
  function handleAgent(msg) {
    switch (msg.kind) {
      case "start":
        addMessage("agent-step", "Agent started.");
        break;
      case "step":
        addMessage("agent-step", "Step " + msg.n);
        break;
      case "thought":
        addMessage("agent-thought", msg.text);
        break;
      case "tool":
        addMessage("agent-tool", "› " + msg.name + ": " + msg.text);
        break;
      case "observation":
        addMessage("agent-obs", msg.text);
        break;
      case "protocolError":
        addMessage(
          "agent-warning",
          "⚠ Model reply wasn't valid — retrying (" + msg.attempt + "/" + msg.maxAttempts + ")…",
        );
        break;
      case "approval":
        addApprovalCard(msg.tool, msg.text, msg.before, msg.after);
        break;
      case "final":
        addMessage("assistant", msg.text, true);
        break;
      case "error":
        addMessage("error", msg.text);
        break;
      case "end":
        setBusy(false);
        break;
    }
  }

  // Inline approval prompt for a mutating tool call — Copilot/Claude-chat
  // style (in the transcript), not a native blocking modal.
  function addApprovalCard(tool, detail, before, after) {
    const el = document.createElement("div");
    el.className = "msg agent-approval";

    const label = document.createElement("div");
    label.className = "msgRole";
    label.textContent = "Approval needed";
    el.appendChild(label);

    const body = document.createElement("div");
    body.className = "msgBody";
    body.textContent = tool + ": " + detail;
    el.appendChild(body);

    if (before) {
      const pre = document.createElement("pre");
      pre.className = "diffPreview diffBefore";
      pre.textContent = before;
      el.appendChild(pre);
    }
    if (after) {
      const pre = document.createElement("pre");
      pre.className = "diffPreview diffAfter";
      pre.textContent = after;
      el.appendChild(pre);
    }

    const actions = document.createElement("div");
    actions.className = "approvalActions";
    const respond = (choice, statusText) => {
      actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
      const status = document.createElement("div");
      status.className = "approvalStatus";
      status.textContent = statusText;
      el.appendChild(status);
      vscode.postMessage({ type: "approvalResponse", choice });
    };
    const approveBtn = document.createElement("button");
    approveBtn.type = "button";
    approveBtn.className = "primary";
    approveBtn.textContent = "Approve";
    approveBtn.addEventListener("click", () => respond("approve", "Approved."));

    const approveAllBtn = document.createElement("button");
    approveAllBtn.type = "button";
    approveAllBtn.textContent = "Approve all";
    approveAllBtn.addEventListener("click", () =>
      respond("approve-all", "Approved (auto-approving the rest of this run)."),
    );

    const rejectBtn = document.createElement("button");
    rejectBtn.type = "button";
    rejectBtn.className = "ghostBtn";
    rejectBtn.textContent = "Reject";
    rejectBtn.addEventListener("click", () => respond("reject", "Rejected."));

    actions.appendChild(approveBtn);
    actions.appendChild(approveAllBtn);
    actions.appendChild(rejectBtn);
    el.appendChild(actions);

    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Ask the extension to replay history — covers reload after the panel was
  // hidden or the dev host restarted.
  vscode.postMessage({ type: "ready" });
})();
